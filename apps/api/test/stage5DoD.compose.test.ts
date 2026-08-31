import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { AuditExport, ProviderStatus, RoleMappingsPage } from '@lexprompt/core';
import { ROUTE_POLICY } from '../src/auth/routeTable.ts';
import { API_BASE, asUser, signIn, type TestAccount } from './helpers/twoAccounts.ts';
import { threeAccounts } from './helpers/threeAccounts.ts';
import {
  dispositionPath, removeSeeded, seedOneDoneFinding, type Seeded,
} from './helpers/seedReview.ts';

/**
 * STAGE 5'S LIVE GATE — three real accounts, on the running stack.
 *
 * ## What this file is for
 *
 * Part 5C changed what a request is CAPABLE of: an administrator can now
 * write role policy, turn an account off and retire a name, and take the
 * firm's whole audited record out of the building as a file. Every one of
 * those is proved in a unit or `.pg` suite against an injected principal —
 * and an injected principal is a principal the test itself invented. This
 * file makes the same requests with tokens the seeded realm minted, through
 * the same nginx hop a browser uses, as three people whose roles the
 * deployment's own mapping decided.
 *
 * ## Why the route sweep is ENUMERATED and not typed out
 *
 * `ADMIN_ROUTES` below is derived from `ROUTE_POLICY` itself, and the table
 * of safe requests is asserted to cover it EXACTLY, in both directions. A
 * route added later at the `admin` bar with no live check fails HERE, at the
 * stage gate, rather than shipping with a 403 nobody executed. Seventeen
 * guards in this project have been found not guarding, and the commonest
 * shape by far is a hand-written list that stopped keeping up with the thing
 * it lists.
 *
 * ## What it deliberately does NOT restate
 *
 * `roleMappings.compose.test.ts`, `people.compose.test.ts` and
 * `providers.compose.test.ts` already prove their own routes' behaviour
 * live. Restating them here would be two suites making one claim, and the
 * weaker copy is the one that stays green when the property breaks. What is
 * here is what only the GATE can say: the sweep across every admin route,
 * the two cross-table claims (`audit_event` gained rows and
 * `finding_disposition_event` gained none; the history is unchanged by a
 * pseudonymisation), the restart, and the export's manifest measured against
 * its own rows.
 *
 * ## What nobody has seen
 *
 * Browser automation has been unavailable for five stages. Every rendered
 * string in Stage 5 is asserted in jsdom and by nothing that has looked at a
 * screen. `docs/BROWSER-VERIFICATION.md` names each one.
 */

const WS = '00000000-0000-0000-0000-000000000001';
/** An issuer no deployment seeds, so nothing this file writes can grant
 *  anybody anything even while it exists. */
const ISSUER = 'https://stage5-dod.invalid/realms/none';
const GROUP = 'stage5dod-house-counsel';
/** The issuer this stack actually mints tokens for — used only where a live
 *  role has to move. */
const LIVE_ISSUER = 'http://localhost:8088/realms/lexprompt';

let trainee: TestAccount;
let partner: TestAccount;
let admin: TestAccount;

const json = async <T>(res: Response): Promise<T> => await res.json() as T;

const idFor = (issuer: string, group: string): string =>
  Buffer.from(`${issuer}\n${group}`, 'utf8').toString('base64url');

/**
 * No `--env-file`, matching every other `*.compose.test.ts` here: nothing in
 * this file builds, recreates or `up`s anything. It `exec`s into running
 * containers and restarts one. `docker compose up --build` is where an
 * `--env-file` is mandatory.
 */
function compose(args: string[], timeoutMs = 60_000): string {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8', timeout: timeoutMs,
  });
}

/**
 * One statement on the MIGRATOR connection, inside the postgres container.
 *
 * Deliberately not `LEXPROMPT_TEST_MIGRATION_URL`: two neighbouring compose
 * suites read that variable and `return` silently when it is unset, so their
 * most load-bearing cases can pass by not running. A gate must not be able
 * to do that, and `docker compose exec` needs nothing exported.
 */
function sql(statement: string): string {
  return compose([
    'exec', '-T', 'postgres',
    'psql', '-U', 'lexprompt_migrator', '-d', 'lexprompt', '-A', '-t', '-c', statement,
  ]).trim();
}

/** Count and content of every disposition-history row, as one string. The
 *  claim P58 makes is that this value does not move. */
