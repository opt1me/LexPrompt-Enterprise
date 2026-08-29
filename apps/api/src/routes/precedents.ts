import type { FastifyInstance } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import type { BlobStore } from '../blob/store.ts';
import {
  fromPrecedentDocumentRow, fromPrecedentSetRow, toPrecedentDocumentRow, toPrecedentSetRow,
  type DocumentRow, type PrecedentDocumentRecord, type PrecedentSet, type PrecedentSetRow,
} from '../db/rows.ts';
import { badUpload, ingestDocument, readUpload } from './ingest.ts';
import { deleteBlobs, blobDeleteFailure } from './documents.ts';

/**
 * Precedent sets and precedent documents (§11.1).
 *
 * ## Why this exists at all, and what it changed
 *
 * A precedent is a document a firm brings in to LEARN from — its own past
 * negotiated leases, usually with an opposing party's markup still in them.
 * Sub-project F held them in the browser for one session and stored nothing;
 * §11.1 supersedes that, because a house position adopted from a redline is
 * only *evidenced* for as long as the evidence exists, and session-only
 * storage made that claim true for about ninety seconds.
 *
 * **The screen that asks a lawyer for those files says so, and it says so in
 * the same commit as this route** (`src/lib/privacyCopy.ts`'s
 * `PRECEDENT_STORAGE_PRIVACY`, rendered by `PrecedentIntake`). §11.1 states
 * that as an acceptance condition rather than a note.
 *
 * ## What keeps a precedent apart from a matter document (S23)
 *
 * Storing another client's papers beside the firm's live matters is a new
 * category of content in a store designed around matter files. If a
 * precedent appeared in a matter's document list it could be opened as
 * though it were the deal under review, added to a collection, run through
 * a playbook, or cited in an export — and a citation pointing into the wrong
 * client's lease is the error this app exists to make impossible.
 *
 * Three mechanisms, none of which is a convention:
 *
 *  - **`document_kind_shape`** (migration 003) makes a precedent row with a
 *    `matter_id` — or a matter row with no `matter_id` — impossible to
 *    write at all.
 *  - **Every matter-context query names `kind = 'matter'`**, held there by
 *    `workspaceScope.test.ts`'s scanner, and the review-target and
 *    collection-member checks REFUSE a precedent with a message that names
 *    it rather than answering a generic "not in this matter" that would send
 *    someone hunting for a document sitting in front of them.
 *  - **These routes are the only way to read one**, so the predicate above
 *    cannot make precedents unreachable instead — a `kind` filter on every
 *    route would pass every negative test and be a different bug with the
 *    same green suite.
 *
 * ## Deleting a set
 *
 * `document.precedent_set_id` is `on delete cascade`, so the rows go with
 * the set; the BYTES are deleted by this route, in the same rows-then-bytes
 * order the matter cascade uses and for the reason written there. §17 Q3 is
 * the policy question this makes real: a set may hold another client's
 * executed documents, and a house position adopted from it may be relied on
 * for years after the set would otherwise have been disposed of. Disposing
 * of the set makes that position's basis UNRESOLVABLE, which
 * `position_basis` says on screen rather than rendering an empty panel.
 */
