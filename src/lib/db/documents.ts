import { getDb } from './open';
import { STORES } from './schema';
import type { DocumentRecord } from '../../types';

const ROLES: DocumentRecord['role'][] = ['base', 'varies', 'standalone'];

/**
 * Upgrades a persisted `DocumentRecord` to the current schema on read. A
 * document written before sub-project C predates `role` entirely; it reads
 * back as `'standalone'` — the same default a document that has never
 * belonged to a collection gets today — never as `'base'`, which would
 * silently promote an ordinary document into a collection's base. A
 * document that already carries a recognised role keeps it untouched.
 *
 * Applied at every read site (`listDocuments`, `getDocument`) so a document
 * upgrades exactly once, in one place, no matter which screen asked for it
 * — the same funnel discipline `reviewMigration.ts`'s `migrateReviewRecord`
 * follows for reviews.
 */
export function migrateDocumentRecord(raw: unknown): DocumentRecord {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<DocumentRecord> & Record<string, unknown>;
  const role: DocumentRecord['role'] = ROLES.includes(src.role as DocumentRecord['role'])
    ? (src.role as DocumentRecord['role'])
    : 'standalone';
  return { ...(src as DocumentRecord), role };
}

/** All documents belonging to a matter, oldest-added first. Deterministic
 *  regardless of what order the underlying `byMatter` index happens to
 *  return same-key entries in (IndexedDB does not guarantee one for a
 *  non-unique index) — mirrors why `matters.ts`/`playbooks.ts` sort
 *  explicitly rather than trusting store iteration order.
 *
 *  Rejects (rather than resolving to `[]`) on a genuine database failure —
 *  see the Task 4 critical this guards against: a caller must be able to
 *  tell "no documents yet" apart from "the database failed". Nothing here
 *  catches errors from `getDb()`/`getAllFromIndex`, so they propagate as-is. */
export async function listDocuments(matterId: string): Promise<DocumentRecord[]> {
  const db = await getDb();
  const docs = await db.getAllFromIndex(STORES.documents, 'byMatter', matterId);
  return docs.slice().sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id)).map(migrateDocumentRecord);
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const db = await getDb();
  const found = await db.get(STORES.documents, id);
  return found ? migrateDocumentRecord(found) : null;
}

/** Writes the document's metadata record and its original file bytes in one
 *  readwrite transaction spanning both stores, so the two can never observe
 *  a torn write: either both land, or (on any failure) neither does. A
 *  record with no blob renders as permanently unavailable to the user, so
 *  this is the one guarantee this module cannot get wrong.
 *
 *  Both `put` calls are issued and handed straight to `Promise.all` with
 *  nothing else awaited in between — the only thing this function awaits
 *  before `tx.done` is the pair of IDB requests themselves. Awaiting
 *  anything else (a microtask from other work, a second `await` in
 *  sequence with a non-IDB step between) is what lets IndexedDB
 *  auto-commit the transaction early and is exactly the trap this
 *  docstring exists to warn the next editor away from. */
export async function addDocument(rec: DocumentRecord, bytes: Blob): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORES.documents, STORES.blobs], 'readwrite');
  const documentsStore = tx.objectStore(STORES.documents);
  const blobsStore = tx.objectStore(STORES.blobs);
  await Promise.all([
    documentsStore.put(rec),
    blobsStore.put({ documentId: rec.id, bytes, mime: bytes.type || 'application/octet-stream' }),
  ]);
  await tx.done;
}

/** Removes a document's metadata record and its blob together, in one
 *  transaction, for the same reason `addDocument` writes them together: an
 *  orphaned blob is invisible to the UI (nothing references it once its
 *  record is gone), so nobody would discover the leak until storage fills.
 *  Consistent with how `deleteMatter`'s cascade resolves a document's blob
 *  by the document's own id — `blobs` is keyed by `documentId`, which is
 *  the same value as the document's `id`. */
export async function deleteDocument(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORES.documents, STORES.blobs], 'readwrite');
  await Promise.all([
    tx.objectStore(STORES.documents).delete(id),
    tx.objectStore(STORES.blobs).delete(id),
  ]);
  await tx.done;
}
