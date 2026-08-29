import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { makeDb, type Db, type Tx } from '../src/db/pool.ts';
import type { Playbook, PlaybookVersion } from '../src/db/rows.ts';

/**
 * `playbooks` and `playbookVersions` end to end, against a real Postgres.
 *
 * The centre of this file is the transaction: publishing a version and
 * pointing the playbook at it happen together or not at all. Everything else
 * — the version-number allocation, the change-summary rule, the partner
 * gate, the delete cascade — is here because it lives inside or beside that
 * transaction and cannot be proved anywhere cheaper.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-playbooks',
  groups: ['partners'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'partner', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

const IDENTITY = {
  id: 'p1', name: 'Commercial Lease — Tenant', createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000, schemaVersion: 7,
};

const DRAFT = {
  name: 'Commercial Lease — Tenant',
  contractType: 'Lease',
  systemPrompt: 'Be careful.',
  formatPrompt: 'Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Break', extractPrompt: 'What is the break right?' }],
  changeSummary: '',
};

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  publish(id: string, draft?: unknown, identity?: unknown): Promise<{
    playbook: Playbook; version: PlaybookVersion;
  }>;
  raw(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string, opts: {
  db?: Db; role?: 'reviewer' | 'partner' | 'admin';
} = {}): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: opts.db ?? dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Partner', initials: 'TP',
      role: opts.role ?? 'partner', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    async get(url) {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    async publish(id, draft = DRAFT, identity = { ...IDENTITY, id }) {
      const res = await inject('POST', `/v1/playbooks/${id}/versions`, { playbook: identity, draft });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { playbook: Playbook; version: PlaybookVersion };
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

describe('publishing a version and pointing the playbook at it', () => {
  it('does both, or neither', async () => {
    // `publishAndPoint`'s own docstring: two separate transactions left an
    // orphaned version on any failure between them, and for an imported
    // playbook an orphan with NO identity record at all — permanently
    // unreachable, since nothing but the startup migration adopts orphans
    // and that only looks at playbooks that still exist.
    await withPg(async t => {
      const real = dbOn(t);
      const failing: Db = {
        query: (text, values) => real.query(text as never, values),
        // Every statement runs for real EXCEPT the one that points the
        // playbook at the version it just published — the exact window the
        // two-transaction version failed in.
        tx: run => real.tx(inner => run({
          query: async <R>(text: string, values?: unknown[]): Promise<R[]> => {
            if (/update playbook set current_version_id/i.test(text)) {
              throw new Error('the database fell over between the two writes');
            }
            return inner.query<R>(text as never, values);
          },
          tx: r => inner.tx(r),
        })),
      };
      const h = harness(t, await aUser(t), { db: failing });
      const res = await h.raw('POST', '/v1/playbooks/p1/versions',
        { playbook: IDENTITY, draft: DRAFT });
      expect(res.statusCode).toBe(500);

      // NEITHER. Not the version…
      const versions = await t.query(
        'select 1 from playbook_version where playbook_id = $1 and workspace_id = $2', ['p1', WS]);
      expect(versions.length, 'an orphaned version survived a failed publish').toBe(0);
      // …and not the identity the same transaction upserted, which is the
      // WORSE orphan: a version with no playbook record at all.
      const identity = await t.query(
        'select 1 from playbook where id = $1 and workspace_id = $2', ['p1', WS]);
      expect(identity.length, 'a half-created playbook survived a failed publish').toBe(0);
      await h.app.close();
    });
  });

  it('publishes a playbook that does not exist yet, identity and v1 together', async () => {
    // `saveDraftAsV1` and `importPlaybook` both hand over an identity that
    // is not stored anywhere. A route that answered 404 for that would have
    // removed the feature while passing every test written for a playbook
    // that already exists.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { playbook, version } = await h.publish('p-new');
      expect(playbook.id).toBe('p-new');
      expect(playbook.currentVersionId).toBe(version.id);
      expect(version.version).toBe(1);
      expect(await h.get('/v1/playbooks/p-new/content')).toEqual(version);
      await h.app.close();
    });
  });

  it('mints a fresh id on every publish and never reuses one', async () => {
    // Immutability is a property of how ids are allocated, not a check that
    // could be forgotten. Two publishes of byte-identical content produce
    // two versions with two ids.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const a = await h.publish('p1');
      const b = await h.publish('p1', { ...DRAFT, changeSummary: 'Same words, new version.' },
        { ...IDENTITY, version: a.playbook.version });
      expect(b.version.id).not.toBe(a.version.id);
      expect(b.version.version).toBe(a.version.version + 1);
      // …and v1 is still exactly what it was. The app role holds INSERT but
      // not UPDATE on `playbook_version`, so this is the database's rule.
      expect(await h.get(`/v1/versions/${a.version.id}`)).toEqual(a.version);
      await h.app.close();
    });
  });

  it('refuses to overwrite a published version even with a direct UPDATE (P10)', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const a = await h.publish('p1');
      await expect(
        t.query('update playbook_version set summary = $2 where id = $1', [a.version.id, 'edited']),
      ).rejects.toThrow(/permission denied/i);
      await h.app.close();
    });
  });

  it('refuses a version after v1 with no change summary, and publishes nothing', async () => {
    // D's rule, carried over: a version history whose entries do not say
    // what changed is a list of dates. Refused by the API as well as by the
    // dialog, because a hidden dialog field is not a control.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const first = await h.publish('p1');
      const res = await h.raw('POST', '/v1/playbooks/p1/versions', {
        playbook: { ...IDENTITY, version: first.playbook.version },
        draft: { ...DRAFT, changeSummary: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/what changed/i);
      const numbers = await t.query<{ version_number: number }>(
        'select version_number from playbook_version where playbook_id = $1 and workspace_id = $2',
        ['p1', WS]);
      expect(numbers.map(n => n.version_number)).toEqual([1]);
      // …and the playbook still points at v1, not at nothing.
      expect((await h.get('/v1/playbooks/p1') as Playbook).currentVersionId)
        .toBe(first.version.id);
      await h.app.close();
    });
  });

  it('v1 is exempt from the change summary, because there is nothing for it to have changed from', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1', { ...DRAFT, changeSummary: '' });
      expect(version.version).toBe(1);
      expect(version.changeSummary).toBe('');
      await h.app.close();
    });
  });

  it('publishing CONSUMES the draft, so the library stops reading unpublished changes', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const saved = await h.raw('PUT', '/v1/playbooks/p1', { ...IDENTITY, draft: DRAFT });
      expect(saved.statusCode).toBe(200);
      expect('draft' in saved.json()).toBe(true);
      const { playbook } = await h.publish('p1', DRAFT, { ...IDENTITY, version: saved.json().version });
      // ABSENT, not `draft: undefined` — `'draft' in playbook` is how "has
      // unpublished changes" is asked.
      expect('draft' in playbook).toBe(false);
      expect('draft' in (await h.get('/v1/playbooks/p1'))).toBe(false);
      await h.app.close();
    });
  });

  it('records the AUTHENTICATED actor as the publisher, not whoever the body named', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const { version } = await h.publish('p1',
        { ...DRAFT, publishedByUserId: someoneElse } as never);
      expect(version.publishedByUserId).toBe(actor);
      await h.app.close();
    });
  });

  it('refuses a REVIEWER, and allows a partner', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const reviewer = harness(t, actor, { role: 'reviewer' });
      const res = await reviewer.raw('POST', '/v1/playbooks/p1/versions',
        { playbook: IDENTITY, draft: DRAFT });
      expect(res.statusCode).toBe(403);
      // …and nothing was written by the refused call.
      expect((await t.query("select 1 from playbook where id = 'p1'")).length).toBe(0);
      await reviewer.app.close();

      const partner = harness(t, actor, { role: 'partner' });
      expect((await partner.raw('POST', '/v1/playbooks/p1/versions',
        { playbook: IDENTITY, draft: DRAFT })).statusCode).toBeLessThan(400);
      await partner.app.close();
    });
  });

  it('an import publishes an identity and its v1 together, or not at all', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('POST', '/v1/playbooks/import',
        { playbook: { ...IDENTITY, id: 'p-imported' }, draft: DRAFT });
      expect(res.statusCode).toBe(200);
      const { playbook, version } = res.json() as { playbook: Playbook; version: PlaybookVersion };
      expect(playbook.currentVersionId).toBe(version.id);
      // P16: a playbook imported from a file was written by whoever wrote
      // the file, so nothing claims authorship of its CONTENT.
      const owner = await t.query<{ created_by_user_id: string | null }>(
        'select created_by_user_id from playbook where id = $1 and workspace_id = $2',
        ['p-imported', WS]);
      expect(owner[0].created_by_user_id).toBeNull();
      await h.app.close();
    });
  });

  it('refuses a REVIEWER an import, because an import publishes a v1', async () => {
    // A door around the partner gate is not a gate (R-E8).
    await withPg(async t => {
      const h = harness(t, await aUser(t), { role: 'reviewer' });
      expect((await h.raw('POST', '/v1/playbooks/import',
        { playbook: IDENTITY, draft: DRAFT })).statusCode).toBe(403);
      await h.app.close();
    });
  });
});

/**
 * The concurrency case, on TWO REAL CONNECTIONS.
 *
 * `withPg` pins one client, so two awaited calls on it are serialised by
 * construction and would prove nothing about a race — the brief's own
 * warning, and it is right. This suite opens its own pool instead, commits
 * for real, and cleans up after itself in a `finally`.
 */