export function registerPrecedents(app: FastifyInstance, db: Db, blobs: BlobStore): void {
  app.post('/v1/precedent-sets', async (req, reply): Promise<PrecedentSet> => {
    const ws = req.actor!.workspaceId;
    const input = parsePrecedentSet(req.body);
    // THE ATTRIBUTION COMES FROM THE TOKEN (property 3), never from the body.
    const row = toPrecedentSetRow({ ...input, createdByUserId: req.actor!.id }, ws);
    // A playbook this set will be adopted into, IN THIS WORKSPACE. Checked
    // rather than left to the foreign key, so a stale id is a refusal that
    // names the cause instead of a 500 carrying a raw constraint name.
    if (row.playbook_id !== null) {
      const playbook = await db.query<{ id: string }>(
        'select id from playbook where id = $1 and workspace_id = $2', [row.playbook_id, ws]);
      if (!playbook[0]) {
        throw new ModelError(
          `There is no playbook ${row.playbook_id} for this precedent set to belong to.`,
          'not_found', 404);
      }
    }
    const rows = await db.query<PrecedentSetRow>(
      `insert into precedent_set (id, workspace_id, name, playbook_id, created_by_user_id,
                                  created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing
       returning *`,
      [row.id, ws, row.name, row.playbook_id, row.created_by_user_id, row.created_at]);
    if (!rows[0]) throw new ConflictError(undefined, SET_TAKEN_MESSAGE);
    reply.code(201);
    return fromPrecedentSetRow(rows[0]);
  });

  app.get('/v1/precedent-sets/:id', async (req): Promise<PrecedentSet> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<PrecedentSetRow>(
      'select * from precedent_set where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw noSuchSet();
    return fromPrecedentSetRow(rows[0]);
  });

  app.get('/v1/precedent-sets/:id/documents', async (req): Promise<PrecedentDocumentRecord[]> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    // The PARENT first. Without it, a set that does not exist — or belongs
    // to another workspace — answers `[]`, which reads on screen as "nothing
    // brought in yet": the empty-versus-broken rule, on a list route.
    await requireSet(db, id, ws);
    const rows = await db.query<DocumentRow>(
      `select * from document
       where precedent_set_id = $1 and workspace_id = $2 and kind = 'precedent'
       order by added_at asc, id asc`,
      [id, ws]);
    return rows.map(fromPrecedentDocumentRow);
  });

  /**
   * The precedent upload — the SAME multipart shape and the SAME ingest as
   * `POST /v1/documents`, through `ingest.ts`.
   *
   * Two ingest handlers would be two places for the blob-first ordering to
   * drift, and that ordering is a page of argument in `documents.ts` about
   * which failure a person sees. This route supplies only what is different:
   * the set to check, and the INSERT's own column list.
   */
  app.post('/v1/precedent-sets/:id/documents', async (req, reply): Promise<PrecedentDocumentRecord> => {
    const ws = req.actor!.workspaceId;
    const { id: setId } = req.params as { id: string };
    const { record, bytes, mime } = await readUpload(req);
    const input = parsePrecedentDocument(setId, record);

    // ---- Everything that can refuse, before a single byte is stored. ----
    await requireSet(db, setId, ws);

    const stored = await ingestDocument({
      db, blobs, ws, id: input.id, bytes, mime,
      insert: async (blobKey) => {
        const row = toPrecedentDocumentRow(
          { ...input, addedByUserId: req.actor!.id }, ws, { mime, blobKey });
        // `kind` and `matter_id` are BOTH named, and `matter_id` is written
        // NULL explicitly rather than omitted. `document_kind_shape` would
        // catch a precedent carrying a matter either way; naming the column
        // is what makes the intent readable at the one statement where a
        // copy-paste from the matter insert would do real harm.
        const rows = await db.query<DocumentRow>(
          `insert into document (id, workspace_id, kind, matter_id, precedent_set_id, name,
                                 doc_type, text, parse_state, parse_error, markup_notice,
                                 byte_size, mime, blob_key, content_sha256, role,
                                 collection_id, document_date, added_at, added_by_user_id)
           values ($1, $2, 'precedent', null, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null,
                   'standalone', null, null, $13, $14)
           on conflict (id) do nothing
           returning *`,
          [row.id, ws, row.precedent_set_id, row.name, row.doc_type, row.text, row.parse_state,
            row.parse_error, row.markup_notice, row.byte_size, row.mime, row.blob_key,
            row.added_at, row.added_by_user_id]);
        return rows[0];
      },
    });
    reply.code(201);
    return fromPrecedentDocumentRow(stored);
  });

  /**
   * A precedent by id, through its OWN route.
   *
   * The POSITIVE half of S23, and it is not decoration: a `kind = 'matter'`
   * predicate on every route in the app would pass every "a precedent must
   * not appear here" test and leave precedents unreachable — a different
   * bug with the same green suite. "The workings" is opened months after the
   * session that produced it, and this is what it reads.
   */
  app.get('/v1/precedent-documents/:id', async (req): Promise<PrecedentDocumentRecord> => {
    const rows = await precedentById(db, req.params as { id: string }, req.actor!.workspaceId);
    if (!rows[0]) throw noSuchPrecedent();
    return fromPrecedentDocumentRow(rows[0]);
  });

  /** The bytes — what makes §11.1's "inference can be re-run without
   *  re-uploading" true rather than aspirational. */
  app.get('/v1/precedent-documents/:id/bytes', async (req, reply): Promise<void> => {
    const rows = await precedentById(db, req.params as { id: string }, req.actor!.workspaceId);
    if (!rows[0]) throw noSuchPrecedent();
    const stored = await blobs.get(rows[0].blob_key);
    if (!stored) {
      throw new ModelError(
        'This precedent document\'s file is not in storage. Its record is still here, so '
        + 'nothing else about it is lost, but the original file cannot be opened.',
        'not_found', 404);
    }
    await reply
      .header('content-type', stored.mime || rows[0].mime)
      .header('content-length', String(stored.bytes.byteLength))
      .code(200)
      .send(stored.bytes);
  });

  /**
   * Removes one precedent document and its bytes.
   *
   * Exists because a person can take a document back OUT of an intake
   * session. Without it, the screen's promise — "stored with the playbook
   * you build from them" — would be false in the quiet direction for a
   * document they explicitly removed: still held, belonging to a playbook it
   * never taught.
   *
   * Rows first, then bytes, exactly as the matter cascade does it.
   */
  app.delete('/v1/precedent-documents/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const rows = await db.query<{ blob_key: string }>(
      `delete from document
       where id = $1 and workspace_id = $2 and kind = 'precedent'
       returning blob_key`, [id, ws]);
    if (!rows[0]) throw noSuchPrecedent();
    const failed = await deleteBlobs(blobs, rows.map(r => r.blob_key));
    if (failed.length > 0) throw blobDeleteFailure(failed);
    await reply.code(204).send();
  });

  /**
   * Deletes the set, its documents and their bytes.
   *
   * Rows first, then bytes — the matter cascade's order, for the reason
   * written there: a blob deleted before a committed row delete rolls back
   * would leave a document pointing at bytes that no longer exist, which is
   * visible and worse than a leak. The document rows go by
   * `precedent_set_id`'s `on delete cascade`; the keys are collected first,
   * because after the delete nothing names them.
   */
  app.delete('/v1/precedent-sets/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const keys = await db.query<{ blob_key: string }>(
      `select blob_key from document
       where precedent_set_id = $1 and workspace_id = $2 and kind = 'precedent'`, [id, ws]);
    const gone = await db.query<{ id: string }>(
      'delete from precedent_set where id = $1 and workspace_id = $2 returning id', [id, ws]);
    if (!gone[0]) throw noSuchSet();
    const failed = await deleteBlobs(blobs, keys.map(k => k.blob_key));
    if (failed.length > 0) throw blobDeleteFailure(failed);
    await reply.code(204).send();
  });
}

