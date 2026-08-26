import { getDb } from './open';
import { STORES } from './schema';

/** Reads a document's original file bytes.
 *
 *  Returns `null` — never throws — when no blob is on record for `id`.
 *  A missing blob is not an exceptional condition: a partial failure during
 *  `addDocument`, or a user manually clearing browser storage, can leave a
 *  `DocumentRecord` behind with nothing in `blobs` for it. The caller (the
 *  UI) must still be able to show that document's metadata with an
 *  "unavailable" state rather than the whole view blowing up (spec §9). A
 *  genuine database failure (e.g. the connection itself rejecting) still
 *  propagates as a rejection — only "not found" is folded into `null`. */
export async function getDocumentBlob(id: string): Promise<Blob | null> {
  const db = await getDb();
  const found = await db.get(STORES.blobs, id);
  return found ? found.bytes : null;
}
