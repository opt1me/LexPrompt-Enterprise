import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import type { RoleMappingEffect, RoleMappingView, RoleMappingsPage } from '@lexprompt/core';
import { asUser, signIn, type TestAccount } from './helpers/twoAccounts.ts';
import { threeAccounts } from './helpers/threeAccounts.ts';

/**
 * §7's ROLE MAPPING, ADMINISTERED — over real HTTP, with three real people.
 *
 * ## Why this is a compose suite and not a route test
 *
 * Every claim here is about PRIVILEGE, and a route test injects a principal
 * the test itself invented. The only way to prove that a partner is refused
 * an admin route is to make the request as a partner, with a token the
 * seeded realm minted, through the same nginx hop a browser uses.
 *
 * ## Cleanup is not optional in this file
 *
 * A stray `admin` mapping makes every later suite pass for the wrong reason,
 * and `test:pg` and `test:compose` share one database. Every mapping created
 * here is removed in `afterAll` AS THE MIGRATOR — because for a
 * configuration row the app role cannot, which is the point of migration
 * 015 — and the group values are namespaced `stage5c-*` under an issuer no
 * deployment seeds, so nothing here can grant anybody anything even while it
 * exists.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const ISSUER = 'https://stage5c.invalid/realms/none';
/** The issuer this stack actually mints tokens for. Used only for the ONE
 *  case that has to change a live person's role. */
const LIVE_ISSUER = 'http://localhost:8088/realms/lexprompt';

const MIGRATOR_URL = process.env.LEXPROMPT_TEST_MIGRATION_URL;

let trainee: TestAccount;
let partner: TestAccount;
let admin: TestAccount;


const idFor = (issuer: string, group: string): string =>
  Buffer.from(`${issuer}\n${group}`, 'utf8').toString('base64url');

const json = async <T>(res: Response): Promise<T> => await res.json() as T;

/** The migrator connection, used ONLY to plant a configuration row and to
 *  sweep up. There is no route that can write one, deliberately. */
async function asMigrator(sql: string, values: unknown[]): Promise<void> {
  if (!MIGRATOR_URL) {
    throw new Error(
      'LEXPROMPT_TEST_MIGRATION_URL is not set. This suite plants a CONFIGURATION role '
      + 'mapping, which no route can write by design, so it needs the migrator connection. '
      + 'Run scripts/pg-forward.sh and export the three URLs it prints.');
  }
  const pool = new Pool({ connectionString: MIGRATOR_URL, max: 1 });
  try { await pool.query(sql, values); } finally { await pool.end(); }
}

const CFG_GROUP = 'stage5c-cfg';
const ADMIN_GROUP = 'stage5c-house-counsel';

/**
 * EVERY GROUP VALUE THIS FILE CAN WRITE, as a literal list rather than one
 * accumulated as the suite runs.
 *
 * An accumulated list is empty when the suite STARTS, so it can only ever
 * clean up after a run that finished — and the run that leaves rows behind
 * is by definition the one that did not. Named here, the sweep before the
 * fixtures is as complete as the sweep after them.
 */
const GROUPS = [CFG_GROUP, ADMIN_GROUP, 'house-counsel', 'g'];

/**
 * EVERY ROW, INCLUDING THE AUDIT ROWS.
 *
 * The first version of this file swept `role_mapping` and left `audit_event`
 * behind, so its *"audits it exactly once"* case counted one on the first
 * run and four on the fourth — a test that passes once and then accuses the
 * code of double-writing. Found by running the suite a second time, not by
 * reading it.
 *
 * As the MIGRATOR, because `audit_event` is append-only to the app role by
 * grant (012), which is the property that makes it evidence.
 */
async function sweep(): Promise<void> {
  await asMigrator(
    'delete from audit_event where subject_type = $1 and subject_id = any($2::text[])',
    ['role_mapping', GROUPS.map(g => idFor(ISSUER, g))]);
  await asMigrator(
    'delete from role_mapping where issuer = $1 and group_value = any($2::text[])',
    [ISSUER, GROUPS]);
}

