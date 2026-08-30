import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../audit/write.ts';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { workspacePrefix, type BlobStore } from '../blob/store.ts';
import {
  fromDocumentRow, toDocumentRow, type DocumentRecord, type DocumentRow,
} from '../db/rows.ts';
import { badUpload, ingestDocument, readUpload } from './ingest.ts';

/**
 * The `documents` and `blobs` repositories, server side — Task 9's seven
 * properties (see `matters.ts`) plus the one thing no other repository has:
 * the record and its BYTES live in two stores that cannot share a
 * transaction.
 *
 * ## The write order, and why it is not the tidier one
 *
 * `addDocument` wrote the row and the blob in ONE IndexedDB transaction, so
 * the two could never be observed torn. Postgres and Blob Storage cannot do
 * that, so one of them goes first and the choice is a choice about which
 * failure a person sees:
 *
 *  - **Blob first** (what this does): a failure after the blob and before
 *    the row leaves an ORPHANED BLOB. Invisible to the UI, costs storage,
 *    and is reclaimed by `/v1/admin/blob-orphans` below.
 *  - **Row first**: a failure between them leaves a DOCUMENT RECORD WITH NO
 *    BYTES. Visible to the reader as a document that opens to nothing — and
 *    selectable for review, on the one path whose founding defect is a
 *    document reviewed as though it said nothing.
 *
 * The first is a storage leak with a sweeper. The second is a document that
 * lies about existing. **Blob first.** A later reader will find the other
 * order tidier (validate, insert, upload, and no orphan is possible); this
 * paragraph is here because that reversal is silent and its cost is not.
 *
 * ## What runs BEFORE the blob put
 *
 * Everything that can refuse the request: the body parse, the matter's
 * existence IN THIS WORKSPACE, and whether the id is already taken. An
 * unauthorised upload must not leave its bytes behind, and a POST re-using
 * a live document's id must not overwrite that document's bytes before
 * failing — which would be worse than an orphan, because the surviving row
 * would then point at somebody else's file.
 *
 * The insert still carries `on conflict (id) do nothing`, as the backstop
 * for the narrow window between that check and the write. If it fires, the
 * blob HAS been overwritten and this route says so rather than trying to
 * restore bytes it never read.
 *
 * ## Page images are never persisted
 *
 * Only the original file bytes reach Blob Storage. Nothing in this module
 * reads, writes, or has a name for `DocumentFile.pageImages`; they are
 * derived data regenerated on demand (CLAUDE.md), and a route that stored
 * them would be storing roughly a third more bytes than the document has.
 */
