import { ModelError } from '@lexprompt/core';
import { apiDelete, apiGet, apiGetOrNull, apiSend, apiSendBlob } from '../api/client';
import type { DocumentRecord } from '../../types';

/**
 * The documents repository — an HTTP client over `apps/api` since Stage 2.
 *
 * Same file, same exports, same signatures as when this read IndexedDB
 * (R3). What moved OUT is what the browser no longer owns: the sort (now
 * `order by added_at asc, id asc` in the route), the two-store transaction
 * that wrote a record and its bytes together, and the read-modify-write
 * behind `setDocumentRole` (now an `UPDATE` naming two columns).
 *
 * The single-transaction guarantee could not move, because Postgres and
 * Blob Storage cannot share one. `apps/api/src/routes/documents.ts` explains
 * at length which way round the two writes go and why — **blob first**, so a
 * failure between them leaks bytes nobody can see rather than producing a
 * document record with no content. Read that note before changing anything
 * about the upload here; from this side the difference is invisible.
 *
 * The rule this file must not get wrong is the same one `matters.ts` states:
 * **a failure is a failure, never an empty result.** `getDocument` answers
 * `null` for a 404 and for nothing else; a 500, a 401 or an unreachable
 * server rejects, so a load path renders `describeLoadError`'s message
 * instead of "no documents yet".
 */

// This constant is deliberately NOT named "the R word" alone: `packages/core`
// now exports an unrelated closed set under that exact identifier (Stage 2's
// three workspace roles — reviewer/partner/admin), and the import-boundary
// guard (S14) flags any second definition of that name outside the package,
// export or not, precisely so two same-named "the roles" never sit in the
// codebase inviting conflation.
const DOCUMENT_ROLES: DocumentRecord['role'][] = ['base', 'varies', 'standalone'];

/**
 * Upgrades a persisted `DocumentRecord` to the current schema on read. A
 * document written before sub-project C predates `role` entirely; it reads
 * back as `'standalone'` — the same default a document that has never
 * belonged to a collection gets today — never as `'base'`, which would
 * silently promote an ordinary document into a collection's base. A
 * document that already carries a recognised role keeps it untouched.
 *
 * STILL EXPORTED, and still called on every read here. The server's
 * `document.role` column has a CHECK constraint, so nothing the API returns
 * can lack a recognised role — but this function's remaining caller is the
 * uploader, which builds a record from a file rather than from a response,
 * and a record on its way IN is exactly where a missing role would come
 * from. Task 23 decides its fate; this task does not delete it.
 */
export function migrateDocumentRecord(raw: unknown): DocumentRecord {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<DocumentRecord> & Record<string, unknown>;
  const role: DocumentRecord['role'] = DOCUMENT_ROLES.includes(src.role as DocumentRecord['role'])
    ? (src.role as DocumentRecord['role'])
    : 'standalone';
  return { ...(src as DocumentRecord), role };
}

/** All documents belonging to a matter, oldest-added first. The order is the
 *  server's (`order by added_at asc, id asc`) and is not re-derived here —
 *  two sorts that must agree is this project's most repeated defect.
 *
 *  Rejects (rather than resolving to `[]`) on any failure, exactly as it did
 *  over IndexedDB: a caller must be able to tell "no documents yet" apart
 *  from "the server failed". */
export async function listDocuments(matterId: string): Promise<DocumentRecord[]> {
  const docs = await apiGet<DocumentRecord[]>(
    `/v1/matters/${encodeURIComponent(matterId)}/documents`);
  return docs.map(migrateDocumentRecord);
}

/** `null` for "there is no such document", and ONLY for that. */
export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const found = await apiGetOrNull<DocumentRecord>(`/v1/documents/${encodeURIComponent(id)}`);
  return found ? migrateDocumentRecord(found) : null;
}

/**
 * Uploads the document's metadata record and its original file bytes as one
 * multipart request.
 *
 * ONE request, not two, and that is what is left of the old two-store
 * transaction: the browser can still not observe a torn write, because there
 * is only one call to fail. What the SERVER does with the two stores behind
 * it — and which of them it writes first — is documented in the route.
 *
 * Still `Promise<void>`. The route answers 201 with the stored record and
 * the caller has never wanted it; returning it here would be a signature
 * change for no caller's benefit, and R3's seam is worth more than the
 * convenience.
 */
export async function addDocument(rec: DocumentRecord, bytes: Blob): Promise<void> {
  const form = new FormData();
  form.append('record', JSON.stringify(rec));
  // The FILENAME matters: some servers refuse a file part without one, and
  // the Blob's own `type` is what the server stores as the document's mime
  // and what `getDocumentBlob` hands back to the viewer.
  form.append('bytes', bytes, rec.name);
  await apiSendBlob<void>('/v1/documents', form);
}

/**
 * Updates a document's collection membership only — its `role` and
 * `collectionId` — leaving its text, its bytes and every other field
 * untouched. Grouping and ungrouping are the only callers: a group writes
 * `'base'`/`'varies'` with the new collection's id, an ungroup writes
 * `'standalone'` with no id at all.
 *
 * `collectionId` is left off the request body entirely when omitted — never
 * sent as `undefined` — and the route writes NULL for it, which `rows.ts`
 * reads back as an ABSENT key. `structuredClone` preserves an
 * `undefined`-valued key and `JSON.stringify` drops one, which is exactly
 * how two stores come to disagree about whether a document is in a
 * collection.
 *
 * Rejects (never resolves silently) when the document doesn't exist — the
 * route answers 404 and this propagates it, because a caller moving a
 * document into or out of a collection has a stale id, and swallowing that
 * would leave the collection's own record pointing at a member this write
 * silently never happened for.
 */
export async function setDocumentRole(
  id: string,
  role: DocumentRecord['role'],
  collectionId?: string,
): Promise<void> {
  await apiSend<DocumentRecord>('PATCH', `/v1/documents/${encodeURIComponent(id)}/role`, {
    role,
    ...(collectionId === undefined ? {} : { collectionId }),
  });
}

/** Removes a document's record and its bytes together — the record first,
 *  then the blob, which is the order the matter cascade uses and for the
 *  same reason (a blob deleted before a row delete that then rolls back
 *  leaves a document pointing at bytes that are gone, which is visible and
 *  worse than a leak).
 *
 *  A 404 RESOLVES: the caller asked for the document to be gone and it is
 *  gone. Every other failure rejects — in particular a 500 saying the bytes
 *  survived, which the reader needs to see. */
/**
 * Asks the server to read a FAILED document's bytes again.
 *
 * The bytes are still stored and the row still points at them, so a parse
 * that failed for a reason that is not a property of the file — a worker
 * killed mid-read, a read that outran its timeout, a blob store briefly
 * unreachable — is recoverable without deleting the document and adding the
 * same file again. That mattered: doing it the old way loses the document's
 * id, and with it its collection membership and its place in every review
 * that names it.
 *
 * The server refuses this on a `parsed` or a `pending` document, by name.
 * Nothing here needs to guess which; the refusal carries its own sentence.
 */
export async function reparseDocument(id: string): Promise<DocumentRecord> {
  return apiSend<DocumentRecord>(
    'POST', `/v1/documents/${encodeURIComponent(id)}/reparse`, {});
}

export async function deleteDocument(id: string): Promise<void> {
  try {
    await apiDelete(`/v1/documents/${encodeURIComponent(id)}`);
  } catch (err) {
    // Matched the way `deleteMatter` matches it — on the class and the
    // status, not on a duck-typed `.status` — so the two siblings cannot
    // drift into two different ideas of what "not found" looks like.
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}
