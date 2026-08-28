import { getDb } from './open';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import {
  carriesUnconvertedContent, migrateDraft, migratePlaybookRecord, migrateVersionRecord,
  UnconvertedPlaybookError,
} from './playbookMigration';
import { getVersion, publishVersionIn } from './playbookVersions';
import { SCHEMA_VERSION, type Playbook, type PlaybookDraft, type PlaybookVersion } from '../../types';
import { uid } from '../uid';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_FORMAT_PROMPT } from '../playbookDefaults';

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
  const db = await getDb();
  // The RAW record, not `getPlaybook`'s migrated one: the guard below has to
  // see the pre-D content keys, which `migratePlaybookRecord` strips.
  const raw = await db.get(STORES.playbooks, playbookId);
  if (!raw) return null;
  // M3. `null` here means "never published", and the editor answers that
  // with a blank draft. A record whose clauses were never converted would
  // get the same answer and the same blank editor, and its next Save would
  // publish an empty v1 over real content. Fail loudly instead.
  if (carriesUnconvertedContent(raw)) throw new UnconvertedPlaybookError();
  const { playbook } = migratePlaybookRecord(raw);
  if (!playbook.currentVersionId) return null;
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

/**
 * Publishes `draft` as the playbook's next version AND points the identity
 * record at it, in ONE readwrite transaction spanning both stores.
 *
 * `publishVersion` then `savePlaybook` — two transactions — is what this
 * replaces. A failure in the window between them left an orphaned version
 * and a gap in the version numbering, and for an import an orphan with no
 * identity record at all: permanently unreachable, since the only thing in
 * the app that adopts orphans is the startup conversion, and that only
 * looks at playbooks that exist. The one-time migration went to
 * considerable trouble to be atomic (R-D9) and the two everyday paths doing
 * the same pair of writes did not follow it; this is the shared form, so
 * there is one implementation rather than a third copy.
 *
 * It takes the identity as a value rather than an id so it serves both
 * callers: the editor's Save has the record in hand, and an import mints
 * one that is not in the store yet.
 *
 * PUBLISHING CONSUMES THE DRAFT. The edits are now IN the version, so a
 * surviving `Playbook.draft` would make the library read "unpublished
 * changes" forever and make `loadPlaybookForEdit` prefer the stale draft
 * over the version just published. The key is DELETED, not set to
 * `undefined`: `structuredClone` (how IndexedDB writes every record)
 * preserves an `undefined`-valued key, and `'draft' in playbook` is how
 * "has unpublished changes" gets asked.
 *
 * Nothing non-IDB is awaited inside the transaction, which is what keeps
 * IndexedDB from auto-committing it early — `publishVersionIn` and
 * `nextSeq` are both store-handle forms for exactly this reason.
 */
