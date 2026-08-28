import { getDb } from './open';
import { STORES } from './schema';
import type { Changeset } from '../../types';

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

/**
 * Persists a changeset — a create or an update, since `Changeset.id` is
 * minted once by `buildChangeset` and never reused, so `put` is always an
 * upsert of the SAME record rather than a risk of colliding with another
 * one. Callers write through this on every decision (accept/reword/decline)
 * as well as on first build, per CLAUDE.md's "await-then-apply" rule: the
 * UI must not believe a decision was recorded until the store confirms it.
 *
 * Mirrors `playbookVersions.ts`'s shape: an explicit readwrite transaction
 * with nothing non-IDB awaited inside it, `tx.done` awaited before
 * returning, and a generic storage-full message on any failure — the same
 * idiom every store in this module uses, rather than a second one invented
 * here. There is no sequence number to allocate (a `Changeset` has no
 * monotonic ordering the way a `PlaybookVersion` does — `createdAt` plus its
 * own minted `id` is enough), so this is `publishVersion`'s shape minus the
 * allocation step it exists for.
 */
export async function saveChangeset(changeset: Changeset): Promise<Changeset> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORES.changesets, 'readwrite');
    await tx.store.put(changeset);
    await tx.done;
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
  return changeset;
}

export async function getChangeset(id: string): Promise<Changeset | null> {
  const db = await getDb();
  return (await db.get(STORES.changesets, id)) ?? null;
}

/** A playbook's changesets, most recently created first. */
export async function listChangesets(playbookId: string): Promise<Changeset[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORES.changesets, 'byPlaybook', playbookId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
