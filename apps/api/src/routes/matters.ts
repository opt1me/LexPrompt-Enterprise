import type { FastifyInstance } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import { fromMatterRow, toMatterRow, type Matter, type MatterRow } from '../db/rows.ts';
import type { BlobStore } from '../blob/store.ts';
import { blobDeleteFailure, deleteBlobs } from './documents.ts';

/**
 * The `matters` repository, server side — and the SHAPE every later
 * repository route copies.
 *
 * Seven properties are the pattern, and each of them is here because
 * getting it wrong is silent:
 *
 *  1. **Every statement names `workspace_id`**, in the WHERE of a read and
 *     in both halves of a write. `workspaceScope.test.ts` scans this
 *     directory for a statement that does not, because such a query fails by
 *     showing too much rather than too little and nothing on screen would
 *     look wrong.
 *  2. **The workspace comes from `req.actor`, never from the body or the
 *     query string.** A body-supplied workspace is not a filter, it is a
 *     request to read someone else's data.
 *  3. **Attribution comes from `req.actor` too, never from the body.**
 *     `owner_id` here; `added_by_user_id`, `created_by_user_id` and
 *     `published_by_user_id` in the tasks that follow. A caller's claim
 *     about who did something is not evidence of who did it.
 *  4. **A record in another workspace is 404, not 403.** A 403 confirms the
 *     id exists somewhere, which is a fact this workspace is not entitled
 *     to. `getMatter` maps 404 to `null`, so the caller sees exactly what it
 *     saw when IndexedDB had no such key.
 *  5. **A stale write is refused with `ConflictError`, never applied.** See
 *     the PUT below for why the `WHERE` on `DO UPDATE` is the load-bearing
 *     line.
 *  6. **The row <-> wire mapping goes through `rows.ts`**, both directions,
 *     so the ''-to-NULL attribution rule and the milliseconds-to-`timestamptz`
 *     rule have one implementation rather than one per route.
 *  7. **The body is parsed, not cast.** A malformed record is a 400 that
 *     names the field, not a row of NULLs the database accepts and a reader
 *     later reads as fact.
 */