const SET_TAKEN_MESSAGE =
  'A precedent set with that id already exists. Nothing was changed.';

function noSuchSet(): ModelError {
  return new ModelError('There is no such precedent set.', 'not_found', 404);
}

function noSuchPrecedent(): ModelError {
  return new ModelError('There is no such precedent document.', 'not_found', 404);
}

async function requireSet(db: Db, id: string, ws: string): Promise<void> {
  const rows = await db.query<{ id: string }>(
    'select id from precedent_set where id = $1 and workspace_id = $2', [id, ws]);
  // 404 rather than 403 for a set in another workspace, exactly as every
  // other read of a specific record here: a 403 would confirm the id exists
  // somewhere.
  if (!rows[0]) throw noSuchSet();
}

function precedentById(db: Db, params: { id: string }, ws: string): Promise<DocumentRow[]> {
  return db.query<DocumentRow>(
    `select * from document
     where id = $1 and workspace_id = $2 and kind = 'precedent'`, [params.id, ws]);
}

export function parsePrecedentSet(body: unknown): PrecedentSet {
  if (typeof body !== 'object' || body === null) badUpload('the precedent set is not an object');
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id) badUpload('id is missing or empty');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) badUpload('name is missing or empty');
  if (typeof b.createdAt !== 'number' || !Number.isFinite(b.createdAt)) {
    badUpload('createdAt is missing or is not a timestamp');
  }
  return {
    id,
    name,
    ...(typeof b.playbookId === 'string' && b.playbookId !== '' ? { playbookId: b.playbookId } : {}),
    createdAt: b.createdAt,
    // Read off the body and DISCARDED — the handler replaces it with the
    // authenticated actor (property 3).
    createdByUserId: '',
  };
}

/**
 * The precedent document's record, checked rather than cast.
 *
 * `precedentSetId` comes from the URL, NEVER from the body: a body claiming
 * a different set than the one the caller posted to would be a document
 * filed under a set nobody checked. Whatever the body says is discarded.
 *
 * There is no `matterId` to read and no way to supply one — `storedAs` is
 * fixed at `'precedent'` here, not taken from the caller, so the one field
 * that decides which side of S23 a document lands on cannot be chosen by a
 * request.
 */
export function parsePrecedentDocument(setId: string, body: unknown): PrecedentDocumentRecord {
  if (typeof body !== 'object' || body === null) badUpload('the record is not an object');
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id) badUpload('id is missing or empty');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) badUpload('name is missing or empty');
  if (b.kind !== 'pdf' && b.kind !== 'docx' && b.kind !== 'txt') {
    badUpload(`kind is ${JSON.stringify(b.kind)}, which is not pdf, docx or txt`);
  }
  if (typeof b.text !== 'string') badUpload('text is missing or is not a string');
  if (typeof b.byteSize !== 'number' || !Number.isFinite(b.byteSize)) {
    badUpload('byteSize is missing or is not a number');
  }
  if (typeof b.addedAt !== 'number' || !Number.isFinite(b.addedAt)) {
    badUpload('addedAt is missing or is not a timestamp');
  }
  return {
    id,
    precedentSetId: setId,
    name,
    kind: b.kind,
    text: b.text,
    // ABSENT, never `parseError: undefined` — `absentUnless`'s rule at the
    // parse rather than at the read.
    ...(typeof b.parseError === 'string' ? { parseError: b.parseError } : {}),
    ...(typeof b.markupNotice === 'string' ? { markupNotice: b.markupNotice } : {}),
    byteSize: b.byteSize,
    addedAt: b.addedAt,
    addedByUserId: '',
    storedAs: 'precedent',
  };
}
