import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Matter } from '../src/db/rows.ts';

/**
 * `matters` end to end: the REAL route, the REAL SQL, the REAL Postgres.
 *
 * §18 item 3's "every record type round-trips through Postgres" at its first
 * table, and the template for Tasks 11-15. Everything under test is
 * production code — `buildServer`, `registerMatters`, `rows.ts` — over a
 * database connection pinned to a transaction the harness always rolls back.
 * Nothing here truncates a table or assumes it is alone in the database.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-matters',
  groups: ['reviewers'],
};

/** A real `app_user` row, because `matter.owner_id` is a foreign key and a
 *  made-up uuid would fail for a reason that has nothing to do with the
 *  route under test. */
async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  put(url: string, body: unknown): Promise<Matter>;
  raw(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any;
  }>;
}

function harness(t: Tx, actorId: string, workspaceId = WS): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId,
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
      return res.json() as Matter;
    },
    raw: (method, url, body) => inject(method, url, body),
  };
}

/** Creates one matter as `actorId` and closes its server, for a test whose
 *  point is what a SECOND actor then sees. */
async function harnessAndPut(t: Tx, actorId: string, id: string): Promise<Matter> {
  const h = harness(t, actorId);
  const saved = await h.put(`/v1/matters/${id}`, {
    id, name: 'Owned', ownerId: '', createdAt: 1, updatedAt: 1,
  });
  await h.app.close();
  return saved;
}

