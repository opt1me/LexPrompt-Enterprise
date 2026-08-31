import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { mappingId } from '../src/routes/admin/roleMappings.ts';

/**
 * THE CHANGE THAT WOULD LEAVE NOBODY ABLE TO REACH THE ADMIN SCREEN, over a
 * real database, with two connections contending for a real row lock.
 *
 * ## Why this is not in `roleMappings.compose.test.ts`
 *
 * Provoking the guard needs the workspace down to ONE mapping granting
 * `admin`. On the running stack that one mapping is the deployment's own
 * `admins` row — configuration, which these routes refuse to touch — and it
 * is also the row the admin's own session resolves through. Parking it to
 * provoke the guard removes the caller's admin role, and every request comes
 * back 403 from the role gate before the guard is reached. Tried, and that
 * is exactly what happened.
 *
 * Here the caller's role is INJECTED and the database is real, which is the
 * combination the guard needs to be exercised at all.
 *
 * ## Why this suite does not use `withPg`
 *
 * The same reason `dispositionRace.pg.test.ts` gives: `withPg` pins
 * everything to one client inside one rolled-back transaction, and two
 * writes serialised onto one connection cannot contend for a row lock. So
 * this suite COMMITS, over two real connections out of the app pool, and
 * deletes what it made.
 *
 * ## The workspace is this suite's OWN
 *
 * `buildTestApi`'s `WORKSPACE_ID` is `'ws-configured'`, which is not a uuid
 * and not the seeded workspace — so a workspace row is planted for it and
 * every mapping this file writes belongs to it. Nothing here can change who
 * can do what in the workspace the running stack serves, which matters
 * because these rows are COMMITTED.
 */

const WS = '00000000-0000-0000-0000-00000000c0de';
const ADMIN_USER = '00000000-0000-0000-0000-0000000000c1';
const ISSUER = 'https://stage5c-lockout.invalid/realms/none';

const seed = migratorDb();

function apiForAdmin(): FastifyInstance {
  const { app } = buildTestApi({
    principal: { issuer: ISSUER, subject: 's-admin', groups: ['admins'] },
    db: appDb(),
    // INJECTED, and that is the whole reason this file exists: the caller
    // stays an administrator while the table is reduced to one admin
    // mapping. `resolveActor` would derive the role from the very rows the
    // guard is about.
    actor: {
      id: ADMIN_USER, displayName: 'An Admin', initials: 'AA',
      role: 'admin', workspaceId: WS,
    },
  });
  return app;
}

