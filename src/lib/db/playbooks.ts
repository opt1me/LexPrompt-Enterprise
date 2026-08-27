import { getDb } from './open';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import { TEMPLATE_SCHEMA_VERSION, type PlaybookClause, type Playbook, type StandardPosition, type PositionOrigin } from '../../types';
import { uid } from '../uid';

/** A playbook record as it actually sits in IndexedDB: the public
 *  `Playbook` shape plus a write sequence number. `_seq` exists to break
 *  ties when two saves land in the same millisecond (`Date.now()`
 *  resolution) — v1's localStorage array got the same determinism for free
 *  from array position; IndexedDB's `getAll()` has no equivalent notion of
 *  insertion order, so an explicit, persisted counter plays that role
 *  instead. `_seq` never appears on a `Playbook` returned to callers. */
interface StoredPlaybook extends Playbook {
  _seq: number;
}

/** Brings a playbook of any earlier (or malformed) shape up to the current
 *  one. Anything missing gets a sane default rather than causing the
 *  playbook to be dropped — mirrors v1's storage.ts `migrate()`, which took
 *  three fix rounds to get right: a record that cannot be fully read is
 *  repaired, never discarded. */
function migrate(input: unknown): Playbook {
  const t = (input ?? {}) as Partial<Playbook> & Record<string, unknown>;
  const now = Date.now();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    name: typeof t.name === 'string' ? t.name : 'Untitled playbook',
    contractType: typeof t.contractType === 'string' ? t.contractType : 'Custom',
    mode: t.mode === 'risk' ? 'risk' : 'extraction',
    systemPrompt: typeof t.systemPrompt === 'string' ? t.systemPrompt : '',
    formatPrompt: typeof t.formatPrompt === 'string' ? t.formatPrompt : '',
    riskTolerance: typeof t.riskTolerance === 'string' ? t.riskTolerance : undefined,
    clauses: Array.isArray(t.clauses) ? t.clauses.map(migrateClause) : [],
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

function migrateClause(input: unknown): PlaybookClause {
  const c = (input ?? {}) as Partial<PlaybookClause> & { prompt?: unknown };
  // Both names are read on migration; only the new one is written (spec §5).
  // A pre-D record has `prompt`; anything already migrated has
  // `extractPrompt`. Reading both is what makes this idempotent.
  const extractPrompt =
    typeof c.extractPrompt === 'string' ? c.extractPrompt :
    typeof c.prompt === 'string' ? c.prompt : '';
  const standardPosition = migratePosition(c.standardPosition);
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    title: typeof c.title === 'string' ? c.title : 'Untitled clause',
    extractPrompt,
    riskCriteria: typeof c.riskCriteria === 'string' ? c.riskCriteria : undefined,
    // Key omitted entirely when absent, not set to `undefined` — an
    // `undefined`-valued key survives structuredClone (how IndexedDB writes
    // every record), so a plain assignment here would let a dropped
    // position's key linger on the stored clause.
    ...(standardPosition ? { standardPosition } : {}),
  };
}

/** A position that cannot be read is dropped rather than repaired to an
 *  empty one: an empty-text position would render as "we ask for: (nothing)"
 *  and would make a clause claim a house rule it does not have. Absent is
 *  the honest answer, and it is the same answer a clause that never had a
 *  position gives. */
function migratePosition(input: unknown): StandardPosition | undefined {
  const p = (input ?? {}) as Partial<StandardPosition>;
  if (typeof p.text !== 'string' || p.text.trim() === '') return undefined;
  const origin: PositionOrigin =
    p.origin === 'ai-drafted' || p.origin === 'learned' ? p.origin : 'authored';
  return {
    text: p.text,
    origin,
    // Unreadable provenance defaults to NOT reviewed. Same reasoning as
    // `readStatus` in sub-project B: the safe default is the one that
    // prompts a human to look.
    reviewedByHuman: p.reviewedByHuman === true,
    provenance: typeof p.provenance === 'string' ? p.provenance : undefined,
  };
}

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

export function newPlaybook(name: string): Playbook {
  const now = Date.now();
  return {
    id: uid(),
    name,
    contractType: 'Custom',
    mode: 'extraction',
    systemPrompt: 'You are an expert legal contract reviewer.',
    formatPrompt: 'Answer strictly from the document text. Quote verbatim.',
    clauses: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

export async function listPlaybooks(): Promise<Playbook[]> {
  const db = await getDb();
  // getAll() never throws on a per-record shape problem — only migrate()
  // below has to deal with that, on read, without ever writing back (so a
  // record we can't fully make sense of is repaired for display but left
  // exactly as found in the store).
  const raw = (await db.getAll(STORES.playbooks)) as StoredPlaybook[];
  const entries = raw.map(r => ({ playbook: migrate(r), seq: seqOf(r) }));
  // Sort by updatedAt descending; tiebreak on write sequence descending so
  // the record saved most recently wins a same-millisecond collision.
  entries.sort((a, b) => {
    const diff = b.playbook.updatedAt - a.playbook.updatedAt;
    return diff !== 0 ? diff : b.seq - a.seq;
  });
  return entries.map(e => e.playbook);
}

export async function getPlaybook(id: string): Promise<Playbook | null> {
  const db = await getDb();
  const raw = await db.get(STORES.playbooks, id);
  return raw ? migrate(raw) : null;
}

export async function savePlaybook(playbook: Playbook): Promise<Playbook> {
  const db = await getDb();
  const saved: Playbook = { ...playbook, updatedAt: Date.now(), schemaVersion: TEMPLATE_SCHEMA_VERSION };
  try {
    // The read (current max _seq) and the write share ONE readwrite
    // transaction, so two concurrent savePlaybook calls can never both read
    // the same max before either has written theirs — the race that would
    // let a rapid batch import mis-order a same-millisecond tie. Nothing
    // non-IDB is awaited between the getAll and the put, which is what
    // keeps IndexedDB from auto-committing the transaction early.
    const tx = db.transaction(STORES.playbooks, 'readwrite');
    const seq = await nextSeq(tx.store);
    const record: StoredPlaybook = { ...saved, _seq: seq };
    await tx.store.put(record);
    await tx.done;
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
  return saved;
}

export async function deletePlaybook(id: string): Promise<void> {
  const db = await getDb();
  try {
    await db.delete(STORES.playbooks, id);
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

export function exportPlaybook(playbook: Playbook): Blob {
  return new Blob([JSON.stringify(playbook, null, 2)], { type: 'application/json' });
}

export async function importPlaybook(json: string): Promise<Playbook> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { clauses?: unknown }).clauses)) {
    throw new Error('That file is not a template — it has no clauses.');
  }
  const migrated = migrate(parsed);
  // Fresh id so importing a playbook you already have does not overwrite it.
  return savePlaybook({ ...migrated, id: uid() });
}