export function registerDocuments(app: FastifyInstance, db: Db, blobs: BlobStore): void {
  app.get('/v1/matters/:id/documents', async (req): Promise<DocumentRecord[]> => {
    const { id } = req.params as { id: string };
    // Oldest-added first, with the id as the tiebreak — the order
    // `listDocuments` sorted for itself when this was IndexedDB, moved to
    // where the database can do it. Two sorts that must agree is this
    // project's most repeated defect, so there is now one.
    const rows = await db.query<DocumentRow>(
      `select * from document
       where matter_id = $1 and workspace_id = $2 and kind = 'matter'
       order by added_at asc, id asc`,
      [id, req.actor!.workspaceId],
    );
    return rows.map(fromDocumentRow);
  });

  app.get('/v1/documents/:id', async (req): Promise<DocumentRecord> => {
    const { id } = req.params as { id: string };
    // `and kind = 'matter'`, on the READ as well as on the list above. A
    // predicate that is only on the list is a picker convention: a deep link
    // to `/v1/documents/<precedent id>` would be the way round it, and the
    // whole of S23 is that the distinction has to survive somebody writing a
    // new query. A precedent answers 404 here and is served by its own route.
    const rows = await db.query<DocumentRow>(
      `select * from document
       where id = $1 and workspace_id = $2 and kind = 'matter' and matter_id is not null`,
      [id, req.actor!.workspaceId],
    );
    if (!rows[0]) throw new ModelError('There is no such document.', 'not_found', 404);
    return fromDocumentRow(rows[0]);
  });

  /**
   * The bytes, straight from Blob Storage.
   *
   * TWO different 404s, and folding them together would be a mistake in the
   * loud direction rather than the quiet one, so they are kept apart in the
   * message: no such document, and a document whose bytes are not on record.
   * The second is a state `getDocumentBlob` has always handled — a record
   * can outlive its bytes — and answering 500 for it would turn a known,
   * handled state into a broken screen.
   */
  app.get('/v1/documents/:id/bytes', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const rows = await db.query<{ blob_key: string; mime: string }>(
      `select blob_key, mime from document
       where id = $1 and workspace_id = $2 and kind = 'matter' and matter_id is not null`, [id, ws]);
    if (!rows[0]) throw new ModelError('There is no such document.', 'not_found', 404);
    // Every OTHER failure from the store propagates — a permission error or
    // an unreachable account answered as 404 would render "this document's
    // bytes are unavailable" over a store that is simply refusing us.
    const stored = await blobs.get(rows[0].blob_key);
    if (!stored) {
      throw new ModelError(
        'This document\'s file is not in storage. Its record is still here, so nothing else '
        + 'about the document is lost, but the original file cannot be opened.',
        'not_found', 404,
      );
    }
    await reply
      .header('content-type', stored.mime || rows[0].mime)
      .header('content-length', String(stored.bytes.byteLength))
      .code(200)
      .send(stored.bytes);
  });

  // NOT `app.post<{ Body: … }>(…)` — see `matters.ts`'s note on the inline
  // generic and `oidc.test.ts`'s no-bypass scanner.
  app.post('/v1/documents', async (req, reply): Promise<DocumentRecord> => {
    const ws = req.actor!.workspaceId;
    const { record, bytes, mime } = await readUpload(req);
    const input = parseDocument(record);

    // ---- Everything that can refuse, before a single byte is stored. ----

    // The matter, IN THIS WORKSPACE. A document whose matter is somebody
    // else's is 404 rather than 403 (property 4): a 403 would confirm the
    // matter id exists somewhere, and the answer is the same one the caller
    // would have got for an id that never existed.
    const matter = await db.query<{ id: string }>(
      'select id from matter where id = $1 and workspace_id = $2', [input.matterId, ws]);
    if (!matter[0]) {
      throw new ModelError(
        `There is no matter ${input.matterId} to add this document to.`, 'not_found', 404);
    }
    // The id checks, the blob put and the race resolution are `ingest.ts`'s
    // — SHARED with the precedent upload (§13's "the ingest path they
    // already share"), so the blob-first ordering this module argues for at
    // length exists in exactly one place. What stays here is the INSERT,
    // because a matter document's row shape is not a precedent's.
    const stored = await ingestDocument({
      db, blobs, ws, id: input.id, bytes, mime,
      insert: async (blobKey) => {
        const row = toDocumentRow(
          // THE ATTRIBUTION COMES FROM THE TOKEN (property 3). What the body
          // claimed is read by `parseDocument` and discarded there.
          { ...input, addedByUserId: req.actor!.id }, ws,
          { mime, blobKey, ...(input.contentSha256 === undefined ? {} : { contentSha256: input.contentSha256 }) },
        );
        // ---- THE UPLOAD RETURNS BEFORE THE TEXT EXISTS (Stage 3 Task 9) ----
        //
        // P12, closed. Stage 2 stored `parse_state` from the browser's own
        // parse and said "Stage 3 changes only who writes it". This is that
        // change: the bytes are stored, the row is written `'pending'`, and
        // `parse/parseWorker.ts` is the ONE writer of every later
        // `parse_state`. `'pending'` has been in the check constraint since
        // Stage 2 and unused; it starts being used here.
        //
        // The body's `text` is DISCARDED rather than stored alongside, and
        // that is the whole point. Keeping it would mean the row said
        // "pending" while carrying text a reader would be shown — two
        // sources for one fact, the older one winning, with nothing to say
        // which was which. It is also the browser's PARSE of the same bytes
        // this route just stored, so nothing is lost that cannot be
        // regenerated by the parser that will read them in a moment.
        //
        // A CALLER CHANGE, and therefore a finding rather than a detail:
        // `POST /v1/documents` now answers with `parseState: 'pending'` and
        // an empty `text`, and a client that renders `text` without
        // consulting `parseState` shows a document that appears to say
        // nothing. `routes/runs.ts` refuses to REVIEW such a document by
        // name, which is the half that cannot be got wrong quietly; the
        // "Reading…" state on screen is Task 24's.
        //
        // `markup_notice` is the one thing still taken from the body, and
        // deliberately: detecting tracked changes means reading the .docx
        // package (`src/lib/docxMarkup.ts`), which is still browser-side, and
        // the parse worker holds no grant on that column precisely so it
        // cannot overwrite a disclosure with a blank.
        row.parse_state = 'pending';
        row.parse_error = null;
        row.text = '';
        // `kind` is NAMED, never left to a default — migration 003 drops the
        // one it needed to backfill with, so an insert that forgets it fails
        // loudly rather than quietly producing a matter document.
        // ONE TRANSACTION with its audit row (S11): a log that records an
        // upload which rolled back is worse than no log.
        return db.tx(async t => {
          const rows = await t.query<DocumentRow>(
            `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                                   parse_state, parse_error, markup_notice, byte_size, mime,
                                   blob_key, content_sha256, role, collection_id, document_date,
                                   added_at, added_by_user_id)
             values ($1, $2, 'matter', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                     $16, $17, $18)
             on conflict (id) do nothing
             returning *`,
            [row.id, ws, row.matter_id, row.name, row.doc_type, row.text, row.parse_state,
              row.parse_error, row.markup_notice, row.byte_size, row.mime, row.blob_key,
              row.content_sha256, row.role, row.collection_id, row.document_date, row.added_at,
              row.added_by_user_id],
          );
          // `on conflict do nothing` means a retried upload writes nothing —
          // and audits nothing. Two `document.added` rows for one document
          // would make the log disagree with the store about how many
          // documents a matter has.
          if (rows[0] && row.matter_id) {
            await appendAudit(t, {
              workspaceId: ws, actorUserId: req.actor!.id, action: 'document.added',
              subjectType: 'document', subjectId: row.id, matterId: row.matter_id,
              detail: { name: row.name, byteSize: row.byte_size },
            });
          }
          return rows[0];
        });
      },
    });
    // `reply.code(201)` and NOT `await reply.code(201)`. A `FastifyReply` is
    // thenable, and awaiting one means "I am sending this reply myself" — so
    // an awaited `.code()` with no `.send()` never settles and the request
    // hangs until the client gives up. It cost an afternoon here: every
    // assertion in this route's suite failed as a five-second timeout, with
    // the SQL visibly succeeding, which reads as a database problem.
    reply.code(201);
    return fromDocumentRow(stored);
  });

  /**
   * Collection membership ONLY — `role` and `collection_id`, named
   * explicitly, never a whole-row rewrite.
   *
   * The shipped `setDocumentRole` read the record inside its own
   * transaction and spread over it, so a field added by some later change
   * survived a role update rather than being dropped because this
   * function's shape went stale. An `UPDATE` naming two columns is the same
   * guarantee by stronger means: a column this route has never heard of
   * cannot be touched by a statement that does not name it.
   *
   * Ungrouping REMOVES `collection_id` (sets it NULL, which `rows.ts` reads
   * back as an ABSENT key) rather than writing `undefined` into it —
   * `structuredClone` preserves an `undefined`-valued key and JSON drops
   * one, which is how two stores come to disagree about whether a document
   * is in a collection.
   */
  app.patch('/v1/documents/:id/role', async (req): Promise<DocumentRecord> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const { role, collectionId } = parseRolePatch(req.body);
    // The collection must EXIST, in this workspace (Part 2A m3). The absent
    // foreign key is deliberate — grouping writes the collection record and
    // each member's `role` non-atomically, and an FK would refuse the
    // intermediate state — but "deliberately not enforced by the database"
    // is not "deliberately not checked". Without this, a stale id writes a
    // document into a collection that does not exist, and `collectionId` is
    // what the ungroup path and the collection reader both key on: the
    // document disappears from the matter's standalone list and appears in
    // nothing.
    if (collectionId !== undefined) {
      const collection = await db.query<{ id: string }>(
        'select id from collection where id = $1 and workspace_id = $2', [collectionId, ws]);
      if (!collection[0]) {
        throw new ModelError(
          `There is no collection ${collectionId} to put this document in. Reload the matter `
          + 'and try again; nothing has been changed.', 'not_found', 404);
      }
    }
    const rows = await db.query<DocumentRow>(
      `update document set role = $3, collection_id = $4
       where id = $1 and workspace_id = $2 and kind = 'matter' and matter_id is not null
       returning *`,
      [id, ws, role, collectionId ?? null],
    );
    if (!rows[0]) {
      // Rejects rather than resolving silently, exactly as the IndexedDB
      // version did: a caller moving a document into or out of a collection
      // has a stale id, and swallowing that leaves the collection's own
      // record pointing at a member this write never happened for.
      throw new ModelError(`Document ${id} could not be found.`, 'not_found', 404);
    }
    return fromDocumentRow(rows[0]);
  });

  /**
   * READ IT AGAIN — the one action a `failed` document offers.
   *
   * A parse fails for reasons that are not properties of the file: the
   * worker was killed mid-read, the read outran `API_PARSE_TIMEOUT_MS` on a
   * busy host, the blob store was briefly unreachable. The bytes are still
   * here and the row still points at them, so the honest affordance is to
   * put it back in the queue rather than to make somebody delete a document
   * and add the same file again — which is what the failure message used to
   * tell them to do, and which loses the document's id, its collection
   * membership and its place in every review that names it.
   *
   * ONLY from `failed`. Not from `parsed`, which would blank a document
   * every review of it depends on and reopen the founding defect from a
   * button; and not from `pending`, which is already queued — a second
   * request would read as progress while changing nothing. Both are
   * refused by name rather than answered with a no-op 200, because "we did
   * nothing and said it worked" is the shape this app exists not to have.
   *
   * `parse_state` back to `'pending'`, `parse_error` cleared and `text`
   * blanked, in ONE statement: a row that said `pending` while still
   * carrying the old error would show "Reading…" and the failure at once.
   * The parse worker claims `pending` rows and is the only writer of what
   * happens next.
   */
  app.post('/v1/documents/:id/reparse', async (req): Promise<DocumentRecord> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const rows = await db.query<DocumentRow>(
      `update document
          set parse_state = 'pending', parse_error = null, text = ''
        where id = $1 and workspace_id = $2 and parse_state = 'failed'
        returning *`, [id, ws]);
    if (!rows[0]) {
      // Which of the two it is, because "nothing happened" with no reason is
      // the answer a reader cannot act on. Read AFTER the update rather than
      // before, so the common path is one statement.
      const held = await db.query<{ parse_state: string; name: string }>(
        'select parse_state, name from document where id = $1 and workspace_id = $2', [id, ws]);
      if (!held[0]) throw new ModelError('There is no such document.', 'not_found', 404);
      throw new ModelError(
        held[0].parse_state === 'pending'
          ? `${held[0].name} is already being read. Nothing was changed.`
          : `${held[0].name} was read successfully, so there is nothing to read again. Reading `
            + 'it again would blank the text every review of it was run against.',
        'conflict', 409);
    }
    return fromDocumentRow(rows[0]);
  });

  app.delete('/v1/documents/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    // Rows first, then bytes — the same order as the matter cascade, and
    // for the reason written there: a blob deleted before a committed row
    // delete rolls back would leave a document pointing at bytes that no
    // longer exist, which is visible and worse than a leak.
    const rows = await db.tx(async t => {
      const deleted = await t.query<{ blob_key: string; matter_id: string | null; name: string }>(
        `delete from document
         where id = $1 and workspace_id = $2 and kind = 'matter' and matter_id is not null
         returning blob_key, matter_id, name`, [id, ws]);
      if (deleted[0]) {
        await appendAudit(t, {
          workspaceId: ws, actorUserId: req.actor!.id, action: 'document.deleted',
          subjectType: 'document', subjectId: id,
          ...(deleted[0].matter_id ? { matterId: deleted[0].matter_id } : {}),
          detail: { name: deleted[0].name },
        });
      }
      return deleted;
    });
    if (!rows[0]) throw new ModelError('There is no such document.', 'not_found', 404);
    const failed = await deleteBlobs(blobs, rows.map(r => r.blob_key));
    if (failed.length > 0) throw blobDeleteFailure(failed);
    await reply.code(204).send();
  });

  /**
   * The reconciliation §6.5 asks for, as two OPERATOR-ONLY routes and no
   * scheduler.
   *
   * "The cascade is a promise the README makes and a half-done cascade is
   * the failure mode that promise exists to prevent." A scheduled job needs
   * a worker, which is a Stage 3 concern.
   *
   * SAID PLAINLY, because the earlier version of this comment justified the
   * arrangement by "an administrator who can SEE the orphans", and there was
   * nothing anywhere an administrator could see them WITH: no screen, no
   * script, no README step, no caller of any kind. That is this project's
   * most-recorded defect — a correct mechanism with no path to it — and a
   * comment asserting the path exists is worse than the missing path,
   * because it stops anyone looking for one.
   *
   * There is still NO IN-APP SCREEN, and that is deferred rather than
   * silently missing, the same way `⌘K` and the Report tab are. The path
   * that does exist is `curl` against these two routes with an admin's own
   * bearer token, written down in README's "Reclaiming orphaned document
   * files" beside the Postgres and Keycloak notes — and that section is what
   * `blobDeleteFailure` below points a user's administrator at, so the
   * remedy the error names is a remedy that exists.
   *
   * Scoped to the workspace at BOTH ends — the blob prefix and the `document`
   * query — so this can never propose deleting another workspace's bytes.
   */
  app.get('/v1/admin/blob-orphans', async (req): Promise<{ keys: string[] }> => {
    return { keys: await orphanKeys(db, blobs, req.actor!.workspaceId) };
  });

  app.post('/v1/admin/blob-orphans/delete', async (req): Promise<{ deleted: string[] }> => {
    const ws = req.actor!.workspaceId;
    // Recomputed here rather than taken from the caller: a key list in a
    // request body is a caller naming bytes to destroy, and the only list
    // this route will act on is the one it derived itself.
    const keys = await orphanKeys(db, blobs, ws);
    const failed = await deleteBlobs(blobs, keys);
    if (failed.length > 0) throw blobDeleteFailure(failed);
    return { deleted: keys };
  });
}

