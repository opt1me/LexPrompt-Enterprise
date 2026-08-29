import type { FastifyInstance } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import {
  fromCollectionRow, toCollectionRow, type Collection, type CollectionRow,
} from '../db/rows.ts';
import { refuseForeignDocuments } from './matterMembership.ts';

/**
 * The `collections` repository, server side — Task 9's seven properties
 * (`matters.ts`) applied unchanged, plus the two rules this table carries.
 *
 * ## `variesDocumentIds` is an ORDER, and nothing here may re-derive it
 *
 * `orderedMembers` is the only place collection reading order is decided,
 * and `documentDate` never sorts it (CLAUDE.md, ruling R-C3). A date can be
 * missing, wrong or ambiguous; the order in which amendments take effect is
 * a legal judgement someone recorded when they built the collection. The
 * column is a `jsonb` ARRAY with a `jsonb_typeof(...) = 'array'` check, so a
 * collection whose amendments arrive keyed rather than ordered fails loudly
 * rather than silently losing the order a person chose — and there is no
 * `order by` anywhere in this module that names `document_date`, which
 * `collections.pg.test.ts` scans this source to confirm.
 *
 * ## Grouping stays NON-ATOMIC, deliberately
 *
 * `Collection.baseDocumentId`/`variesDocumentIds` is authoritative;
 * `document.role` is a denormalised convenience written by a SEPARATE call
 * (`setDocumentRole`, one route over), so the two can briefly disagree.
 * CLAUDE.md documents that as expected, and `002_records.sql` deliberately
 * gives `document.collection_id` no foreign key because an enforced one
 * would reject exactly that.
 *
 * Postgres could now close that window — one route, one transaction, writing
 * the collection record and its members' roles together. **This task does
 * not, and the refusal is the point.** Doing it would make `role`
 * authoritative-in-practice while every reader still treats it as
 * denormalised, and the next person to write a query would have no way to
 * tell which rule now applies. It is recorded as a Stage 3 candidate: the
 * grouping call becomes one route with one transaction when the collection
 * UI is next touched, and the rule in CLAUDE.md changes in the same commit.
 */
