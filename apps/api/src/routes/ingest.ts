import type { FastifyRequest } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import { blobKeyFor, type BlobStore } from '../blob/store.ts';
import type { DocumentRow } from '../db/rows.ts';

/**
 * The ingest path a matter document and a precedent document SHARE.
 *
 * Extracted at the second copy rather than the third, on a path whose first
 * copy is four days old. §13's own words for Task 19 are *"the ingest path
 * they already share"*, and the thing that must not exist twice is the
 * **write order**: `routes/documents.ts`'s module docstring is a long
 * argument for blob-first, and two ingest handlers would be two places for
 * that ordering to drift. A reversal is silent and its cost is not.
 *
 * What is NOT here: the row's own shape. A matter document names
 * `matter_id`, a precedent names `precedent_set_id`, and both name `kind`
 * explicitly (migration 003 drops the column's default for exactly this
 * reason). Each route writes its own INSERT and hands it in as `insert`.
 */

export function badUpload(detail: string): never {
  throw new ModelError(`LexPrompt could not read this document (${detail}).`, 'unknown', 400);
}

export const DUPLICATE_MESSAGE =
  'A document with that id is already here. Nothing was stored — its file was left exactly as '
  + 'it was, because overwriting the bytes of a document that already exists would replace one '
  + 'document\'s contents with another\'s.';

export const RACED_MESSAGE =
  'A document with that id was added while this upload was in flight, so this upload was '
  + 'refused. Its file HAS been written to storage under that id and may have replaced the '
  + 'other document\'s. Tell an administrator before opening it.';

export interface Upload { record: unknown; bytes: Buffer; mime: string }

/**
 * The multipart body: a `record` field carrying the JSON record and a
 * `bytes` file part.
 *
 * Read with `req.parts()` rather than `req.file()` so the ORDER of the two
 * parts does not matter — a `FormData` built in a different order is still
 * the same request, and a route that only worked one way round would fail
 * for a reason no error message would name.
 */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) {
    badUpload('the upload is not a multipart form; it needs a "record" field and a "bytes" file');
  }
  let record: unknown;
  let bytes: Buffer | undefined;
  let mime = '';
  for await (const part of req.parts()) {
    if (part.type === 'file' && part.fieldname === 'bytes') {
      bytes = await part.toBuffer();
      // `part.mimetype` is what the BROWSER labelled the Blob with, which
      // is what the bytes route hands back to the viewer. Never guessed
      // from the filename's extension — that would be this layer inventing
      // a fact about bytes it did not read.
      mime = part.mimetype || 'application/octet-stream';
    } else if (part.type === 'file') {
      // Drained rather than ignored: an unconsumed file part leaves the
      // request stream stalled, and the caller sees a hang with no cause.
      await part.toBuffer();
    } else if (part.fieldname === 'record') {
      try {
        record = JSON.parse(part.value as string) as unknown;
      } catch (err) {
        badUpload(`the "record" field is not JSON: ${(err as Error).message}`);
      }
    }
  }
  if (record === undefined) badUpload('the upload has no "record" field');
  if (bytes === undefined) badUpload('the upload has no "bytes" file');
  return { record, bytes, mime };
}

export interface IngestRequest {
  db: Db | Tx;
  blobs: BlobStore;
  ws: string;
  id: string;
  bytes: Buffer;
  /** What the browser labelled the Blob with, stored verbatim. */
  mime: string;
  /** Runs the INSERT and returns the stored row, or nothing when `on
   *  conflict (id) do nothing` swallowed it. */
  insert(blobKey: string): Promise<DocumentRow | undefined>;
}

/**
 * Everything that can refuse, then the blob, then the row — in that order,
 * once, for both document kinds.
 *
 * ## What runs BEFORE the blob put
 *
 * The id, checked in this workspace and in every other. An unauthorised or
 * duplicate upload must not leave its bytes behind, and a POST re-using a
 * live document's id must not overwrite that document's bytes before failing
 * — which would be worse than an orphan, because the surviving row would
 * then point at somebody else's file. Whatever ELSE a route needs to refuse
 * on (a matter's existence, a precedent set's) it checks before calling
 * this.
 *
 * The id checks are NOT scoped by `kind`. `document.id` is a global primary
 * key, so a precedent already holding an id makes that id taken for a matter
 * document too, and a `kind` predicate here would let the insert fail on the
 * primary key AFTER the blob had been written.
 */
export async function ingestDocument(req: IngestRequest): Promise<DocumentRow> {
  const { db, blobs, ws, id, bytes } = req;
  const taken = await db.query<{ id: string }>(
    'select id from document where id = $1 and workspace_id = $2', [id, ws]);
  if (taken[0]) throw new ConflictError(undefined, DUPLICATE_MESSAGE);
  // …and the id held by ANOTHER workspace, which `document.id` being a
  // global primary key makes possible and the check above cannot see. A bare
  // `ConflictError`: "that id is taken and by what is not yours to know".
  const elsewhere = await db.query<{ id: string }>(
    'select id from document where id = $1 and workspace_id <> $2', [id, ws]);
  if (elsewhere[0]) throw new ConflictError();

  // ---- Blob first. See `routes/documents.ts`'s module docstring. ----
  const blobKey = blobKeyFor(ws, id);
  await blobs.put(blobKey, bytes, req.mime);

  const row = await req.insert(blobKey);
  if (row) return row;
  // The narrow race the checks above cannot close. A row that appeared in
  // ANOTHER workspace shares no blob key with this upload, so nothing was
  // overwritten and the honest answer is the same bare refusal the pre-check
  // gives. Only a row in THIS workspace shares the key.
  const raced = await db.query<{ id: string }>(
    'select id from document where id = $1 and workspace_id <> $2', [id, ws]);
  if (raced[0]) throw new ConflictError();
  throw new ConflictError(undefined, RACED_MESSAGE);
}