/** The keys under this workspace's prefix that no `document` row claims.
 *
 *  NO `kind` predicate, deliberately, and it is the one `document` query in
 *  this module that must not have one: a PRECEDENT's bytes are claimed too,
 *  and filtering them out here would make every precedent blob look like an
 *  orphan — which the route below then offers to delete. The workspace
 *  filter is the whole of the scoping this query needs. */
async function orphanKeys(db: Db, blobs: BlobStore, ws: string): Promise<string[]> {
  const stored = await blobs.list(workspacePrefix(ws));
  const rows = await db.query<{ blob_key: string }>(
    'select blob_key from document where workspace_id = $1', [ws]);
  const claimed = new Set(rows.map(r => r.blob_key));
  return stored.filter(key => !claimed.has(key)).sort();
}

/**
 * Deletes every key and returns the ones that could not be deleted.
 *
 * The loop does NOT stop at the first failure, and that is the whole point:
 * a half-done cascade is the failure the README's promise exists to prevent,
 * and the likeliest cause of one is a single `delete` throwing and aborting
 * the rest. Exported so the matter cascade and the document delete share one
 * implementation rather than two that must agree.
 */
export async function deleteBlobs(blobs: BlobStore, keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await blobs.delete(key);
    } catch {
      failed.push(key);
    }
  }
  return failed;
}

