import { apiGetBlob } from '../api/client';

/** Reads a document's original file bytes, from Blob Storage by way of
 *  `apps/api`.
 *
 *  Returns `null` — never throws — when no bytes are on record for `id`.
 *  A missing blob is not an exceptional condition: a partial failure during
 *  `addDocument` (the route writes the blob and then the row, and a failure
 *  between them leaves the reverse — see its own note), or a manual purge,
 *  can leave a `DocumentRecord` behind with nothing in storage for it. The
 *  caller (the UI) must still be able to show that document's metadata with
 *  an "unavailable" state rather than the whole view blowing up (spec §9).
 *
 *  A GENUINE failure still propagates — a 401, a 403, a 500, an unreachable
 *  server. Only "not found" is folded into `null`, and the route is careful
 *  to answer 404 for exactly two things (no such document, and a document
 *  whose bytes are not in storage) and never for a store that is merely
 *  refusing us. Widening this to "any failure means unavailable" would put
 *  "this document's file cannot be opened" in front of a reader whose
 *  session had simply expired. */
export async function getDocumentBlob(id: string): Promise<Blob | null> {
  return apiGetBlob(`/v1/documents/${encodeURIComponent(id)}/bytes`);
}