describe('two publishes racing for the same version number', () => {
  it('allocates version numbers with no gap and no duplicate', async () => {
    const pool = new Pool({ connectionString: process.env.LEXPROMPT_TEST_DATABASE_URL!, max: 4 });
    // The app role can INSERT an `app_user` (that is how provisioning works)
    // but holds no DELETE on it — so the throwaway actor this suite needs is
    // created and removed on the MIGRATOR connection. A suite that commits
    // has to be able to undo everything it wrote, and "the app role happens
    // to be able to write it" is not the same as "the app role can clean it
    // up".
    const adminPool = new Pool({
      connectionString: process.env.LEXPROMPT_TEST_MIGRATION_URL!, max: 2 });
    const db = makeDb(pool);
    const admin = makeDb(adminPool);
    const id = `p-race-${Date.now().toString(36)}`;
    let actorId = '';
    try {
      const users = await admin.query<{ id: string }>(
        `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
         values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'R', 'R', 'partner', 'active')
         returning id`, [WS]);
      actorId = users[0].id;

      const { app } = buildTestApi({
        principal: PRINCIPAL, db,
        actor: {
          id: actorId, displayName: 'Racer', initials: 'R',
          role: 'partner', workspaceId: WS,
        },
      });
      const publish = (summary: string) => app.inject({
        method: 'POST', url: `/v1/playbooks/${id}/versions`,
        headers: { authorization: 'Bearer t' },
        payload: { playbook: { ...IDENTITY, id }, draft: { ...DRAFT, changeSummary: summary } } as never,
      });

      // v1 first, so both racers are competing for v2 — the case where a
      // shared `max(version_number)` read produces two rows claiming to be
      // the same version.
      await publish('');
      const [a, b] = await Promise.all([publish('one'), publish('two')]);

      // BOTH SUCCEED, and that is the assertion the lock is actually for.
      //
      // Found by mutation, and worth writing down because the obvious
      // assertion is the wrong one: "no duplicate version number" is
      // guaranteed by `unique (playbook_id, version_number)` whether the row
      // lock is there or not — remove the lock and the second publish simply
      // violates the constraint and 500s, leaving the surviving numbers
      // unique and gap-free. A test asserting only uniqueness therefore
      // passes over a route with no serialisation at all.
      //
      // What the lock buys is that a concurrent publish WAITS and then
      // succeeds with the next number, instead of being refused with a
      // constraint violation the partner who pressed Publish can do nothing
      // about. So both statuses are pinned, not just the rows.
      expect([a.statusCode, b.statusCode], `${a.body}
${b.body}`).toEqual([200, 200]);

      const numbers = (await db.query<{ version_number: number }>(
        `select version_number from playbook_version
         where playbook_id = $1 and workspace_id = $2 order by version_number`,
        [id, WS])).map(r => r.version_number);
      expect(new Set(numbers).size).toBe(numbers.length);
      // No GAP either: the numbers run 1..n.
      expect(numbers).toEqual([1, 2, 3]);
      await app.close();
    } finally {
      // This suite COMMITS, so it cleans up after itself. A pg suite that
      // leaves rows behind is the "assumes it runs alone" failure, and with
      // five more suites landing that gets worse rather than better.
      await db.query('delete from playbook where id = $1 and workspace_id = $2', [id, WS]);
      if (actorId) await admin.query('delete from app_user where id = $1', [actorId]);
      await pool.end();
      await adminPool.end();
    }
  });
});