/**
 * The rows are already gone by the time this is thrown, so the failure
 * cannot be undone. The honest answer is to say so, name the keys, and leave
 * them for the sweeper — silence here would make the README's sentence false
 * with nothing on any screen to show it.
 */
export function blobDeleteFailure(failed: string[]): ModelError {
  const one = failed.length === 1;
  return new ModelError(
    `The records were deleted, but ${failed.length} document ${one ? 'file' : 'files'} could `
    + 'not be deleted from storage. The bytes are still held, and no record claims them any '
    + 'more. An administrator can list and remove them — see "Reclaiming orphaned document '
    + 'files" in the README. Tell them, quoting: '
    + failed.join(', '),
    'unknown', 500,
  );
}

/** `ingest.ts`'s refusal, under this module's shorter name. One
 *  implementation, so a matter upload and a precedent upload refuse an
 *  unreadable record in the same words. */
function bad(detail: string): never {
  badUpload(detail);
}

/**
 * The body, checked rather than cast.
 *
 * `addedByUserId` is read and DISCARDED — the handler replaces it with the
 * authenticated actor before anything is written (property 3), and it is
 * also what makes `added_by_user_id`'s foreign key satisfiable while the
 * browser still holds a local profile id.
 *
 * `parse_state` is NOT read from the body at all. It is derived by
 * `toDocumentRow` from `parseError`'s presence: 'failed' when parsing
 * failed, 'parsed' otherwise, and **never 'pending' in Stage 2** — nothing
 * on this path is asynchronous. A document silently marked `parsed` with no
 * text is this project's founding defect wearing a database column, and
 * Stage 3's parse worker will read that column.
 */
