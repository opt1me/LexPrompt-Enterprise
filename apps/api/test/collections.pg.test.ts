import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { ROOT, codeOf } from './sourceScan.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Collection } from '../src/db/rows.ts';

/**
 * `collections` end to end: the REAL route, the REAL SQL, the REAL Postgres.
 *
 * Task 9's six cases (round-trip, ordering, 404, stale-write 409,
 * cross-workspace, delete) plus the two rules only this table carries: the
 * member ORDER is preserved exactly and is never re-derived, and grouping
 * stays deliberately non-atomic with `document.role`.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-collections',
  groups: ['reviewers'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

async function aMatter(t: Tx, id = 'm1', ws = WS): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now())`, [id, ws]);
}

const BASE = {
  id: 'c1', matterId: 'm1', name: 'Lease + two DoVs', baseDocumentId: 'd-base',
  variesDocumentIds: ['d-a', 'd-b'], createdAt: 1_700_000_000_000, createdByUserId: '',
};

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  put(url: string, body: unknown): Promise<Collection>;
  raw(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    async get(url) {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    async put(url, body) {
      const res = await inject('PUT', url, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Collection;
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

describe('collection routes over a real Postgres', () => {
  it('round-trips a collection through Postgres, unchanged', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/collections/c1', BASE);
      // `toEqual` on the WHOLE record, so a dropped field fails here rather
      // than a spot-check passing over it.
      expect(await h.get('/v1/collections/c1')).toEqual(saved);
      expect(saved.name).toBe('Lease + two DoVs');
      expect(saved.baseDocumentId).toBe('d-base');
      expect(saved.createdAt).toBe(1_700_000_000_000);
      await h.app.close();
    });
  });

  it('preserves variesDocumentIds ORDER exactly, including a reordering that is not a sort', async () => {
    // R-C3 / `orderedMembers`: the order amendments take effect is a legal
    // judgement someone recorded, not something to re-derive. `['d3','d1','d2']`
    // is neither sorted nor reverse-sorted, so a jsonb array that came back
    // ordered by anything at all would fail here.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/collections/c1',
        { ...BASE, variesDocumentIds: ['d3', 'd1', 'd2'] });
      expect(saved.variesDocumentIds).toEqual(['d3', 'd1', 'd2']);
      expect((await h.get('/v1/collections/c1') as Collection).variesDocumentIds)
        .toEqual(['d3', 'd1', 'd2']);

      // …and a REORDER of the same members is stored as the reorder it is,
      // not discarded as "the same set".
      const reordered = await h.put('/v1/collections/c1',
        { ...saved, variesDocumentIds: ['d2', 'd3', 'd1'] });
      expect(reordered.variesDocumentIds).toEqual(['d2', 'd3', 'd1']);
      await h.app.close();
    });
  });

  it('keeps a repeated member rather than de-duplicating it, and an empty list rather than a null', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const dup = await h.put('/v1/collections/c1', { ...BASE, variesDocumentIds: ['d-a', 'd-a'] });
      expect(dup.variesDocumentIds).toEqual(['d-a', 'd-a']);
      const bare = await h.put('/v1/collections/c2',
        { ...BASE, id: 'c2', variesDocumentIds: [] });
      expect(bare.variesDocumentIds).toEqual([]);
      await h.app.close();
    });
  });

  it('refuses a collection whose members arrive keyed rather than ordered', async () => {
    // A collection whose amendments are an object is not a collection, and
    // accepting one would lose the order a person chose with nothing on
    // screen to show it.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/collections/c1',
        { ...BASE, variesDocumentIds: { first: 'd-a', second: 'd-b' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/variesDocumentIds/);
      expect((await t.query("select 1 from collection where id = 'c1'")).length).toBe(0);
      await h.app.close();
    });
  });

  it('never orders members by documentDate, at the wire or in SQL', () => {
    // `documentDate` is DISPLAYED and never governs order. A source scan,
    // because the mistake this table invites is a helpful `order by` that
    // every test of the feature would still pass.
    const source = codeOf(path.join(ROOT, 'apps/api/src/routes/collections.ts'));
    expect(source).not.toMatch(/order\s+by[^;]*document_date/i);
    // …with the companion positive assertion, or the above passes vacuously
    // over a file that no longer mentions members at all.
    expect(source).toMatch(/varies_document_ids/);
  });

  it('records the AUTHENTICATED actor as the author, not whoever the body named', async () => {
    await withPg(async t => {
      await aMatter(t);
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const saved = await h.put('/v1/collections/c1', { ...BASE, createdByUserId: someoneElse });
      expect(saved.createdByUserId).toBe(actor);
      await h.app.close();
    });
  });

  it('leaves the original author alone when the collection is saved again', async () => {
    await withPg(async t => {
      await aMatter(t);
      const first = await aUser(t);
      const second = await aUser(t);
      const h1 = harness(t, first);
      const created = await h1.put('/v1/collections/c1', BASE);
      await h1.app.close();
      const h2 = harness(t, second);
      const renamed = await h2.put('/v1/collections/c1', { ...created, name: 'Renamed' });
      // Whoever built it still built it. An update that rewrote the author
      // would let the last person to touch a collection become the person
      // whose legal judgement its ordering records.
      expect(renamed.createdByUserId).toBe(first);
      await h2.app.close();
    });
  });

  it('orders the list by createdAt then seq, so a same-millisecond pair is stable', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.put('/v1/collections/aaa', { ...BASE, id: 'aaa', createdAt: 5_000 });
      await h.put('/v1/collections/bbb', { ...BASE, id: 'bbb', createdAt: 5_000 });
      const list = await h.get('/v1/matters/m1/collections') as Collection[];
      expect(list[0].createdAt).toBe(list[1].createdAt);
      // Only the `seq desc` tiebreak can order these, which is precisely
      // what `_seq` existed for and what would be lost SILENTLY here.
      expect(list.map(c => c.id)).toEqual(['bbb', 'aaa']);
      await h.app.close();
    });
  });

  it('lists only the requested matter s collections', async () => {
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aMatter(t, 'm2');
      const h = harness(t, await aUser(t));
      await h.put('/v1/collections/c1', BASE);
      await h.put('/v1/collections/c2', { ...BASE, id: 'c2', matterId: 'm2' });
      expect((await h.get('/v1/matters/m1/collections') as Collection[]).map(c => c.id))
        .toEqual(['c1']);
      await h.app.close();
    });
  });

  it('answers 404 for a collection that does not exist, not 200 with null', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('GET', '/v1/collections/nope');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      await h.app.close();
    });
  });

  it('refuses a stale write with 409 and returns the current row (P9)', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const first = await h.put('/v1/collections/c1', BASE);
      expect(first.version).toBe(1);
      const second = await h.put('/v1/collections/c1',
        { ...first, variesDocumentIds: ['d-b', 'd-a'] });
      expect(second.version).toBe(2);

      const res = await h.raw('PUT', '/v1/collections/c1',
        { ...first, variesDocumentIds: ['d-a'] });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
      expect(res.json().current.variesDocumentIds).toEqual(['d-b', 'd-a']);
      // …and the stale write did NOT land. A reordering silently overwritten
      // by a stale tab is a legal judgement replaced without anyone knowing.
      expect((await h.get('/v1/collections/c1') as Collection).variesDocumentIds)
        .toEqual(['d-b', 'd-a']);
      await h.app.close();
    });
  });

  it('refuses a create over an id that already exists, rather than overwriting it', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.put('/v1/collections/c1', BASE);
      // No `version` at all — the claim `newCollection` makes.
      const res = await h.raw('PUT', '/v1/collections/c1', { ...BASE, name: 'A retried create' });
      expect(res.statusCode).toBe(409);
      expect((await h.get('/v1/collections/c1') as Collection).name).toBe('Lease + two DoVs');
      await h.app.close();
    });
  });

  it('refuses a collection whose matter is in another workspace, and writes nothing', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/collections/c1', { ...BASE, matterId: 'theirs' });
      expect(res.statusCode).toBe(404);
      expect((await t.query("select 1 from collection where id = 'c1'")).length).toBe(0);
      await h.app.close();
    }, migratorDb());
  });

  it('never lets a collection be read, written or deleted across workspaces', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id, created_at)
         values ('foreign', $1, 'theirs', 'Theirs', 'd', now())`, [OTHER_WS]);
      await aMatter(t, 'm1');
      const h = harness(t, await aUser(t));

      // NOT FOUND, not FORBIDDEN.
      expect((await h.raw('GET', '/v1/collections/foreign')).statusCode).toBe(404);
      expect((await h.get('/v1/matters/m1/collections') as Collection[]).map(c => c.id))
        .not.toContain('foreign');

      const res = await h.raw('PUT', '/v1/collections/foreign', { ...BASE, id: 'foreign' });
      expect(res.statusCode).toBe(409);
      // With NO `current`: the other workspace's row is not ours to show.
      expect('current' in res.json()).toBe(false);
      const still = await t.query<{ name: string }>(
        "select name from collection where id = 'foreign'");
      expect(still[0].name).toBe('Theirs');

      expect((await h.raw('DELETE', '/v1/collections/foreign')).statusCode).toBe(404);
      expect((await t.query("select 1 from collection where id = 'foreign'")).length).toBe(1);
      await h.app.close();
    }, migratorDb());
  });

  it('deletes the collection record and LEAVES its member documents alone', async () => {
    // Unchanged by the move, and deliberately: clearing a member's
    // `role`/`collectionId` is a matter-level operation over documents, not
    // something this record-scoped delete does on their behalf.
    // `document.collection_id` carries no foreign key for the same reason.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.put('/v1/collections/c1', BASE);
      await t.query(
        `insert into document (id, workspace_id, matter_id, name, doc_type, text, parse_state,
                               byte_size, mime, blob_key, role, collection_id, added_at)
         values ('d-a', $1, 'm1', 'DoV.pdf', 'pdf', 'x', 'parsed', 4, 'application/pdf',
                 'k', 'varies', 'c1', now())`, [WS]);

      expect((await h.raw('DELETE', '/v1/collections/c1')).statusCode).toBe(204);
      const doc = await t.query<{ role: string; collection_id: string | null }>(
        'select role, collection_id from document where id = $1 and workspace_id = $2', ['d-a', WS]);
      expect(doc[0].role).toBe('varies');
      expect(doc[0].collection_id).toBe('c1');
      // A second delete is a 404, not a silent 204.
      expect((await h.raw('DELETE', '/v1/collections/c1')).statusCode).toBe(404);
      await h.app.close();
    });
  });

  it('encodes an id with URL-significant characters rather than losing it', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const id = 'a/b c?d';
      const url = `/v1/collections/${encodeURIComponent(id)}`;
      const saved = await h.put(url, { ...BASE, id });
      expect(saved.id).toBe(id);
      expect((await h.get(url) as Collection).id).toBe(id);
      await h.app.close();
    });
  });
});