function historyFingerprint(): string {
  return sql(
    `select count(*)::text || ' ' || coalesce(md5(string_agg(e::text, '|' order by e::text)), '-')
       from finding_disposition_event e`);
}

const auditCount = (action: string, subject: string): number =>
  Number(sql(
    `select count(*) from audit_event
      where action = '${action}' and subject_id = '${subject}'`));

/** Every row this file's fixtures produced, removed whatever happened. */
const litter: { who: TestAccount; seeded: Seeded }[] = [];

/**
 * Every row this file can write, removed BEFORE the fixtures as well as
 * after them.
 *
 * A list accumulated as a suite runs is empty when the suite STARTS, so it
 * can only clean up after a run that finished — and the run that leaves rows
 * behind is by definition the one that did not. A subject id is base64url of
 * `issuer\ngroupValue` and cannot be matched by group name, so the two ids
 * this file can mint are named.
 */
function sweepRoleMappings(): void {
  sql(`delete from role_mapping where issuer = '${ISSUER}'`);
  sql(`delete from audit_event where subject_type = 'role_mapping' and subject_id in `
    + `('${idFor(ISSUER, GROUP)}', '${idFor(ISSUER, `${GROUP}-2`)}')`);
}

beforeAll(async () => {
  sweepRoleMappings();
  ({ trainee, partner, admin } = await threeAccounts());
}, 120_000);

afterAll(async () => {
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
  sweepRoleMappings();
  sql(`delete from app_user where subject like 'stage5dod-%'`);
}, 120_000);

/* ------------------------------------------------------------- the premise */

describe('the premise every privilege claim in this stage rests on (P61)', () => {
  it('signs in as three distinct people holding three distinct roles', () => {
    expect(trainee.role).toBe('reviewer');
    expect(partner.role).toBe('partner');
    expect(admin.role).toBe('admin');
    expect(new Set([trainee.userId, partner.userId, admin.userId]).size).toBe(3);
  });
});

/* ------------------------------------------- every admin route, three times */

/** Every route `ROUTE_POLICY` puts at the `admin` bar, read out of the table
 *  rather than retyped. */
const ADMIN_ROUTES = Object.entries(ROUTE_POLICY)
  .filter(([, policy]) => policy === 'admin')
  .map(([key]) => key)
  .sort();

interface SafeRequest {
  method: string;
  /** A path that reaches the handler and CHANGES NOTHING a later suite
   *  depends on — a range with no rows, an id that does not exist, a body
   *  the handler refuses. The point of the sweep is the role gate, and the
   *  role gate runs before any of them. */
  path: string;
  body?: unknown;
  /** What the ADMIN's own request should answer, when the gate lets it
   *  through. Never 401 or 403 — that is the assertion; the specific code is
   *  recorded so a route that started answering 500 to everything cannot
   *  read as "the gate works". */
  adminStatus: number[];
}

const NO_SUCH_USER = '00000000-0000-0000-0000-0000000000ff';
const NO_SUCH_MAPPING = idFor(ISSUER, 'stage5dod-nothing-maps-here');