export function registerMatters(app: FastifyInstance, db: Db, blobs: BlobStore): void {
  app.get('/v1/matters', async (req): Promise<Matter[]> => {
    // `updated_at desc, seq desc` — the tiebreak sub-project A added `_seq`
    // to IndexedDB to get. Two saves in one millisecond ordered by
    // `updated_at` alone are ordered arbitrarily, and losing that here would
    // lose it SILENTLY, because the list would still render.
    const rows = await db.query<MatterRow>(
      'select * from matter where workspace_id = $1 order by updated_at desc, seq desc',
      [req.actor!.workspaceId],
    );
    return rows.map(fromMatterRow);
  });

  app.get('/v1/matters/:id', async (req): Promise<Matter> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<MatterRow>(
      'select * from matter where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId],
    );
    if (!rows[0]) throw new ModelError('There is no such matter.', 'not_found', 404);
    return fromMatterRow(rows[0]);
  });

  // NOT `app.put<{ Params: … }>(…)`. The inline generic between the method
  // name and its opening paren is the shape `oidc.test.ts`'s no-bypass
  // scanner does not match, and a route registered that way is silently
  // absent from the 401 sweep — `me.ts` carries the same note and the same
  // cast for the same reason.
  app.put('/v1/matters/:id', async (req): Promise<Matter> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const input = parseMatter(id, req.body);
    // THE ATTRIBUTION COMES FROM THE TOKEN, NEVER FROM THE BODY — the same
    // rule `registerInfer` applies when it overwrites a client-supplied
    // actor, and property 3 of this pattern, which later tasks copy
    // (`addedByUserId`, `createdByUserId`, `publishedByUserId` are all the
    // same field one table over).
    //
    // It is also what makes the column's foreign key satisfiable at all:
    // `Matter.ownerId` on the wire is whatever the browser had — before Task
    // 15 that is still the LOCAL profile's `uid()`, which is not an
    // `app_user` id and never was. Taking it would fail the FK with a
    // Postgres type error on the app's most central action; taking the
    // actor's id records who actually created the matter.
    const row = toMatterRow({ ...input, ownerId: req.actor!.id }, ws);

    // `where matter.version = $8` on the DO UPDATE is the line most likely
    // to be read wrongly. Postgres evaluates it against the EXISTING row;
    // when it is false the statement affects no rows and RETURNING yields
    // none, which is exactly the signal wanted. (Verified against the real
    // database by `matters.pg.test.ts`'s stale-write case, not assumed: the
    // alternative reading — the clause quietly doing nothing — would make
    // every stale write succeed.)
    //
    // A record with NO version claims to be a create. `matter.version = NULL`
    // is NULL, never true, so an insert that collides with an existing row
    // is refused rather than overwriting it — which is the right answer for
    // a retried create whose first attempt actually landed.
    const rows = await db.query<MatterRow>(
      `insert into matter (id, workspace_id, name, client, reference, owner_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (id) do update set
         name = excluded.name, client = excluded.client, reference = excluded.reference,
         updated_at = now(), version = matter.version + 1
       where matter.workspace_id = $2 and matter.version = $8
       returning *`,
      [row.id, ws, row.name, row.client, row.reference, row.owner_id, row.created_at,
        input.version ?? null],
    );
    if (!rows[0]) {
      // Two situations, one shape: the row moved on (a stale write), or the
      // id belongs to another workspace (P6's id collision). Both are
      // answered with the CURRENT row when this workspace may see it and
      // with a bare conflict when it may not — never with a silent
      // overwrite, and never with a 200 over a write that did not happen.
      const current = await db.query<MatterRow>(
        'select * from matter where id = $1 and workspace_id = $2', [row.id, ws]);
      throw new ConflictError(current[0] ? fromMatterRow(current[0]) : undefined);
    }
    return fromMatterRow(rows[0]);
  });

  app.delete('/v1/matters/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    // The documents, collections and reviews go with it through
    // `on delete cascade` (002_records.sql), proven in `records.pg.test.ts`.
    // THE BLOB HALF OF THE CASCADE IS HERE, not beside here: "deleting a
    // matter deletes its documents' bytes" is a promise the README makes,
    // and a cascade split across two call sites is the half-done cascade
    // that promise exists to prevent.
    //
    // The keys are read BEFORE the rows go, because after the cascade there
    // is nothing left to derive them from. Rows first, then blobs: a blob
    // deleted before a committed row delete rolled back would leave a
    // document pointing at bytes that no longer exist — visible, and worse
    // than the leak the other order risks (`documents.ts`'s write-order
    // note is the same argument in the same direction).
    // `and kind = 'matter'` (Task 19, §11.1). Redundant today — a precedent
    // has no `matter_id` — and kept because the cascade is the one query
    // where the redundant predicate is also a statement of scope: deleting a
    // matter must never reach a precedent set's documents, which belong to a
    // playbook and outlive every matter.
    const keys = await db.query<{ blob_key: string }>(
      `select blob_key from document
       where matter_id = $1 and workspace_id = $2 and kind = 'matter'`, [id, ws]);
    const rows = await db.query<{ id: string }>(
      'delete from matter where id = $1 and workspace_id = $2 returning id', [id, ws]);
    if (!rows[0]) throw new ModelError('There is no such matter.', 'not_found', 404);
    // Every key is attempted even after one fails — `deleteBlobs` does not
    // stop at the first, because a single throw aborting the rest is the
    // likeliest way this promise ends up half-kept.
    const failed = await deleteBlobs(blobs, keys.map(k => k.blob_key));
    if (failed.length > 0) {
      // The rows are gone and committed, so this cannot be undone. Saying so
      // loudly, with the keys, is the only honest answer: a 204 over
      // surviving bytes would make the README's sentence false with nothing
      // on any screen to show it.
      throw blobDeleteFailure(failed);
    }
    await reply.code(204).send();
  });
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this matter (${detail}).`, 'unknown', 400);
}

/**
 * The body, checked rather than cast.
 *
 * The PATH's id wins over the body's, and a body that names a different one
 * is refused rather than quietly reconciled: two ids in one request is a
 * caller that does not know which record it is writing, and picking one for
 * them is how a rename lands on the wrong row.
 *
 * `ownerId` and `updatedAt` are NOT read from the body — see their notes
 * below and in the handler. Both are the server's to state.
 */
export function parseMatter(id: string, body: unknown): Matter & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== id) {
    bad(`the body's id ${JSON.stringify(b.id)} is not the one in the URL`);
  }
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) bad('name is missing or empty');
  const createdAt = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt)
    ? b.createdAt : undefined;
  if (createdAt === undefined) bad('createdAt is missing or is not a timestamp');
  if (b.version !== undefined && !Number.isInteger(b.version)) {
    bad('version is present but is not a whole number');
  }
  return {
    id,
    name,
    // ABSENT, never `client: undefined`: `absentUnless`'s rule one layer up.
    // A key present with an undefined value round-trips differently through
    // JSON and through `structuredClone`, and the two stores would then
    // disagree about whether this matter has a client at all.
    ...(typeof b.client === 'string' ? { client: b.client } : {}),
    ...(typeof b.reference === 'string' ? { reference: b.reference } : {}),
    // Read off the body and DISCARDED: the caller's claim about who owns
    // this matter is not evidence, and the handler replaces it with the
    // authenticated actor before anything is written. Present here only
    // because `Matter` requires it.
    ownerId: '',
    createdAt,
    // The server sets `updated_at` itself, as `saveMatter` always did — the
    // client's value is read and discarded rather than trusted, so a clock
    // that is wrong in a browser cannot reorder a firm's matters list.
    updatedAt: createdAt,
    ...(typeof b.version === 'number' ? { version: b.version } : {}),
  };
}