describe('reading and saving a playbook', () => {
  it('round-trips an identity, unchanged, and orders the list by updatedAt then seq', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const first = (await h.raw('PUT', '/v1/playbooks/aaa', { ...IDENTITY, id: 'aaa' })).json();
      const second = (await h.raw('PUT', '/v1/playbooks/bbb', { ...IDENTITY, id: 'bbb' })).json();
      expect(await h.get('/v1/playbooks/aaa')).toEqual(first);
      const list = await h.get('/v1/playbooks') as Playbook[];
      expect(list[0].updatedAt).toBe(list[1].updatedAt);
      // Only the `seq desc` tiebreak can order a same-transaction pair.
      expect(list.map(p => p.id).slice(0, 2)).toEqual(['bbb', 'aaa']);
      expect(second.id).toBe('bbb');
      await h.app.close();
    });
  });

  it('cannot move the published-content pointer, whatever the body says', async () => {
    // Only a publish moves `currentVersionId`, and only inside the one
    // transaction that also writes the version it names. A save that could
    // move it would be a second, untransacted route to the very thing
    // `publishAndPoint` exists to make atomic.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { playbook, version } = await h.publish('p1');
      const res = await h.raw('PUT', '/v1/playbooks/p1', {
        ...IDENTITY, version: playbook.version, currentVersionId: 'something-else',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().currentVersionId).toBe(version.id);
      await h.app.close();
    });
  });

  it('refuses a stale save with 409 and returns the current row (P9)', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const first = (await h.raw('PUT', '/v1/playbooks/p1', IDENTITY)).json() as Playbook;
      expect(first.version).toBe(1);
      const second = (await h.raw('PUT', '/v1/playbooks/p1',
        { ...first, name: 'Renamed' })).json() as Playbook;
      expect(second.version).toBe(2);
      const res = await h.raw('PUT', '/v1/playbooks/p1', { ...first, name: 'From a stale tab' });
      expect(res.statusCode).toBe(409);
      expect(res.json().current.name).toBe('Renamed');
      expect((await h.get('/v1/playbooks/p1') as Playbook).name).toBe('Renamed');
      await h.app.close();
    });
  });

  it('clears a draft with one statement, and resolves when there is nothing to clear', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const saved = (await h.raw('PUT', '/v1/playbooks/p1',
        { ...IDENTITY, draft: DRAFT })).json() as Playbook;
      expect('draft' in saved).toBe(true);
      expect((await h.raw('DELETE', '/v1/playbooks/p1/draft')).statusCode).toBe(204);
      expect('draft' in (await h.get('/v1/playbooks/p1'))).toBe(false);
      // Twice, and on a playbook that does not exist: this runs as the user
      // LEAVES the editor and there is nothing they could do about the news.
      expect((await h.raw('DELETE', '/v1/playbooks/p1/draft')).statusCode).toBe(204);
      expect((await h.raw('DELETE', '/v1/playbooks/nope/draft')).statusCode).toBe(204);
      await h.app.close();
    });
  });

  it('distinguishes "no such playbook" from "nothing published yet"', async () => {
    // A caller about to run a review has to tell "this playbook has no
    // published content" from "its content is a playbook with no clauses" —
    // and from "there is no such playbook" as well.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      expect((await h.raw('GET', '/v1/playbooks/nope/content')).statusCode).toBe(404);
      await h.raw('PUT', '/v1/playbooks/p1', IDENTITY);
      const unpublished = await h.raw('GET', '/v1/playbooks/p1/content');
      expect(unpublished.statusCode).toBe(404);
      expect(unpublished.json().error.message).toMatch(/no published content/i);
      // …and an EMPTY published version is a 200, not a 404.
      await h.publish('p2', { ...DRAFT, clauses: [] }, { ...IDENTITY, id: 'p2' });
      const empty = await h.get('/v1/playbooks/p2/content') as PlaybookVersion;
      expect(empty.clauses).toEqual([]);
      await h.app.close();
    });
  });

  it('404s the version list for a playbook that does not exist (Part 2A m9)', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('GET', '/v1/playbooks/no-such/versions');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/no such playbook/i);
      await h.app.close();
    });
  });

  it('still answers [] for a playbook that exists with nothing published (Part 2A m9)', async () => {
    // The other half: "no versions yet" is a real, legitimate empty state
    // and must stay distinguishable from "no such playbook".
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
         values ('p-empty', $1, 'Nothing published', now(), now(), 7)`, [WS]);
      const res = await h.raw('GET', '/v1/playbooks/p-empty/versions');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      await h.app.close();
    });
  });

  it('never lets a playbook or a version be read or published across workspaces', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
         values ('foreign', $1, 'Theirs', now(), now(), 7)`, [OTHER_WS]);
      await t.query(
        `insert into playbook_version (id, workspace_id, playbook_id, version_number, content, published_at)
         values ('fv', $1, 'foreign', 1, '{}'::jsonb, now())`, [OTHER_WS]);
      const h = harness(t, await aUser(t));

      expect((await h.raw('GET', '/v1/playbooks/foreign')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/versions/fv')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/playbooks/foreign/content')).statusCode).toBe(404);
      // 404, not `[]` (Part 2A m9). An empty list renders in a version
      // history pane as "nothing published yet" — the one list route where
      // "no such playbook" and "no versions yet" arrived identically.
      expect((await h.raw('GET', '/v1/playbooks/foreign/versions')).statusCode).toBe(404);
      expect((await h.get('/v1/playbooks') as Playbook[]).map(p => p.id)).not.toContain('foreign');

      // A PUBLISH over another workspace's id is refused, not a takeover.
      const res = await h.raw('POST', '/v1/playbooks/foreign/versions',
        { playbook: { ...IDENTITY, id: 'foreign' }, draft: DRAFT });
      expect(res.statusCode).toBe(409);
      expect('current' in res.json()).toBe(false);
      const still = await t.query<{ name: string }>(
        "select name from playbook where id = 'foreign'");
      expect(still[0].name).toBe('Theirs');
      expect((await t.query(
        "select 1 from playbook_version where playbook_id = 'foreign'")).length).toBe(1);

      expect((await h.raw('DELETE', '/v1/playbooks/foreign')).statusCode).toBe(404);
      expect((await t.query("select 1 from playbook where id = 'foreign'")).length).toBe(1);
      await h.app.close();
    }, migratorDb());
  });
});