describe('matter routes over a real Postgres', () => {
  it('round-trips a matter through Postgres, unchanged', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      const h = harness(t, owner);
      const saved = await h.put('/v1/matters/m1', {
        id: 'm1', name: 'Brookvale', client: 'Acme', reference: 'ACM-1',
        ownerId: owner, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
      });
      // `toEqual` on the WHOLE record, so a dropped field fails here rather
      // than a spot-check passing over it.
      expect(await h.get('/v1/matters/m1')).toEqual(saved);
      expect(saved.name).toBe('Brookvale');
      expect(saved.client).toBe('Acme');
      expect(saved.reference).toBe('ACM-1');
      expect(saved.ownerId).toBe(owner);
      expect(saved.createdAt).toBe(1_700_000_000_000);
      await h.app.close();
    });
  });

  it('omits an absent client and reference rather than sending them as null', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const h = harness(t, actor);
      const saved = await h.put('/v1/matters/m-bare', {
        id: 'm-bare', name: 'Bare', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      // `toEqual` cannot tell an absent key from an undefined one, so the
      // absence is asserted directly — `structuredClone` and JSON disagree
      // about a `key: undefined`, which is how two stores come to disagree
      // about whether a matter has a client at all.
      expect('client' in saved).toBe(false);
      expect('reference' in saved).toBe(false);
      await h.app.close();
    });
  });

  it('records the AUTHENTICATED actor as the owner, not whoever the body named', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const saved = await h.put('/v1/matters/m-own', {
        id: 'm-own', name: 'Owned', ownerId: someoneElse, createdAt: 1, updatedAt: 1,
      });
      // A caller's claim about who owns a matter is not evidence of who
      // does — the same rule `registerInfer` applies to the actor it
      // forwards. It is also what keeps `owner_id`'s foreign key
      // satisfiable while the browser still holds a local profile id.
      expect(saved.ownerId).toBe(actor);
      expect(saved.ownerId).not.toBe(someoneElse);
      await h.app.close();
    });
  });

  it('leaves the original owner alone when the matter is saved again', async () => {
    await withPg(async t => {
      const first = await aUser(t);
      const second = await aUser(t);
      const created = await harnessAndPut(t, first, 'm-own2');
      expect(created.ownerId).toBe(first);
      const h = harness(t, second);
      const updated = await h.put('/v1/matters/m-own2', { ...created, name: 'Renamed' });
      // Whoever created it still created it. An update that rewrote the
      // owner would let the last person to touch a matter become the person
      // who opened it, which is a fact nobody asked to change.
      expect(updated.ownerId).toBe(first);
      await h.app.close();
    });
  });

  it('sets updatedAt server-side, as saveMatter always did', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/matters/m2', {
        id: 'm2', name: 'M', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      expect(saved.updatedAt).toBeGreaterThan(1);
      await h.app.close();
    });
  });

  it('orders the list by updatedAt then seq, so a same-millisecond pair is stable', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      // Both writes land inside one transaction, so `now()` — the
      // transaction timestamp — is IDENTICAL for both and `updated_at`
      // cannot order them. Only the `seq desc` tiebreak can, which is
      // precisely the defect sub-project A added `_seq` to fix and which
      // would be lost SILENTLY here, because the list would still render.
      await h.put('/v1/matters/aaa', { id: 'aaa', name: 'A', ownerId: '', createdAt: 1, updatedAt: 1 });
      await h.put('/v1/matters/bbb', { id: 'bbb', name: 'B', ownerId: '', createdAt: 1, updatedAt: 1 });
      const list = await h.get('/v1/matters') as Matter[];
      expect(list[0].updatedAt).toBe(list[1].updatedAt);
      expect(list.map(m => m.id).slice(0, 2)).toEqual(['bbb', 'aaa']);
      await h.app.close();
    });
  });

  it('answers 404 for a matter that does not exist, not 200 with null', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('GET', '/v1/matters/nope');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      await h.app.close();
    });
  });

  it('refuses a stale write with 409 and returns the current row (P9)', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const first = await h.put('/v1/matters/m3', {
        id: 'm3', name: 'First', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      expect(first.version).toBe(1);
      const second = await h.put('/v1/matters/m3', { ...first, name: 'Renamed' });
      expect(second.version).toBe(2);

      const res = await h.raw('PUT', '/v1/matters/m3', { ...first, name: 'From a stale tab' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
      // The current row travels WITH the refusal, so Stage 4's "here is what
      // replaced it" needs no second round trip and no second mechanism.
      expect(res.json().current.name).toBe('Renamed');
      // …and the stale write did not land. The assertion that actually
      // matters: a 409 that had already overwritten the row would be worse
      // than a 200.
      expect((await h.get('/v1/matters/m3')).name).toBe('Renamed');
      await h.app.close();
    });
  });

  it('refuses a create over an id that already exists, rather than overwriting it', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.put('/v1/matters/m4', { id: 'm4', name: 'Original', ownerId: '', createdAt: 1, updatedAt: 1 });
      // No `version` at all — the claim a freshly minted `newMatter` makes.
      const res = await h.raw('PUT', '/v1/matters/m4', {
        id: 'm4', name: 'A retried create', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      expect(res.statusCode).toBe(409);
      expect((await h.get('/v1/matters/m4')).name).toBe('Original');
      await h.app.close();
    });
  });

  it('never lets a record be read or written across workspaces', async () => {
    // On the MIGRATOR connection because the app role holds only SELECT on
    // `workspace` (001_identity.sql) — the foreign workspace has to be
    // created to be scoped away from, and the grant that stops a request
    // creating one is proved by `grants.pg.test.ts`, not weakened here. It
    // is still inside the transaction the harness rolls back, so no row
    // survives this test: a suite that leaves a second workspace behind is
    // the "assumes it is alone" failure one table over.
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at)
         values ('foreign', $1, 'Theirs', now(), now())`, [OTHER_WS]);
      const h = harness(t, await aUser(t));

      // NOT FOUND, not FORBIDDEN: a 403 would confirm the id exists
      // somewhere, which is a fact this workspace is not entitled to.
      expect((await h.raw('GET', '/v1/matters/foreign')).statusCode).toBe(404);
      expect((await h.get('/v1/matters') as Matter[]).map(m => m.id)).not.toContain('foreign');

      // …and a WRITE to the same id is a conflict, not a silent takeover.
      const res = await h.raw('PUT', '/v1/matters/foreign', {
        id: 'foreign', name: 'Mine now', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      expect(res.statusCode).toBe(409);
      // With NO `current`: the other workspace's row is not ours to show.
      expect('current' in res.json()).toBe(false);
      const still = await t.query<{ name: string }>(
        "select name from matter where id = 'foreign'");
      expect(still[0].name).toBe('Theirs');

      // …and a DELETE cannot reach it either.
      expect((await h.raw('DELETE', '/v1/matters/foreign')).statusCode).toBe(404);
      expect((await t.query("select 1 from matter where id = 'foreign'")).length).toBe(1);
      await h.app.close();
    }, migratorDb());
  });

  it('deletes a matter and its documents, collections and reviews, and says nothing survived', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      const h = harness(t, owner);
      await h.put('/v1/matters/m5', { id: 'm5', name: 'Doomed', ownerId: owner, createdAt: 1, updatedAt: 1 });
      await t.query(
        `insert into document (id, workspace_id, matter_id, name, doc_type, text, parse_state,
                               byte_size, mime, blob_key, role, added_at)
         values ('d5', $1, 'm5', 'Lease.pdf', 'pdf', 'x', 'parsed', 10, 'application/pdf',
                 $2, 'standalone', now())`, [WS, `workspace/${WS}/document/d5`]);
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id, created_at)
         values ('c5', $1, 'm5', 'Lease + DoV', 'd5', now())`, [WS]);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, model_id, started_at)
         values ('r5', $1, 'm5', '{}'::jsonb, '{}'::jsonb, 'm', now())`, [WS]);

      const res = await h.raw('DELETE', '/v1/matters/m5');
      expect(res.statusCode).toBe(204);

      expect((await h.raw('GET', '/v1/matters/m5')).statusCode).toBe(404);
      for (const table of ['document', 'collection', 'review']) {
        const left = await t.query(`select 1 from ${table} where matter_id = 'm5'`);
        expect(left.length, `${table} rows survived the cascade`).toBe(0);
      }
      // A second delete is a 404, not a silent 204: "there was nothing to
      // delete" and "I deleted it" are different answers.
      expect((await h.raw('DELETE', '/v1/matters/m5')).statusCode).toBe(404);
      await h.app.close();
    });
  });

  it('refuses a malformed record with 400 and writes nothing', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/matters/m6', { id: 'm6', ownerId: '', createdAt: 1 });
      expect(res.statusCode).toBe(400);
      expect((await t.query("select 1 from matter where id = 'm6'")).length).toBe(0);

      // A body naming a different id is refused rather than reconciled.
      const mismatched = await h.raw('PUT', '/v1/matters/m6', {
        id: 'somewhere-else', name: 'X', ownerId: '', createdAt: 1, updatedAt: 1,
      });
      expect(mismatched.statusCode).toBe(400);
      await h.app.close();
    });
  });

  it('encodes an id with URL-significant characters rather than losing it', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const id = 'a/b c?d';
      const path = `/v1/matters/${encodeURIComponent(id)}`;
      const saved = await h.put(path, { id, name: 'Odd', ownerId: '', createdAt: 1, updatedAt: 1 });
      expect(saved.id).toBe(id);
      expect((await h.get(path) as Matter).id).toBe(id);
      await h.app.close();
    });
  });
});