/** The seeded `reviewers` mapping, back the way the deployment wrote it. The
 *  "next request" case borrows it and restores it in its own `finally`; this
 *  is the belt to that pair of braces, because a trainee left holding
 *  `partner` makes every later suite pass for the wrong reason. */
async function restoreLiveReviewers(): Promise<void> {
  await asMigrator(
    `update role_mapping
        set role = 'reviewer', source = 'configuration',
            updated_at = null, updated_by_user_id = null
      where issuer = $1 and group_value = 'reviewers'`,
    [LIVE_ISSUER]);
}

beforeAll(async () => {
  ({ trainee, partner, admin } = await threeAccounts());
  await sweep();
  await asMigrator(
    `insert into role_mapping (workspace_id, issuer, group_value, role, source)
     values ($1, $2, $3, 'reviewer', 'configuration')
     on conflict (issuer, group_value) do update set source = 'configuration'`,
    [WS, ISSUER, CFG_GROUP]);
});

afterAll(async () => {
  await sweep();
  await restoreLiveReviewers();
});

/* ---------------------------------------------------------------- the gate */

const WRITES: [string, string, unknown][] = [
  ['GET', '/v1/admin/role-mappings', undefined],
  ['POST', '/v1/admin/role-mappings/preview', { issuer: ISSUER, groupValue: 'g', grantsRole: 'reviewer' }],
  ['POST', '/v1/admin/role-mappings', { issuer: ISSUER, groupValue: 'g', grantsRole: 'reviewer' }],
  ['PUT', `/v1/admin/role-mappings/${idFor(ISSUER, 'g')}`, { grantsRole: 'partner' }],
  ['DELETE', `/v1/admin/role-mappings/${idFor(ISSUER, 'g')}`, undefined],
];

describe('who may reach these routes at all', () => {
  it.each(WRITES)('refuses %s %s for a trainee AND for a partner', async (m, p, body) => {
    // BOTH, and for two different reasons. §7: an admin is not a
    // super-reviewer, so `partner` is not a step on the way to `admin` — a
    // suite that only tried the trainee would pass against a `partner` gate.
    const asTrainee = await asUser(trainee, m, p, body);
    expect(asTrainee.status, `${m} ${p} as trainee`).toBe(403);
    expect((await json<{ error: { code: string } }>(asTrainee)).error.code).toBe('not_permitted');
    const asPartner = await asUser(partner, m, p, body);
    expect(asPartner.status, `${m} ${p} as partner`).toBe(403);
  });

  it('refuses every route unauthenticated with 401, and NEVER an empty list', async () => {
    for (const [m, p, body] of WRITES) {
      const res = await fetch(`http://localhost:3005/api${p}`, {
        method: m,
        ...(body === undefined ? {} : {
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }),
      });
      expect(res.status, `${m} ${p} unauthenticated`).toBe(401);
      const parsed = await res.json() as Record<string, unknown>;
      expect(parsed.error).toMatchObject({ code: 'sign_in_required' });
      // A refusal, never an empty result set: "you are not signed in" and
      // "this firm has no role mappings" are different facts, and the second
      // is a statement this route is in no position to make.
      expect('mappings' in parsed).toBe(false);
    }
  });
});

/* --------------------------------------------------------------- the reads */

describe('what an administrator sees', () => {
  it('lists configuration and admin rows together, each naming its source and the variable', async () => {
    const page = await json<RoleMappingsPage>(
      await asUser(admin, 'GET', '/v1/admin/role-mappings'));
    expect(page.configurationSource).toBe('API_ROLE_MAPPINGS');
    expect(page.readAt).toBeGreaterThan(Date.now() - 60_000);
    expect(page.readAt).toBeLessThanOrEqual(Date.now());
    expect(page.mappings.some(m => m.source === 'configuration')).toBe(true);
    const cfg = page.mappings.find(m => m.groupValue === CFG_GROUP);
    expect(cfg).toBeDefined();
    expect(cfg!.source).toBe('configuration');
    // ABSENT, never null: nobody typed a configuration row into a screen,
    // and naming the deployment as an author would be an attribution nobody
    // made.
    expect('createdByUserId' in cfg!).toBe(false);
  });
});

