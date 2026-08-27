import { getDb } from './open';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import { migrateDraft, migratePlaybookRecord, migrateVersionRecord } from './playbookMigration';
import { getVersion, publishVersion } from './playbookVersions';
import { SCHEMA_VERSION, type Playbook, type PlaybookDraft, type PlaybookVersion } from '../../types';
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

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

const DEFAULT_SYSTEM_PROMPT = 'You are an expert legal contract reviewer.';
const DEFAULT_FORMAT_PROMPT = 'Answer strictly from the document text. Quote verbatim.';

/** A new playbook's IDENTITY. Its content is a separate `PlaybookDraft`
 *  (see `newPlaybookDraft`) that becomes v1 on the first publish — the two
 *  are minted separately because a playbook can exist with no published
 *  content at all, and `Playbook` no longer has anywhere to put clauses. */
export function newPlaybook(name: string): Playbook {
  const now = Date.now();
  return {
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
}

/** The starting content for a new playbook. */
export function newPlaybookDraft(name: string): PlaybookDraft {
  return {
    name,
    contractType: 'Custom',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    formatPrompt: DEFAULT_FORMAT_PROMPT,
    clauses: [],
    changeSummary: '',
  };
}

/** The editable copy of a published version.
 *
 *  `changeSummary` is deliberately NOT carried over: it describes what the
 *  version being copied changed, and reusing it would label the next
 *  version with the previous one's reason. */
export function draftFromVersion(version: PlaybookVersion): PlaybookDraft {
  const draft: PlaybookDraft = {
    name: version.name,
    contractType: version.contractType,
    systemPrompt: version.systemPrompt,
    formatPrompt: version.formatPrompt,
    clauses: structuredClone(version.clauses),
    changeSummary: '',
  };
  if (version.riskTolerance !== undefined) draft.riskTolerance = version.riskTolerance;
  return draft;
}

/**
 * PURE READ (R-D7). Repairs each record on the way out and writes nothing —
 * not even the pre-D → versioned conversion, which belongs to
 * `migrateIfNeeded`'s one-time, flag-guarded startup step. Two components
 * calling this on the same tick must be incapable of publishing two
 * identical v1s between them.
 */
export async function listPlaybooks(): Promise<Playbook[]> {
  const db = await getDb();
  // getAll() never throws on a per-record shape problem — only
  // migratePlaybookRecord below has to deal with that, on read, without
  // ever writing back (so a record we can't fully make sense of is repaired
  // for display but left exactly as found in the store).
  const raw = (await db.getAll(STORES.playbooks)) as StoredPlaybook[];
  const entries = raw.map(r => ({ playbook: migratePlaybookRecord(r).playbook, seq: seqOf(r) }));
  // Sort by updatedAt descending; tiebreak on write sequence descending so
  // the record saved most recently wins a same-millisecond collision.
  entries.sort((a, b) => {
    const diff = b.playbook.updatedAt - a.playbook.updatedAt;
    return diff !== 0 ? diff : b.seq - a.seq;
  });
  return entries.map(e => e.playbook);
}

/** PURE READ — see `listPlaybooks`. */
export async function getPlaybook(id: string): Promise<Playbook | null> {
  const db = await getDb();
  const raw = await db.get(STORES.playbooks, id);
  return raw ? migratePlaybookRecord(raw).playbook : null;
}

/**
 * The playbook's current published content, or `null` when it has never
 * been published (or its pointer names a version that is no longer there).
 *
 * `null` is deliberately distinguishable from an empty version: a caller
 * about to run a review has to be able to tell "this playbook has no
 * published content" from "its content is a playbook with no clauses".
 */
export async function getPlaybookContent(playbookId: string): Promise<PlaybookVersion | null> {
  const playbook = await getPlaybook(playbookId);
  if (!playbook?.currentVersionId) return null;
  const version = await getVersion(playbook.currentVersionId);
  return version ? migrateVersionRecord(version) : null;
}

/** Saves the identity record. Content goes through `publishVersion` or
 *  `saveDraft`; nothing here can change what a published version says. */
export async function savePlaybook(playbook: Playbook): Promise<Playbook> {
  const db = await getDb();
  const saved: Playbook = { ...playbook, updatedAt: Date.now(), schemaVersion: SCHEMA_VERSION };
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

/** Stores unpublished edits against the playbook's identity record.
 *
 *  Loud rather than quiet on a missing playbook: silently creating one
 *  would hide a deleted playbook behind a draft nothing can publish. */
export async function saveDraft(playbookId: string, draft: PlaybookDraft): Promise<void> {
  const playbook = await getPlaybook(playbookId);
  if (!playbook) {
    throw new Error('That playbook no longer exists, so the draft could not be saved.');
  }
  await savePlaybook({ ...playbook, draft });
}

export async function deletePlaybook(id: string): Promise<void> {
  const db = await getDb();
  try {
    await db.delete(STORES.playbooks, id);
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

/** Exports a playbook's CONTENT — the clauses and prompts are the part
 *  worth carrying to another browser. Identity (`createdAt`, the version
 *  pointer, the id) is local bookkeeping and is minted fresh on import. */
export function exportPlaybook(content: PlaybookDraft): Blob {
  return new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
}

/** Imports exported content — or a pre-D exported `Template` — as a brand
 *  new playbook with its own fresh identity and a published v1. */
export async function importPlaybook(json: string, byUserId = ''): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { clauses?: unknown }).clauses)) {
    throw new Error('That file is not a template — it has no clauses.');
  }
  const draft = migrateDraft(parsed, 'Untitled playbook');
  // Fresh id so importing a playbook you already have does not overwrite it.
  const identity = { ...newPlaybook(draft.name), id: uid() };
  const version = await publishVersion(identity.id, draft, byUserId);
  const playbook = await savePlaybook({ ...identity, currentVersionId: version.id });
  return { playbook, version };
}