const SAFE: Record<string, SafeRequest> = {
  'GET /v1/admin/blob-orphans': { method: 'GET', path: '/v1/admin/blob-orphans', adminStatus: [200] },
  'POST /v1/admin/blob-orphans/delete': {
    // The one destructive route in the sweep, and it is safe by
    // construction: it recomputes its own key list and acts only on bytes no
    // `document` row claims. The case below asserts it deleted exactly what
    // the listing named.
    method: 'POST', path: '/v1/admin/blob-orphans/delete', adminStatus: [200],
  },
  'PUT /v1/workspace/settings': {
    // Refused by the handler for naming an empty model choice — so the role
    // gate was cleared and the workspace's real settings are untouched.
    method: 'PUT', path: '/v1/workspace/settings', body: { modelChoiceId: '' },
    adminStatus: [400],
  },
  'GET /v1/admin/role-mappings': {
    method: 'GET', path: '/v1/admin/role-mappings', adminStatus: [200],
  },
  'POST /v1/admin/role-mappings/preview': {
    method: 'POST', path: '/v1/admin/role-mappings/preview',
    body: { issuer: ISSUER, groupValue: 'stage5dod-preview-only', grantsRole: 'reviewer' },
    adminStatus: [200],
  },
  'POST /v1/admin/role-mappings': {
    // No `grantsRole`: refused as a bad request, so nothing is written.
    method: 'POST', path: '/v1/admin/role-mappings',
    body: { issuer: ISSUER, groupValue: 'stage5dod-never-created' },
    adminStatus: [400],
  },
  'PUT /v1/admin/role-mappings/:id': {
    method: 'PUT', path: `/v1/admin/role-mappings/${NO_SUCH_MAPPING}`,
    body: { grantsRole: 'reviewer' }, adminStatus: [404],
  },
  'DELETE /v1/admin/role-mappings/:id': {
    method: 'DELETE', path: `/v1/admin/role-mappings/${NO_SUCH_MAPPING}`, adminStatus: [404],
  },
  'POST /v1/admin/users/:id/disable': {
    method: 'POST', path: `/v1/admin/users/${NO_SUCH_USER}/disable`, adminStatus: [404],
  },
  'POST /v1/admin/users/:id/enable': {
    method: 'POST', path: `/v1/admin/users/${NO_SUCH_USER}/enable`, adminStatus: [404],
  },
  'POST /v1/admin/users/:id/pseudonymise': {
    // A person who does not exist. NEVER a seeded account: pseudonymisation
    // is irreversible through the application, and a sweep that renamed the
    // trainee would break every later suite with a message about something
    // else.
    method: 'POST', path: `/v1/admin/users/${NO_SUCH_USER}/pseudonymise`, adminStatus: [404],
  },
  'GET /v1/admin/providers': { method: 'GET', path: '/v1/admin/providers', adminStatus: [200] },
  'GET /v1/admin/audit-export': {
    // A range in 1970, which holds nothing.
    method: 'GET', path: '/v1/admin/audit-export?from=0&to=1000', adminStatus: [200],
  },
};

describe('every admin route in ROUTE_POLICY, refused for two roles and reached by one', () => {
  it('covers the admin routes EXACTLY — in both directions', () => {
    // The half that makes this a gate rather than a list. A route added at
    // the `admin` bar with no entry here fails; an entry here for a route
    // that no longer exists fails too.
    expect(Object.keys(SAFE).sort()).toEqual(ADMIN_ROUTES);
    // The sanity half: the table was read and it is not empty.
    expect(ADMIN_ROUTES.length).toBeGreaterThan(10);
    expect(ADMIN_ROUTES).toContain('GET /v1/admin/audit-export');
  });

  it('refuses a trainee and a partner at every one of them, and never answers empty', async () => {
    for (const key of ADMIN_ROUTES) {
      const req = SAFE[key]!;
      for (const who of [trainee, partner]) {
        const res = await asUser(who, req.method, req.path, req.body);
        expect(res.status, `${key} as ${who.username}`).toBe(403);
        const body = await json<Record<string, unknown>>(res);
        expect((body.error as { code?: string } | undefined)?.code, key).toBe('not_permitted');
        // §7: an admin is NOT a super-reviewer and a partner is not a
        // half-admin. A refusal must also never carry the shape of an
        // answer — "this firm has no role mappings" is a statement a 403
        // cannot make.
        for (const shape of ['mappings', 'providers', 'rows', 'manifest', 'keys', 'deleted']) {
          expect(shape in body, `${key} answered a ${shape} to ${who.username}`).toBe(false);
        }
      }
    }
  }, 120_000);

  it('lets the administrator through at every one of them', async () => {
    const seen: Record<string, number> = {};
    for (const key of ADMIN_ROUTES) {
      const req = SAFE[key]!;
      const res = await asUser(admin, req.method, req.path, req.body);
      seen[key] = res.status;
      await res.text();
      expect(res.status, `${key} as admin`).not.toBe(403);
      expect(res.status, `${key} as admin`).not.toBe(401);
      // …and the specific answer, so "the gate works" cannot be satisfied by
      // a route that has started failing for some other reason.
      expect(req.adminStatus, `${key} answered ${res.status}`).toContain(res.status);
    }
    expect(Object.keys(seen)).toHaveLength(ADMIN_ROUTES.length);
  }, 120_000);

  it('refuses every one of them UNAUTHENTICATED, with 401 and no answer shape', async () => {
    for (const key of ADMIN_ROUTES) {
      const req = SAFE[key]!;
      const res = await fetch(`${API_BASE}${req.path}`, {
        method: req.method,
        ...(req.body === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.body),
        }),
      });
      expect(res.status, key).toBe(401);
      const body = await json<Record<string, unknown>>(res);
      expect((body.error as { code?: string } | undefined)?.code, key).toBe('sign_in_required');
    }
  }, 120_000);

  it('recomputes the orphan list it acts on rather than taking one from the caller', async () => {
    const listed = await json<{ keys: string[] }>(
      await asUser(admin, 'GET', '/v1/admin/blob-orphans'));
    const deleted = await json<{ deleted: string[] }>(
      await asUser(admin, 'POST', '/v1/admin/blob-orphans/delete', { keys: ['not-ours'] }));
    // The body named a key; the route deleted its OWN list and nothing else.
    expect(deleted.deleted.sort()).toEqual(listed.keys.sort());
    expect(deleted.deleted).not.toContain('not-ours');
  }, 60_000);
});

