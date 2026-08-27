import type { IDBPObjectStore, StoreNames } from 'idb';
import { getDb } from './open';
import { STORES, type LexPromptDB } from './schema';
import { SCHEMA_VERSION, type PlaybookDraft, type PlaybookVersion } from '../../types';
import { uid } from '../uid';

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

/**
 * Freezes a draft into an immutable published version.
 *
 * The read of the current max version number and the write of the new
 * record share ONE readwrite transaction — the same discipline
 * `playbooks.ts`'s `savePlaybook` uses for `_seq`, and for the same reason:
 * two concurrent publishes must not both read the same max before either
 * has written. `matters.ts` once reproduced that allocation *without* the
 * transaction scoping while claiming in its docstring to mirror it, which
 * is this project's canonical sibling-drift defect. Nothing non-IDB is
 * awaited between the index read and the put, which is what keeps
 * IndexedDB from auto-committing the transaction early.
 *
 * A version id is minted fresh on every call and never reused, so a `put`
 * can never land on an existing version — immutability is a property of how
 * ids are allocated, not a check that could be forgotten.
 */
export async function publishVersion(
  playbookId: string,
  draft: PlaybookDraft,
  byUserId: string,
): Promise<PlaybookVersion> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORES.playbookVersions, 'readwrite');
    const record = await publishVersionIn(tx.store, playbookId, draft, byUserId);
    await tx.done;
    return record;
  } catch (error) {
    // The change-summary rejection is a caller error, not a storage failure
    // — rethrowing it as "storage is full" would send the user off to delete
    // data to fix a missing text field.
    if (error instanceof Error && /change summary/i.test(error.message)) throw error;
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

/**
 * The allocation itself, against an object store handle from an ALREADY-OPEN
 * readwrite transaction — the same shape (and the same reason) as `seq.ts`'s
 * `nextSeq`.
 *
 * It exists so the startup conversion in `migrate.ts` can do its version put
 * and its identity write-back inside ONE transaction spanning both stores,
 * without a second copy of the version-number allocation. Two copies of this
 * is precisely the sibling drift that `matters.ts` reproducing
 * `playbooks.ts`'s allocation *without* its transaction scoping produced.
 *
 * The caller owns the transaction and must not await anything non-IDB
 * between calling this and its own put, or IndexedDB auto-commits early and
 * reopens the race the shared transaction exists to close.
 */
export async function publishVersionIn<TxStores extends ArrayLike<StoreNames<LexPromptDB>>>(
  store: IDBPObjectStore<LexPromptDB, TxStores, 'playbookVersions', 'readwrite'>,
  playbookId: string,
  draft: PlaybookDraft,
  byUserId: string,
): Promise<PlaybookVersion> {
  const existing = await store.index('byPlaybook').getAll(playbookId);
  const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;

  // A version history whose entries do not say what changed is a list of
  // dates (spec §4). v1 is exempt: there is no previous version for it to
  // have changed from.
  const summary = draft.changeSummary?.trim() ?? '';
  if (nextVersion > 1 && summary === '') {
    throw new Error('A change summary is required when publishing a new version.');
  }

  const record: PlaybookVersion = {
    ...draft,
    changeSummary: summary,
    id: uid(),
    playbookId,
    version: nextVersion,
    publishedAt: Date.now(),
    publishedByUserId: byUserId,
    schemaVersion: SCHEMA_VERSION,
  };
  await store.put(record);
  return record;
}

export async function getVersion(id: string): Promise<PlaybookVersion | null> {
  const db = await getDb();
  return (await db.get(STORES.playbookVersions, id)) ?? null;
}

/** Newest first. */
export async function listVersions(playbookId: string): Promise<PlaybookVersion[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORES.playbookVersions, 'byPlaybook', playbookId);
  return all.sort((a, b) => b.version - a.version);
}