describe('deleting a playbook', () => {
  it('takes its versions with it and CLEARS a review s pointer rather than failing on it', async () => {
    // R-D4: a review whose playbook was deleted has no version to point at,
    // and still opens on its own `playbookSnapshot`. The FK from `review` to
    // `playbook_version` does not cascade, so without clearing it first this
    // is a 500 on an action the user is entitled to take.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1');
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at)
         values ('m1', $1, 'M', now(), now())`, [WS]);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, playbook_version_id,
                             target, model_id, started_at)
         values ('r1', $1, 'm1', '{}'::jsonb, $2, '{}'::jsonb, 'm', now())`, [WS, version.id]);

      expect((await h.raw('DELETE', '/v1/playbooks/p1')).statusCode).toBe(204);
      expect((await t.query("select 1 from playbook_version where playbook_id = 'p1'")).length)
        .toBe(0);
      const review = await t.query<{ playbook_version_id: string | null }>(
        'select playbook_version_id from review where id = $1 and workspace_id = $2', ['r1', WS]);
      // The REVIEW survives — deleting a playbook must not delete a matter's
      // work — with its pointer cleared rather than dangling.
      expect(review.length).toBe(1);
      expect(review[0].playbook_version_id).toBeNull();
      // A second delete is a 404, not a silent 204.
      expect((await h.raw('DELETE', '/v1/playbooks/p1')).statusCode).toBe(404);
      await h.app.close();
    });
  });

  it('leaves ANOTHER playbook s versions and reviews alone', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const doomed = await h.publish('p1');
      const kept = await h.publish('p2', DRAFT, { ...IDENTITY, id: 'p2' });
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at)
         values ('m1', $1, 'M', now(), now())`, [WS]);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, playbook_version_id,
                             target, model_id, started_at)
         values ('r2', $1, 'm1', '{}'::jsonb, $2, '{}'::jsonb, 'm', now())`, [WS, kept.version.id]);

      await h.raw('DELETE', '/v1/playbooks/p1');
      expect((await h.raw('GET', `/v1/versions/${doomed.version.id}`)).statusCode).toBe(404);
      expect((await h.get(`/v1/versions/${kept.version.id}`) as PlaybookVersion).id)
        .toBe(kept.version.id);
      const review = await t.query<{ playbook_version_id: string | null }>(
        'select playbook_version_id from review where id = $1 and workspace_id = $2', ['r2', WS]);
      expect(review[0].playbook_version_id).toBe(kept.version.id);
      await h.app.close();
    });
  });
});