/* ----------------------------------------- a mapping, end to end, and what it audited */

describe('a role mapping added, previewed, confirmed, used and removed', () => {
  it('writes the audit rows the acts deserve, and NO disposition row (S22)', async () => {
    const id = idFor(ISSUER, GROUP);
    const beforeHistory = historyFingerprint();

    // PREVIEWED FIRST, and the preview writes nothing.
    const preview = await json<{ sentence: string; widens: boolean }>(
      await asUser(admin, 'POST', '/v1/admin/role-mappings/preview',
        { issuer: ISSUER, groupValue: GROUP, grantsRole: 'admin' }));
    expect(preview.sentence).toContain(GROUP);
    expect(preview.widens).toBe(true);
    expect(auditCount('role_mapping.created', id)).toBe(0);

    // CONFIRMED.
    const created = await asUser(admin, 'POST', '/v1/admin/role-mappings',
      { issuer: ISSUER, groupValue: GROUP, grantsRole: 'admin' });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(auditCount('role_mapping.created', id)).toBe(1);

    // CHANGED, then REMOVED.
    expect((await asUser(admin, 'PUT', `/v1/admin/role-mappings/${id}`,
      { grantsRole: 'reviewer' })).status).toBe(200);
    expect((await asUser(admin, 'DELETE', `/v1/admin/role-mappings/${id}`)).status).toBe(204);

    // THREE audit rows, not four: a preview is not an act. The plan's brief
    // said four; the shipped source writes one per WRITE and the preview
    // writes nothing, which is the behaviour the screen depends on.
    expect(auditCount('role_mapping.created', id)).toBe(1);
    expect(auditCount('role_mapping.changed', id)).toBe(1);
    expect(auditCount('role_mapping.removed', id)).toBe(1);

    // …AND NOT ONE DISPOSITION ROW. S22: one fact, one append-only table.
    // Administering role policy must never write into the record a lawyer's
    // judgements live in.
    expect(historyFingerprint()).toBe(beforeHistory);
  }, 120_000);

  it('takes effect on the NEXT REQUEST of a session already open, and stops when removed', async () => {
    /*
     * The clause the effect sentence ends with — *"including for anyone
     * already signed in"* — executed rather than reasoned about, on a token
     * minted BEFORE the change and never refreshed.
     *
     * The seeded realm gives each account exactly one group, and the
     * `reviewers` mapping it resolves through is deployment configuration,
     * which this route refuses to touch by design. So the row is flipped to
     * `source = 'admin'` first, as the migrator — the state a real
     * administrator's own mapping is in — and put back whatever happens.
     */
    const open = await signIn('trainee');
    expect(open.role).toBe('reviewer');
    const partnerOnly = '/v1/playbooks/stage5dod-no-such-playbook/versions';
    const id = idFor(LIVE_ISSUER, 'reviewers');
    try {
      expect((await asUser(open, 'POST', partnerOnly, {})).status).toBe(403);
      sql(`update role_mapping set source = 'admin'
            where issuer = '${LIVE_ISSUER}' and group_value = 'reviewers'`);

      expect((await asUser(admin, 'PUT', `/v1/admin/role-mappings/${id}`,
        { grantsRole: 'partner' })).status).toBe(200);
      // THE SAME TOKEN, no sign-in in between. The route now answers on its
      // own merits rather than at the role gate.
      const after = await asUser(open, 'POST', partnerOnly, {});
      expect(after.status).not.toBe(403);

      expect((await asUser(admin, 'PUT', `/v1/admin/role-mappings/${id}`,
        { grantsRole: 'reviewer' })).status).toBe(200);
      expect((await asUser(open, 'POST', partnerOnly, {})).status).toBe(403);
    } finally {
      sql(`update role_mapping
              set role = 'reviewer', source = 'configuration',
                  updated_at = null, updated_by_user_id = null
            where issuer = '${LIVE_ISSUER}' and group_value = 'reviewers'`);
      sql(`delete from audit_event where subject_id = '${id}'`);
    }
  }, 120_000);
});