/* -------------------------------------------------------------- the effect */

describe('what a change will do, said before it is made', () => {
  it('names the effect of a widening BEFORE it is applied, in the server s own words', async () => {
    const preview = await json<RoleMappingEffect>(
      await asUser(admin, 'POST', '/v1/admin/role-mappings/preview',
        { issuer: ISSUER, groupValue: 'house-counsel', grantsRole: 'admin' }));
    expect(preview.widens).toBe(true);
    expect(preview.action).toBe('create');
    expect(preview.grantsRole).toBe('admin');
    expect(preview.sentence).toContain('house-counsel');
    expect(preview.sentence).toMatch(/administrator/i);
    // WHEN it applies, always. True because `resolveActor` re-derives the
    // role per request — proved by the last case in this file.
    expect(preview.sentence).toMatch(/next request/i);
  });

  it('does not call a NARROWING a widening, and still gives it a sentence', async () => {
    // The mutation this kills: `widens: true` unconditionally, which passes
    // the case above and turns the typed confirmation into a formality
    // nobody reads.
    const preview = await json<RoleMappingEffect>(
      await asUser(admin, 'POST', '/v1/admin/role-mappings/preview',
        { issuer: ISSUER, groupValue: CFG_GROUP, grantsRole: 'reviewer' }));
    expect(preview.widens).toBe(false);
    expect(preview.currentRole).toBe('reviewer');
    expect(preview.sentence.length).toBeGreaterThan(40);
  });

  it('gives a REMOVAL a sentence too, and never claims it grants something', async () => {
    const preview = await json<RoleMappingEffect>(
      await asUser(admin, 'POST', '/v1/admin/role-mappings/preview',
        { issuer: ISSUER, groupValue: CFG_GROUP }));
    expect(preview.action).toBe('remove');
    expect(preview.widens).toBe(false);
    // ABSENT, not `undefined`: a removal grants nothing, and a key holding
    // `undefined` reads to an `in` check as a role that is there.
    expect('grantsRole' in preview).toBe(false);
    expect(preview.sentence).toMatch(/no access to LexPrompt/i);
  });
});

/* ---------------------------------------------------------- the two layers */

describe('a configuration row is refused by the handler AND by the database', () => {
  it('REFUSES to change a configuration row through the route, before the policy has to', async () => {
    const res = await asUser(admin, 'PUT',
      `/v1/admin/role-mappings/${idFor(ISSUER, CFG_GROUP)}`, { grantsRole: 'admin' });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('mapping_is_configuration');
    // The sentence names the variable an administrator would have to edit.
    // A Postgres row-level-security error is a correct refusal that tells a
    // lawyer nothing they can act on.
    expect(body.error.message).toContain('API_ROLE_MAPPINGS');
  });

  it('REFUSES to remove one either, and the row is still there afterwards', async () => {
    const res = await asUser(admin, 'DELETE',
      `/v1/admin/role-mappings/${idFor(ISSUER, CFG_GROUP)}`);
    expect(res.status).toBe(409);
    const page = await json<RoleMappingsPage>(
      await asUser(admin, 'GET', '/v1/admin/role-mappings'));
    expect(page.mappings.some(m => m.groupValue === CFG_GROUP)).toBe(true);
  });

  it('REFUSES to add a second mapping for a pair configuration already owns', async () => {
    const res = await asUser(admin, 'POST', '/v1/admin/role-mappings',
      { issuer: ISSUER, groupValue: CFG_GROUP, grantsRole: 'admin' });
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code)
      .toBe('mapping_is_configuration');
  });
});

/* ------------------------------------------------------------- the writes */