export async function publishAndPoint(
  playbook: Playbook,
  draft: PlaybookDraft,
  byUserId: string,
): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  const db = await getDb();
  const identity: Playbook = { ...playbook };
  delete identity.draft;
  try {
    const tx = db.transaction([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    const playbooks = tx.objectStore(STORES.playbooks);
    const versions = tx.objectStore(STORES.playbookVersions);
    const version = await publishVersionIn(versions, playbook.id, draft, byUserId);
    const seq = await nextSeq(playbooks);
    const saved: Playbook = {
      ...identity,
      // The identity mirrors the current version's name so the library can
      // list playbooks without reading a version per row.
      name: version.name,
      currentVersionId: version.id,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };
    await playbooks.put({ ...saved, _seq: seq } as StoredPlaybook);
    await tx.done;
    return { playbook: saved, version };
  } catch (error) {
    // Same rule as `publishVersion`: the change-summary rejection is a
    // caller error, and rethrowing it as "storage is full" would send the
    // user off to delete data to fix a missing text field.
    if (error instanceof Error && /change summary/i.test(error.message)) throw error;
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

/**
 * Stores unpublished edits against the playbook's identity record.
 *
 * Takes the identity as a VALUE rather than an id, exactly as
 * `publishAndPoint` does and for the same reason: a playbook created in
 * this session has no store record yet, so Save draft is its FIRST write.
 * The id-only form this replaces rejected precisely that case — the most
 * valuable draft in the app, the one that has just cost a ~30s paid AI
 * generation — with "that playbook no longer exists". Its guard was aimed
 * at a playbook deleted elsewhere, but the objection it recorded ("a draft
 * nothing can publish") no longer holds: `publishAndPoint` takes the
 * identity as a value too, so a recreated record publishes normally.
 *
 * Written only on explicit intent, never per keystroke (R-D16) — the
 * editor's Save draft control and the Keep branch of its leave prompt are
 * the only callers.
 */
export async function saveDraft(playbook: Playbook, draft: PlaybookDraft): Promise<Playbook> {
  return savePlaybook({ ...playbook, draft });
}

/**
 * Clears a playbook's stored draft — the counterpart `saveDraft` did not
 * have while nothing wrote one.
 *
 * Without it, "discard" could only forget the edits IN MEMORY: the rejected
 * draft stayed durable and `loadPlaybookForEdit` prefers a stored draft
 * over the published version, so the next open would resurrect exactly the
 * edits the user had just rejected. That is the defect Task 3's M2 fixed
 * one layer up, reopened by making drafts persistent (R-D16).
 *
 * The key is DELETED, not set to `undefined`, for the same reason
 * `publishAndPoint` deletes it: `structuredClone` — how IndexedDB writes
 * every record — preserves an `undefined`-valued key, and
 * `'draft' in playbook` is how "has unpublished changes" gets asked.
 *
 * Resolves rather than throwing when there is no such playbook, or no
 * draft on it: this runs as the user LEAVES the editor, and there is
 * nothing they could do about the news. A genuine storage failure still
 * rejects, with the same message `savePlaybook` uses for the same fault.
 *
 * Reads the RAW record, not `getPlaybook`'s migrated one (R-D7: repair-on-
 * read stays off write paths). `migratePlaybookRecord` builds a whitelist,
 * so writing its output back would delete every key it does not know about
 * — a record carrying both a draft and unconverted pre-D content would lose
 * the content to an operation the user invoked to discard something else.
 * That is "never delete what you cannot read", broken by a repair nobody
 * asked for. Deleting one key from the record as found leaves the rest
 * exactly as found.
 *
 * The read and the write share ONE readwrite transaction (`publishAndPoint`'s
 * shape), not `db.get` followed by `savePlaybook`'s own transaction. This
 * used to be the last surviving two-transaction read-then-write in the
 * module: it is fired unawaited (`void`) from a synchronous
 * `window.confirm` guard, so it genuinely overlaps other work, and a
 * `publishAndPoint` landing between the old read and the old write got
 * silently reverted — `currentVersionId` went back to the pre-publish
 * version and the just-published one became an orphan nothing enumerates.
 * Nothing non-IDB is awaited inside the transaction, for the same reason
 * `savePlaybook`/`publishAndPoint` say so: that is what keeps IndexedDB from
 * auto-committing it early and reopening the same race.
 */
export async function discardDraft(playbookId: string): Promise<void> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORES.playbooks, 'readwrite');
    const raw = (await tx.store.get(playbookId)) as StoredPlaybook | undefined;
    if (!raw || !('draft' in raw)) {
      await tx.done;
      return;
    }
    const cleared: StoredPlaybook = { ...raw };
    delete cleared.draft;
    const seq = await nextSeq(tx.store);
    const saved: StoredPlaybook = {
      ...cleared,
      _seq: seq,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };
    await tx.store.put(saved);
    await tx.done;
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

/**
 * Deletes the playbook AND every version of it, in one transaction.
 *
 * The versions used to be left behind: unreachable, since nothing
 * enumerates them except through a playbook that no longer exists, and
 * unbounded, since nothing ever collected them. This is `deleteMatter`'s
 * shape — the record plus what only it owns, atomically — rather than a
 * second convention for the same idea.
 *
 * It does not conflict with "never delete what you cannot read": that rule
 * quarantines data we cannot make sense of, and these are records we read
 * perfectly well and whose owner the user has explicitly discarded. Nor
 * does it lose a review's history — a `Review` carries its own
 * `playbookSnapshot`, which is what spec 5 means by "a review whose
 * playbook was deleted still opens on its snapshot, as it does today", and
 * why R-D4 makes `Review.playbookVersionId` optional.
 */
export async function deletePlaybook(id: string): Promise<void> {
  const db = await getDb();
  try {
    const tx = db.transaction([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    const versions = tx.objectStore(STORES.playbookVersions);
    const owned = await versions.index('byPlaybook').getAllKeys(id);
    await Promise.all([
      tx.objectStore(STORES.playbooks).delete(id),
      ...owned.map(key => versions.delete(key)),
    ]);
    await tx.done;
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
  return publishAndPoint(identity, draft, byUserId);
}