/* ------------------------------------------------- the seed, across a restart */

describe('the startup seed owns the configuration half and nothing else (P52)', () => {
  it('survives a real restart: an admin row stays, a stale configuration row goes', async () => {
    const admins = `${GROUP}-2`;
    const id = idFor(ISSUER, admins);
    const stale = 'stage5dod-stale-configuration';

    const created = await asUser(admin, 'POST', '/v1/admin/role-mappings',
      { issuer: ISSUER, groupValue: admins, grantsRole: 'partner' });
    expect(created.status, await created.clone().text()).toBe(201);
    // A configuration row `API_ROLE_MAPPINGS` does not name, planted the
    // only way it can be: no route can write one, which is the point of
    // migration 015.
    sql(`insert into role_mapping (workspace_id, issuer, group_value, role, source)
         values ('${WS}', '${ISSUER}', '${stale}', 'reviewer', 'configuration')
         on conflict do nothing`);
    expect(sql(`select count(*) from role_mapping
                 where issuer = '${ISSUER}' and group_value = '${stale}'`)).toBe('1');

    compose(['restart', 'api'], 180_000);
    // Wait for the API to answer again rather than sleeping a guessed
    // interval: a fixed wait measures the machine, not the deployment.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const res = await fetch(`${API_BASE}/v1/me`, {
        headers: { authorization: `Bearer ${admin.token}` },
      }).catch(() => undefined);
      if (res?.status === 200) break;
      if (Date.now() > deadline) throw new Error('the api did not come back after a restart');
      await new Promise(r => setTimeout(r, 1000));
    }

    // THE ADMIN ROW SURVIVED. If the seed's delete-half lost its
    // `and source = 'configuration'`, every administrator's work would be
    // erased on every deploy and the screen would look like a save that
    // never happened.
    const page = await json<RoleMappingsPage>(
      await asUser(admin, 'GET', '/v1/admin/role-mappings'));
    const mine = page.mappings.find(m => m.id === id);
    expect(mine, 'the admin-authored mapping did not survive the restart').toBeDefined();
    expect(mine!.source).toBe('admin');

    // …AND CONFIGURATION STILL REVOKES. A row the variable no longer names
    // is gone. Waited for rather than asserted at a guessed instant: the API
    // answers `/v1/me` from whichever replica came back first, and the seed
    // is the other end of the same start-up. A deadline is what makes "the
    // seed never revoked" a failure rather than a race.
    const revoked = Date.now() + 60_000;
    for (;;) {
      if (sql(`select count(*) from role_mapping
                where issuer = '${ISSUER}' and group_value = '${stale}'`) === '0') break;
      if (Date.now() > revoked) {
        throw new Error('a configuration row API_ROLE_MAPPINGS no longer names survived a restart');
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // All three accounts still sign in — the sign-in path resolves through
    // the configuration rows the seed just rewrote.
    const [t, p, a] = await Promise.all([signIn('trainee'), signIn('partner'), signIn('admin')]);
    expect([t.role, p.role, a.role]).toEqual(['reviewer', 'partner', 'admin']);

    expect((await asUser(admin, 'DELETE', `/v1/admin/role-mappings/${id}`)).status).toBe(204);
  }, 300_000);
});

/* ------------------------------------- disabling, retiring, and the history */