describe('creating, changing and removing an admin mapping', () => {
  const GROUP = ADMIN_GROUP;

  it('creates one, attributes it, and audits it exactly once', async () => {
    const res = await asUser(admin, 'POST', '/v1/admin/role-mappings',
      { issuer: ISSUER, groupValue: GROUP, grantsRole: 'partner' });
    expect(res.status).toBe(201);
    const view = await json<RoleMappingView>(res);
    expect(view).toMatchObject({
      issuer: ISSUER, groupValue: GROUP, role: 'partner', source: 'admin',
      createdByUserId: admin.userId,
    });
    expect(view.id).toBe(idFor(ISSUER, GROUP));
    // Not superseded, and the key is ABSENT rather than null.
    expect('convertedFromAdminAt' in view).toBe(false);

    if (MIGRATOR_URL) {
      const pool = new Pool({ connectionString: MIGRATOR_URL, max: 1 });
      try {
        const audits = await pool.query(
          `select action, actor_user_id::text as actor, detail from audit_event
            where subject_type = 'role_mapping' and subject_id = $1
            order by at`,
          [view.id]);
        expect(audits.rows).toHaveLength(1);
        expect(audits.rows[0]).toMatchObject({
          action: 'role_mapping.created', actor: admin.userId,
        });
        expect(audits.rows[0].detail).toMatchObject({ groupValue: GROUP, toRole: 'partner' });
        // S22's direction, asserted at a NEW surface rather than assumed to
        // hold: a policy change is not a disposition and writes nothing to
        // the disposition record.
        const dispositions = await pool.query(
          `select count(*)::text as n from finding_disposition_event
            where clause_id = $1`, [GROUP]);
        expect(dispositions.rows[0].n).toBe('0');
      } finally { await pool.end(); }
    }
  });

  it('changes it, and the audit row names BOTH roles', async () => {
    const res = await asUser(admin, 'PUT',
      `/v1/admin/role-mappings/${idFor(ISSUER, GROUP)}`, { grantsRole: 'reviewer' });
    expect(res.status).toBe(200);
    const view = await json<RoleMappingView>(res);
    expect(view.role).toBe('reviewer');
    expect(view.updatedByUserId).toBe(admin.userId);
    if (MIGRATOR_URL) {
      const pool = new Pool({ connectionString: MIGRATOR_URL, max: 1 });
      try {
        const audits = await pool.query(
          `select action, detail from audit_event
            where subject_type = 'role_mapping' and subject_id = $1 and action = $2`,
          [view.id, 'role_mapping.changed']);
        expect(audits.rows).toHaveLength(1);
        expect(audits.rows[0].detail).toMatchObject(
          { fromRole: 'partner', toRole: 'reviewer' });
      } finally { await pool.end(); }
    }
  });

  it('removes it, and a second removal is a 404 rather than a silent success', async () => {
    expect((await asUser(admin, 'DELETE',
      `/v1/admin/role-mappings/${idFor(ISSUER, GROUP)}`)).status).toBe(204);
    const again = await asUser(admin, 'DELETE',
      `/v1/admin/role-mappings/${idFor(ISSUER, GROUP)}`);
    expect(again.status).toBe(404);
  });

  it('answers 404 for a handle that does not decode, rather than looking up half a key', async () => {
    expect((await asUser(admin, 'PUT', '/v1/admin/role-mappings/not-a-handle',
      { grantsRole: 'reviewer' })).status).toBe(404);
  });
});

/* ---------------------------------------------------------- the lock-out */

/*
 * THE LAST-ADMIN-MAPPING GUARD IS PROVED IN `roleMappingLockout.pg.test.ts`,
 * NOT HERE, and the reason is a property of the guard rather than a
 * convenience.
 *
 * Provoking it needs the workspace down to ONE mapping granting `admin`.
 * On this stack that one mapping is the deployment's own `admins` row —
 * configuration, which these routes refuse to touch by design (three cases
 * above) — and it is also the row the ADMIN'S OWN SESSION resolves through.
 * Parking it to provoke the guard removes the caller's admin role, and every
 * request in the test comes back 403 `not_permitted` from the role gate
 * before the guard is ever reached. Attempted first, and that is exactly
 * what happened.
 *
 * So the guard is proved where the caller's role is injected and the
 * database is real: two committing connections out of the app pool, the same
 * shape `dispositionRace.pg.test.ts` uses and for the same reason — two
 * writes serialised onto one pinned connection cannot contend for a row
 * lock, and a lock-out guard with no concurrent test is a guard nobody has
 * tried to beat.
 */