async function plant(): Promise<void> {
  await seed.query(
    "insert into workspace (id, name) values ($1, 'Lockout') on conflict (id) do nothing",
    [WS]);
  await seed.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, $3, 's-admin', 'An Admin', 'AA', 'admin', 'active')
     on conflict (id) do nothing`,
    [ADMIN_USER, WS, ISSUER]);
}

async function sweep(): Promise<void> {
  await seed.query('delete from audit_event where workspace_id = $1', [WS]);
  await seed.query('delete from role_mapping where workspace_id = $1', [WS]);
}

/**
 * THE WORKSPACE ROW GOES TOO.
 *
 * This suite COMMITS, so the workspace it plants outlives it —  and
 * `identity.pg.test.ts` asserts that §6 seeds EXACTLY ONE workspace. Leaving
 * it behind failed that suite, in a file about the identity schema, for a
 * reason that named nothing. Found by running the whole pg suite rather
 * than only this file.
 *
 * Swept after EVERY TEST rather than after the file, and before the file as
 * well: the window in which this workspace exists is then one test long, and
 * a crash inside it is repaired by the next run rather than by a person.
 */
async function sweepWorkspace(): Promise<void> {
  await sweep();
  await seed.query('delete from app_user where workspace_id = $1', [WS]);
  await seed.query('delete from workspace where id = $1', [WS]);
}

beforeAll(sweepWorkspace);
afterEach(sweepWorkspace);
afterAll(sweepWorkspace);

const post = (app: FastifyInstance, body: unknown) => app.inject({
  method: 'POST', url: '/v1/admin/role-mappings',
  headers: { authorization: 'Bearer t' }, payload: body as never,
});

const del = (app: FastifyInstance, id: string) => app.inject({
  method: 'DELETE', url: `/v1/admin/role-mappings/${id}`,
  headers: { authorization: 'Bearer t' },
});

const put = (app: FastifyInstance, id: string, body: unknown) => app.inject({
  method: 'PUT', url: `/v1/admin/role-mappings/${id}`,
  headers: { authorization: 'Bearer t' }, payload: body as never,
});

describe('the last mapping that grants admin', () => {
  it('REFUSES a delete that would leave none, naming the recovery path', async () => {
    await plant();
    const app = apiForAdmin();
    try {
      const made = await post(app, { issuer: ISSUER, groupValue: 'only-admin', grantsRole: 'admin' });
      expect(made.statusCode).toBe(201);
      const id = mappingId(ISSUER, 'only-admin');

      const res = await del(app, id);
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('last_admin_mapping');
      // The ONLY recovery once it has happened: nobody could reach the
      // screen to undo it, and the repair would be a database session.
      expect(body.error.message).toContain('API_ROLE_MAPPINGS');

      // The row is STILL THERE. A refusal that had already written would be
      // the worst possible outcome for this particular guard.
      const rows = await seed.query<{ role: string }>(
        'select role from role_mapping where workspace_id = $1', [WS]);
      expect(rows).toEqual([{ role: 'admin' }]);
    } finally { await app.close(); }
  });

  it('REFUSES a NARROWING that would leave none, which a delete-only guard would let through', async () => {
    await plant();
    const app = apiForAdmin();
    try {
      await post(app, { issuer: ISSUER, groupValue: 'only-admin', grantsRole: 'admin' });
      const res = await put(app, mappingId(ISSUER, 'only-admin'), { grantsRole: 'reviewer' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('last_admin_mapping');
      const [row] = await seed.query<{ role: string }>(
        'select role from role_mapping where workspace_id = $1', [WS]);
      expect(row.role).toBe('admin');
    } finally { await app.close(); }
  });

  it('ALLOWS the same delete once a second admin mapping exists', async () => {
    // The positive half, and it is what makes both refusals above about the
    // STATE rather than about the verb. Without it, a guard that refused
    // every delete would pass them.
    await plant();
    const app = apiForAdmin();
    try {
      await post(app, { issuer: ISSUER, groupValue: 'admin-a', grantsRole: 'admin' });
      await post(app, { issuer: ISSUER, groupValue: 'admin-b', grantsRole: 'admin' });
      expect((await del(app, mappingId(ISSUER, 'admin-a'))).statusCode).toBe(204);
      const rows = await seed.query<{ n: string }>(
        `select count(*)::text as n from role_mapping
          where workspace_id = $1 and role = 'admin'`, [WS]);
      expect(rows[0].n).toBe('1');
    } finally { await app.close(); }
  });

  it('COUNTS a CONFIGURATION admin mapping, which `for update` cannot see', async () => {
    /*
     * The finding migration 015 records in its own comment, asserted as
     * behaviour.
     *
     * Postgres applies the UPDATE policy's USING clause to a locking SELECT
     * and silently drops the rows that fail it, so a configuration row is
     * visible to a plain `select` and INVISIBLE to the same select with `for
     * update` appended. A guard that took its COUNT `for update` would not
     * see this deployment's own `API_ROLE_MAPPINGS` administrator, would
     * count zero, and would refuse a delete that leaves the firm perfectly
     * well administered.
     *
     * Fail-safe, and still wrong: an administrator would be told the only
     * way back is to redeploy, about a change with no consequence at all.
     */
    await plant();
    await seed.query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, 'deployment-admins', 'admin', 'configuration')`, [WS, ISSUER]);
    const app = apiForAdmin();
    try {
      await post(app, { issuer: ISSUER, groupValue: 'admin-a', grantsRole: 'admin' });
      expect((await del(app, mappingId(ISSUER, 'admin-a'))).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it('lets exactly ONE of two concurrent deletes through — never both', async () => {
    /*
     * THE CASE THE `for update` EXISTS FOR.
     *
     * Two servers, two connections out of the app pool, two deletes issued
     * together. The guard reads and writes inside ONE transaction holding a
     * row lock, so the second waits and then re-counts on a snapshot taken
     * after the first committed.
     *
     * Move the count outside the transaction, or drop `for update`, and both
     * requests see two admin mappings, both delete, and the workspace ends
     * with none — with every single-caller case above still green. Which of
     * the two wins is NOT asserted: a test that expects a particular one is
     * a test that flakes on a faster machine.
     */
    await plant();
    const a = apiForAdmin();
    const b = apiForAdmin();
    try {
      await post(a, { issuer: ISSUER, groupValue: 'admin-a', grantsRole: 'admin' });
      await post(a, { issuer: ISSUER, groupValue: 'admin-b', grantsRole: 'admin' });

      const [ra, rb] = await Promise.all([
        del(a, mappingId(ISSUER, 'admin-a')),
        del(b, mappingId(ISSUER, 'admin-b')),
      ]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([204, 409]);
      const rows = await seed.query<{ n: string }>(
        `select count(*)::text as n from role_mapping
          where workspace_id = $1 and role = 'admin'`, [WS]);
      // ONE, always. This is the number the whole guard exists for.
      expect(rows[0].n).toBe('1');
    } finally { await a.close(); await b.close(); }
  });
});