describe('an account turned off, restored, and a name retired (P58)', () => {
  it('refuses a disabled person on their next request and leaves the history untouched', async () => {
    // A disposition of a real finding, so the fingerprint below is a
    // fingerprint of something. A vacuous "nothing changed" over an empty
    // table is the shape of a test that cannot fail.
    const seeded = await seedOneDoneFinding(trainee, 'stage5 dod history');
    litter.push({ who: trainee, seeded });
    expect((await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 1 })).status).toBe(200);
    const before = historyFingerprint();
    expect(Number(before.split(' ')[0])).toBeGreaterThan(0);

    const open = await signIn('trainee');
    try {
      expect((await asUser(admin, 'POST',
        `/v1/admin/users/${trainee.userId}/disable`)).status).toBe(200);
      // The SAME token, not refreshed.
      const refused = await asUser(open, 'GET', '/v1/matters');
      expect(refused.status).toBe(403);
      expect((await json<{ error: { code: string } }>(refused)).error.code)
        .toBe('account_disabled');
    } finally {
      expect((await asUser(admin, 'POST',
        `/v1/admin/users/${trainee.userId}/enable`)).status).toBe(200);
    }
    expect((await asUser(open, 'GET', '/v1/matters')).status).toBe(200);
    expect(historyFingerprint()).toBe(before);
  }, 180_000);

  it('retires a name through the real route, and rewrites NO history row', async () => {
    /*
     * A THROWAWAY PERSON, not a seeded account. Pseudonymisation is
     * irreversible through the application (`resolveActor` deliberately does
     * not restore `display_name`), so this is the only way to exercise the
     * shipped route over real HTTP without renaming somebody every later
     * suite depends on. `people.pg.test.ts` proves the same claim against
     * the database; this proves the ROUTE does it, as an administrator,
     * through nginx.
     */
    const subject = `stage5dod-${Date.now().toString(36)}`;
    // `psql` prints the returned row AND the command tag ("INSERT 0 1"), so
    // the value is the first line rather than the whole output.
    const id = sql(
      `insert into app_user
         (id, workspace_id, issuer, subject, display_name, initials, email, role, status)
       values (gen_random_uuid(), '${WS}', '${ISSUER}', '${subject}', 'X. Departed', 'XD',
               'x@example.invalid', 'reviewer', 'active')
       returning id`).split('\n')[0]!.trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const before = historyFingerprint();
    const res = await asUser(admin, 'POST', `/v1/admin/users/${id}/pseudonymise`);
    expect(res.status, await res.clone().text()).toBe(200);
    const view = await json<{ displayName: string; status: string; email?: string }>(res);

    expect(view.displayName).toBe(`Former user ${id.slice(0, 8)}`);
    expect(view.status).toBe('disabled');
    expect('email' in view).toBe(false);
    // The row itself, read past the route.
    expect(sql(`select coalesce(email, 'NULL') from app_user where id = '${id}'`)).toBe('NULL');
    // A SECOND call changes nothing further — the pseudonym is derived from
    // the id, so one person cannot come to look like two.
    expect((await asUser(admin, 'POST', `/v1/admin/users/${id}/pseudonymise`)).status).toBe(200);
    expect(sql(`select display_name from app_user where id = '${id}'`))
      .toBe(`Former user ${id.slice(0, 8)}`);

    // NO HISTORY ROW MOVED. This is the whole claim: the remedy §17 Q6 has
    // is a name, and the evidence a firm keeps is untouched by it.
    expect(historyFingerprint()).toBe(before);
    // …and the act itself is audited, with the old name NOT in the detail.
    expect(auditCount('user.pseudonymised', id)).toBe(2);
    expect(sql(`select coalesce(string_agg(detail::text, '|'), '-') from audit_event
                 where action = 'user.pseudonymised' and subject_id = '${id}'`))
      .not.toContain('Departed');
    sql(`delete from audit_event where subject_id = '${id}'`);
  }, 180_000);
});

/* --------------------------------------------------- providers and the export */