/* --------------------------------------------------- when it takes effect */

describe('the sentence the screen shows, proved against a session already open', () => {
  it('takes effect on the NEXT REQUEST, with the same token, in both directions', async () => {
    /*
     * THE LIVE PROOF OF *"including for anyone already signed in"* — the
     * clause the effect sentence ends with, and the one an administrator
     * would otherwise have to take on trust.
     *
     * The trainee's token is minted ONCE, before anything changes, and is
     * never refreshed. `resolveActor` re-derives the role from
     * `role_mapping` on every request, so the same token clears a
     * partner-only route the moment the mapping is raised and stops clearing
     * it the moment it is put back.
     *
     * ## Why the setup borrows the migrator
     *
     * The seeded realm gives each account exactly ONE group, and the
     * `reviewers` mapping that group resolves through is deployment
     * configuration — which this route refuses to touch, by design, and
     * which three cases above assert. So the mapping is flipped to
     * `source = 'admin'` first, AS THE MIGRATOR: that is the state a real
     * administrator's own mapping is in, reached the only way a test can
     * reach it. The write under test is still the route's, made by the
     * admin's session, and the `finally` puts the row back to
     * `configuration` whatever happens — a trainee left holding `partner`
     * would make every later suite pass for the wrong reason.
     */
    if (!MIGRATOR_URL) return;
    const open = await signIn('trainee');
    expect(open.role).toBe('reviewer');
    const partnerOnly = '/v1/playbooks/stage5c-no-such-playbook/versions';
    const id = idFor(LIVE_ISSUER, 'reviewers');
    const pool = new Pool({ connectionString: MIGRATOR_URL, max: 1 });

    try {
      const before = await asUser(open, 'POST', partnerOnly, {});
      expect(before.status).toBe(403);
      expect((await json<{ error: { code: string } }>(before)).error.code).toBe('not_permitted');

      await pool.query(
        `update role_mapping set source = 'admin'
          where issuer = $1 and group_value = 'reviewers'`, [LIVE_ISSUER]);

      const raised = await asUser(admin, 'PUT',
        `/v1/admin/role-mappings/${id}`, { grantsRole: 'partner' });
      expect(raised.status).toBe(200);

      // THE SAME TOKEN. Not re-signed-in, not refreshed. It is no longer
      // refused for being a reviewer — the route answers on its own merits
      // (there is no such playbook), which is the point: the ROLE GATE is
      // what moved.
      const after = await asUser(open, 'POST', partnerOnly, {});
      expect(after.status).not.toBe(403);
      expect((await json<{ error: { code: string } }>(after)).error.code)
        .not.toBe('not_permitted');

      // …and back again, on the same token, with no sign-out in between.
      expect((await asUser(admin, 'PUT',
        `/v1/admin/role-mappings/${id}`, { grantsRole: 'reviewer' })).status).toBe(200);
      const restored = await asUser(open, 'POST', partnerOnly, {});
      expect(restored.status).toBe(403);
      expect((await json<{ error: { code: string } }>(restored)).error.code)
        .toBe('not_permitted');
    } finally {
      await pool.query(
        `update role_mapping
            set role = 'reviewer', source = 'configuration',
                updated_at = null, updated_by_user_id = null
          where issuer = $1 and group_value = 'reviewers'`, [LIVE_ISSUER]);
      await pool.end();
    }
  });

  it('leaves the stack exactly as it found it — three accounts, three roles', async () => {
    // The last word in a suite that has been moving role mappings around on
    // a live stack. A stray change here is invisible until an unrelated file
    // fails for a reason that names nothing.
    const [t, p, a] = await Promise.all([signIn('trainee'), signIn('partner'), signIn('admin')]);
    expect([t.role, p.role, a.role]).toEqual(['reviewer', 'partner', 'admin']);
  });
});