export function registerCollections(app: FastifyInstance, db: Db): void {
  app.get('/v1/matters/:id/collections', async (req): Promise<Collection[]> => {
    const { id } = req.params as { id: string };
    // Most recently created first, tiebroken on write sequence descending —
    // the order `listCollections` sorted for itself, moved to where the
    // database can do it. `seq` is what breaks a same-millisecond tie;
    // `created_at` alone orders such a pair arbitrarily and would lose it
    // SILENTLY, because the list would still render.
    const rows = await db.query<CollectionRow>(
      `select * from collection where matter_id = $1 and workspace_id = $2
       order by created_at desc, seq desc`,
      [id, req.actor!.workspaceId],
    );
    return rows.map(fromCollectionRow);
  });

  app.get('/v1/collections/:id', async (req): Promise<Collection> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<CollectionRow>(
      'select * from collection where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId],
    );
    if (!rows[0]) throw new ModelError('There is no such collection.', 'not_found', 404);
    return fromCollectionRow(rows[0]);
  });

  // NOT `app.put<{ Params: … }>(…)` — see `matters.ts`'s note on the inline
  // generic and `oidc.test.ts`'s no-bypass scanner.
  app.put('/v1/collections/:id', async (req): Promise<Collection> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const input = parseCollection(id, req.body);

    // The matter, IN THIS WORKSPACE, before anything is written. A
    // collection whose matter is somebody else's is 404 rather than 403: a
    // 403 would confirm the matter id exists somewhere.
    const matter = await db.query<{ id: string }>(
      'select id from matter where id = $1 and workspace_id = $2', [input.matterId, ws]);
    if (!matter[0]) {
      throw new ModelError(
        `There is no matter ${input.matterId} to put this collection in.`, 'not_found', 404);
    }

    // Every document this collection NAMES must be in that same matter —
    // the check `PUT /v1/reviews/:id` already made, and the sibling that
    // did not make it (Part 2A m2). The column deliberately carries no
    // foreign key (grouping and ungrouping write the collection record and
    // each member's `role` non-atomically, so an FK would refuse the
    // intermediate state), which means nothing below this line would notice
    // a member from another matter — and a review over such a collection is
    // then refused on every save, blaming the review.
    //
    // Scoped to ids being INTRODUCED, exactly as the review route is and for
    // the same reason: a member document deleted from the matter afterwards
    // must not make an existing collection unsaveable. `baseDocumentId` and
    // `variesDocumentIds` together, because both are member ids and checking
    // one leaves the other free.
    const named = [
      ...(input.baseDocumentId ? [input.baseDocumentId] : []),
      ...input.variesDocumentIds,
    ];
    if (named.length > 0) {
      const held = await db.query<{ base_document_id: string | null; varies_document_ids: unknown }>(
        'select base_document_id, varies_document_ids from collection where id = $1 and workspace_id = $2',
        [id, ws]);
      const already = new Set<string>();
      if (held[0]) {
        if (held[0].base_document_id) already.add(held[0].base_document_id);
        const varies = typeof held[0].varies_document_ids === 'string'
          ? JSON.parse(held[0].varies_document_ids) as unknown
          : held[0].varies_document_ids;
        if (Array.isArray(varies)) {
          for (const v of varies) if (typeof v === 'string') already.add(v);
        }
      }
      const introduced = [...new Set(named)].filter(docId => !already.has(docId));
      if (introduced.length > 0) {
        // `and kind = 'matter'` (Task 19, §11.1). A precedent document can
        // never be a collection member — base or varies — and the refusal
        // NAMES it as a precedent rather than answering a generic "not in
        // this matter" that would send someone hunting for a file they can
        // see on the playbook side of the app. Redundant today, since
        // `matter_id` is nullable and a precedent's is NULL; kept because
        // relying on that is the convention S23 refuses.
        const found = await db.query<{ id: string }>(
          `select id from document
           where workspace_id = $1 and matter_id = $2 and kind = 'matter'
             and id = any($3::text[])`,
          [ws, input.matterId, introduced]);
        if (found.length !== introduced.length) {
          const missing = introduced.filter(docId => !found.some(r => r.id === docId));
          throw await refuseForeignDocuments(db, ws, missing, 'collection');
        }
      }
    }

    // THE ATTRIBUTION COMES FROM THE TOKEN, NEVER FROM THE BODY (property 3),
    // and only on the INSERT — `created_by_user_id` is not in the DO UPDATE
    // list, because whoever built this collection still built it and the last
    // person to rename it does not become its author.
    const row = toCollectionRow({ ...input, createdByUserId: req.actor!.id }, ws);
    // `where collection.version = $8` on the DO UPDATE is evaluated against
    // the EXISTING row; when it is false the statement affects no rows and
    // RETURNING yields none, which is the signal wanted. A record with NO
    // version claims to be a create, and `collection.version = NULL` is NULL
    // rather than true, so a create that collides is refused rather than
    // overwriting. See `matters.ts` for the long form.
    const rows = await db.query<CollectionRow>(
      `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                               varies_document_ids, created_at, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $9)
       on conflict (id) do update set
         name = excluded.name, base_document_id = excluded.base_document_id,
         varies_document_ids = excluded.varies_document_ids,
         version = collection.version + 1
       where collection.workspace_id = $2 and collection.version = $8
       returning *`,
      [row.id, ws, row.matter_id, row.name, row.base_document_id, row.varies_document_ids,
        row.created_at, input.version ?? null, row.created_by_user_id],
    );
    if (!rows[0]) {
      const current = await db.query<CollectionRow>(
        'select * from collection where id = $1 and workspace_id = $2', [row.id, ws]);
      throw new ConflictError(current[0] ? fromCollectionRow(current[0]) : undefined);
    }
    return fromCollectionRow(rows[0]);
  });

  app.delete('/v1/collections/:id', async (req, reply): Promise<void> => {
    const { id } = req.params as { id: string };
    // ONLY the collection record. Member documents are untouched — clearing
    // their `role`/`collectionId` is a matter-level operation over documents
    // (the ungroup path), not something this record-scoped delete does on
    // their behalf, exactly as the IndexedDB version did not.
    const rows = await db.query<{ id: string }>(
      'delete from collection where id = $1 and workspace_id = $2 returning id',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such collection.', 'not_found', 404);
    await reply.code(204).send();
  });
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this collection (${detail}).`, 'unknown', 400);
}

/**
 * The body, checked rather than cast.
 *
 * The PATH's id wins and a body naming a different one is refused rather
 * than quietly reconciled — two ids in one request is a caller that does not
 * know which record it is writing.
 *
 * `variesDocumentIds` must be an ARRAY OF STRINGS and is kept in the order
 * it arrived. Nothing here sorts, de-duplicates or normalises it: a
 * de-duplication would silently drop an amendment that legitimately appears
 * twice, and a sort would replace a legal judgement with an alphabetical
 * one.
 */
export function parseCollection(id: string, body: unknown): Collection & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== id) {
    bad(`the body's id ${JSON.stringify(b.id)} is not the one in the URL`);
  }
  const matterId = typeof b.matterId === 'string' ? b.matterId.trim() : '';
  if (!matterId) bad('matterId is missing or empty');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) bad('name is missing or empty');
  const baseDocumentId = typeof b.baseDocumentId === 'string' ? b.baseDocumentId.trim() : '';
  if (!baseDocumentId) bad('baseDocumentId is missing or empty');
  if (!Array.isArray(b.variesDocumentIds)) {
    // A collection whose amendments arrive keyed rather than ordered is not a
    // collection, and accepting one would lose the order a person chose with
    // nothing on screen to show it.
    bad('variesDocumentIds is missing or is not an array');
  }
  if (!b.variesDocumentIds.every(v => typeof v === 'string' && v !== '')) {
    bad('variesDocumentIds contains something that is not a document id');
  }
  const createdAt = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt)
    ? b.createdAt : undefined;
  if (createdAt === undefined) bad('createdAt is missing or is not a timestamp');
  if (b.version !== undefined && !Number.isInteger(b.version)) {
    bad('version is present but is not a whole number');
  }
  return {
    id,
    matterId,
    name,
    baseDocumentId,
    variesDocumentIds: b.variesDocumentIds as string[],
    createdAt,
    // Read off the body and DISCARDED — the handler replaces it with the
    // authenticated actor. Present here only because `Collection` requires it.
    createdByUserId: '',
    ...(typeof b.version === 'number' ? { version: b.version } : {}),
  };
}