describe('what an administrator can read, and what no response carries', () => {
  it('answers the providers screen and carries no credential value anywhere in it', async () => {
    const res = await asUser(admin, 'GET', '/v1/admin/providers');
    expect(res.status).toBe(200);
    const text = await res.text();
    const page = JSON.parse(text) as { providers: ProviderStatus[] };
    expect(page.providers.length).toBeGreaterThan(0);
    // Every credential this stack is started with, swept out of the whole
    // body rather than out of the fields somebody remembered to check.
    for (const secret of ['recorded-provider-needs-no-key', 'lexprompt_app_dev',
      'lexprompt_migrator_dev', 'UseDevelopmentStorage']) {
      expect(text, secret).not.toContain(secret);
    }
    // The sanity half: the sweep can see one of those strings when present.
    expect(JSON.stringify({ k: 'recorded-provider-needs-no-key' }))
      .toContain('recorded-provider-needs-no-key');
    for (const p of page.providers) {
      for (const forbidden of ['last4', 'prefix', 'fingerprint', 'length', 'key', 'secret']) {
        expect(Object.keys(p), forbidden).not.toContain(forbidden);
      }
    }
  }, 60_000);

  it('takes a bounded extract whose manifest counts EXACTLY what it delivers', async () => {
    // A range that certainly holds this suite's own rows.
    const to = Date.now() + 60_000;
    const from = to - 6 * 60 * 60 * 1000;
    const res = await asUser(admin, 'GET', `/v1/admin/audit-export?from=${from}&to=${to}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { manifest, rows } = await json<AuditExport>(res);

    expect(manifest.workspaceId).toBe(WS);
    expect(manifest.from).toBe(from);
    expect(manifest.to).toBe(to);
    expect(manifest.takenByUserId).toBe(admin.userId);
    expect(manifest.complete).toBe(true);
    expect(manifest.timeZone.length).toBeGreaterThan(0);
    // EVERY SOURCE BY NAME, including one with no rows: an omitted source
    // reads as a source that was not covered.
    expect(manifest.sources.map(s => s.source))
      .toEqual(['audit_event', 'finding_disposition_event', 'run']);
    // The counts are the rows. Measured against what actually arrived rather
    // than against a second query.
    for (const s of manifest.sources) {
      expect(rows.filter(r => r.source === s.source), s.source).toHaveLength(s.rows);
    }
    expect(rows.length).toBe(manifest.sources.reduce((n, s) => n + s.rows, 0));
    // NOT VACUOUS: this suite has written audit rows and one disposition.
    expect(rows.length).toBeGreaterThan(0);
    expect(manifest.sources.find(s => s.source === 'audit_event')!.rows).toBeGreaterThan(0);
    // Oldest first, one chronology across three sources.
    expect(rows.map(r => r.at)).toEqual([...rows.map(r => r.at)].sort((a, b) => a - b));
  }, 60_000);

  it('refuses an UNBOUNDED range rather than defaulting it to everything', async () => {
    const res = await asUser(admin, 'GET', '/v1/admin/audit-export');
    expect(res.status).toBe(400);
    const body = await json<Record<string, unknown>>(res);
    expect('rows' in body).toBe(false);
    expect('manifest' in body).toBe(false);
    // …and a backwards range is refused too.
    expect((await asUser(admin, 'GET',
      '/v1/admin/audit-export?from=1000&to=0')).status).toBe(400);
  }, 60_000);
});

/* ------------------------------------------------------------------- egress */

describe('the api container still cannot reach the internet (Spike 2, compose half)', () => {
  it('fails to resolve a public host from inside the api container', () => {
    let output = '';
    let failed = false;
    try {
      output = compose(['exec', '-T', 'api', 'sh', '-lc',
        'wget -qO- --timeout=3 https://example.com'], 60_000);
    } catch (e) {
      failed = true;
      output = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    // RE-CHECKED, not inherited from Stage 1. §5's whole claim is that the
    // only host this container talks to is the gateway.
    expect(failed, `the api reached example.com: ${output.slice(0, 200)}`).toBe(true);
    expect(output.toLowerCase()).toMatch(/bad address|not resolve|no route|unreachable|refused/);
  }, 60_000);
});

/* ------------------------------------------------------- left as it was found */

describe('the stack is left exactly as it was found', () => {
  it('has three accounts with three roles, and none of this file s rows', async () => {
    const [t, p, a] = await Promise.all([signIn('trainee'), signIn('partner'), signIn('admin')]);
    expect([t.role, p.role, a.role]).toEqual(['reviewer', 'partner', 'admin']);
    expect(sql(`select count(*) from role_mapping where issuer = '${ISSUER}'`)).toBe('0');
    expect(sql(`select count(*) from role_mapping
                 where source = 'configuration' and issuer = '${LIVE_ISSUER}'`)).toBe('3');
    expect(sql("select count(*) from app_user where status <> 'active' "
      + "and subject not like 'stage5dod-%'")).toBe('0');
  }, 120_000);
});