export function parseDocument(body: unknown): DocumentRecord & { contentSha256?: string } {
  if (typeof body !== 'object' || body === null) bad('the record is not an object');
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id) bad('id is missing or empty');
  const matterId = typeof b.matterId === 'string' ? b.matterId.trim() : '';
  if (!matterId) bad('matterId is missing or empty');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) bad('name is missing or empty');
  if (b.kind !== 'pdf' && b.kind !== 'docx' && b.kind !== 'txt') {
    bad(`kind is ${JSON.stringify(b.kind)}, which is not pdf, docx or txt`);
  }
  if (typeof b.text !== 'string') bad('text is missing or is not a string');
  if (typeof b.byteSize !== 'number' || !Number.isFinite(b.byteSize)) {
    bad('byteSize is missing or is not a number');
  }
  if (typeof b.addedAt !== 'number' || !Number.isFinite(b.addedAt)) {
    bad('addedAt is missing or is not a timestamp');
  }
  if (b.role !== 'base' && b.role !== 'varies' && b.role !== 'standalone') {
    bad(`role is ${JSON.stringify(b.role)}, which is not base, varies or standalone`);
  }
  return {
    id,
    matterId,
    name,
    kind: b.kind,
    text: b.text,
    // ABSENT, never `parseError: undefined` — `absentUnless`'s rule, at the
    // parse rather than at the read. A key present with an undefined value
    // round-trips differently through JSON and through `structuredClone`.
    ...(typeof b.parseError === 'string' ? { parseError: b.parseError } : {}),
    ...(typeof b.markupNotice === 'string' ? { markupNotice: b.markupNotice } : {}),
    byteSize: b.byteSize,
    addedAt: b.addedAt,
    // Read off the body and DISCARDED — see the docstring.
    addedByUserId: '',
    role: b.role,
    ...(typeof b.collectionId === 'string' ? { collectionId: b.collectionId } : {}),
    ...(typeof b.documentDate === 'number' && Number.isFinite(b.documentDate)
      ? { documentDate: b.documentDate } : {}),
    ...(typeof b.contentSha256 === 'string' ? { contentSha256: b.contentSha256 } : {}),
  };
}

export function parseRolePatch(body: unknown): { role: DocumentRecord['role']; collectionId?: string } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.role !== 'base' && b.role !== 'varies' && b.role !== 'standalone') {
    bad(`role is ${JSON.stringify(b.role)}, which is not base, varies or standalone`);
  }
  if (b.collectionId !== undefined && typeof b.collectionId !== 'string') {
    bad('collectionId is present but is not a string');
  }
  // A `collectionId` of '' is treated as absent rather than stored: an empty
  // string is not an id, and storing one would make `'collectionId' in doc`
  // true for a document in no collection.
  const collectionId = typeof b.collectionId === 'string' && b.collectionId !== ''
    ? b.collectionId : undefined;
  return { role: b.role, ...(collectionId === undefined ? {} : { collectionId }) };
}
