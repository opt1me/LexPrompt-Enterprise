import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';

/**
 * PSEUDONYMISING A PERSON — what it changes, and everything it does not.
 *
 * §17 Q6 asks what a firm can do when somebody asks to be erased.
 * `audit_event` is insert-only by grant and `finding_disposition_event` is
 * append-only history; `001_identity.sql` gives the app role no `delete` on
 * `app_user` at all, *"because deleting one would orphan every attribution
 * they authored"*. So the whole of the remedy is ONE ROW, and the claim
 * worth testing is not what changed but what did NOT.
 *
 * ## Why this is a pg suite rather than a compose one
 *
 * The assertion is a byte-for-byte comparison of history rows either side of
 * the call, which needs history rows to exist — planted here directly, as
 * the migrator, alongside a throwaway person nothing else uses.
 *
 * It also must NOT run against a seeded account. Pseudonymisation is
 * irreversible through the application (`resolveActor` deliberately does not
 * restore `display_name`), so a compose test that pseudonymised the trainee
 * would rename them permanently for every suite that follows.
 *
 * ## This suite COMMITS
 *
 * A route's own transaction and a `withPg` rollback cannot both be the
 * outermost, and the history comparison has to see the route's committed
 * effect. Everything it plants is deleted in `afterEach`, as the migrator.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const ADMIN_USER = '00000000-0000-0000-0000-0000000000d1';
const SUBJECT_USER = '00000000-0000-0000-0000-0000000000d2';
const MATTER = 'people-m1';
const REVIEW = 'people-r1';

const seed = migratorDb();

function adminApi(): FastifyInstance {
  const { app } = buildTestApi({
    principal: { issuer: 'i', subject: 's-admin-people', groups: ['admins'] },
    db: appDb(),
    actor: {
      id: ADMIN_USER, displayName: 'An Admin', initials: 'AA',
      role: 'admin', workspaceId: WS,
    },
  });
  return app;
}

async function plant(): Promise<void> {
  await seed.query(
    `insert into app_user (id, workspace_id, issuer, subject, email, display_name, initials,
                           role, status)
     values ($1, $2, 'i', 's-admin-people', 'admin@x', 'An Admin', 'AA', 'admin', 'active')
     on conflict (id) do nothing`, [ADMIN_USER, WS]);
  await seed.query(
    `insert into app_user (id, workspace_id, issuer, subject, email, display_name, initials,
                           role, status)
     values ($1, $2, 'i', 's-leaver', 'leaver@example.com', 'P Leaver', 'PL', 'reviewer',
             'active')
     on conflict (id) do nothing`, [SUBJECT_USER, WS]);
  await seed.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'People', now(), now()) on conflict (id) do nothing`, [MATTER, WS]);
  await seed.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [REVIEW, WS, MATTER]);
  await seed.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ($1, 'd1', 'c1', $2, 'done') on conflict do nothing`, [REVIEW, WS]);
  await seed.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count, by_user_id, at)
     values ($1, 'd1', 'c1', $2, 'verified', 1, $3, now()) on conflict do nothing`,
    [REVIEW, WS, SUBJECT_USER]);
  // THE ATTRIBUTION THAT MUST SURVIVE: a judgement this person recorded.
  await seed.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, by_user_id, at,
        cause)
     values ($1, 'd1', 'c1', $2, 'unchecked', 'verified', $3, now(), 'human')`,
    [REVIEW, WS, SUBJECT_USER]);
}

async function uproot(): Promise<void> {
  await seed.query('delete from audit_event where subject_id = $1', [SUBJECT_USER]);
  await seed.query('delete from review where id = $1', [REVIEW]);
  await seed.query('delete from matter where id = $1', [MATTER]);
  await seed.query('delete from app_user where id = any($1::uuid[])',
    [[ADMIN_USER, SUBJECT_USER]]);
}

beforeAll(uproot);
afterEach(uproot);

interface HistoryRow {
  id: string; by_user_id: string; from_state: string; to_state: string; at: Date;
}

const history = (): Promise<HistoryRow[]> => seed.query<HistoryRow>(
  `select id::text as id, by_user_id::text as by_user_id, from_state, to_state, at
     from finding_disposition_event where review_id = $1 order by id`, [REVIEW]);

const userRow = (): Promise<{ display_name: string; initials: string; email: string | null;
  status: string }[]> => seed.query(
    'select display_name, initials, email, status from app_user where id = $1', [SUBJECT_USER]);

const call = (app: FastifyInstance, verb: string, id = SUBJECT_USER) => app.inject({
  method: 'POST', url: `/v1/admin/users/${id}/${verb}`,
  headers: { authorization: 'Bearer t' }, payload: {} as never,
});

describe('pseudonymise', () => {
  it('replaces the name and email and TOUCHES NO HISTORY ROW (P58)', async () => {
    await plant();
    const app = adminApi();
    try {
      const before = await history();
      expect(before).toHaveLength(1);
      expect((await call(app, 'pseudonymise')).statusCode).toBe(200);
      const after = await history();
      // Byte for byte, foreign keys intact. The attribution survives; the
      // name does not.
      expect(after).toEqual(before);
      expect(after[0].by_user_id).toBe(SUBJECT_USER);

      const [u] = await userRow();
      expect(u.display_name).toMatch(/^Former user /);
      expect(u.email).toBeNull();
      expect(u.initials).toMatch(/^F/);
    } finally { await app.close(); }
  });

  it('is STABLE — a second call changes nothing further', async () => {
    await plant();
    const app = adminApi();
    try {
      await call(app, 'pseudonymise');
      const first = await userRow();
      await call(app, 'pseudonymise');
      // A RANDOM pseudonym would make one person look like two in a history
      // that still names them by the same id.
      expect(await userRow()).toEqual(first);
    } finally { await app.close(); }
  });

  it('also DISABLES, because an account that can still sign in under a retired name is not retired',
    async () => {
      await plant();
      const app = adminApi();
      try {
        await call(app, 'pseudonymise');
        expect((await userRow())[0].status).toBe('disabled');
      } finally { await app.close(); }
    });

  it('does not put the retired name into audit_event, the one table nothing can erase', async () => {
    await plant();
    const app = adminApi();
    try {
      await call(app, 'pseudonymise');
      const rows = await seed.query<{ action: string; detail: Record<string, unknown> }>(
        `select action, detail from audit_event where subject_id = $1`, [SUBJECT_USER]);
      expect(rows.map(r => r.action)).toEqual(['user.pseudonymised']);
      // An audit row carrying the old name would put it back into the record
      // this route exists to take it out of, which would make the whole
      // feature false.
      expect(JSON.stringify(rows[0].detail)).not.toContain('Leaver');
      expect(JSON.stringify(rows[0].detail)).not.toContain('leaver@example.com');
    } finally { await app.close(); }
  });

  it('refuses an administrator acting on THEMSELVES, for either verb', async () => {
    await plant();
    const app = adminApi();
    try {
      for (const verb of ['disable', 'pseudonymise']) {
        const res = await call(app, verb, ADMIN_USER);
        expect(res.statusCode, verb).toBe(409);
        expect((res.json() as { error: { code: string } }).error.code).toBe('cannot_disable_self');
      }
      const [me] = await seed.query<{ status: string; display_name: string }>(
        'select status, display_name from app_user where id = $1', [ADMIN_USER]);
      expect(me).toEqual({ status: 'active', display_name: 'An Admin' });
    } finally { await app.close(); }
  });

  it('answers 404 for a person this workspace does not have, rather than a quiet no-op', async () => {
    await plant();
    const app = adminApi();
    try {
      const res = await call(app, 'disable', '00000000-0000-0000-0000-0000000000ff');
      expect(res.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('disable and enable', () => {
  it('sets the status, restores it, and audits both acts', async () => {
    await plant();
    const app = adminApi();
    try {
      expect((await call(app, 'disable')).statusCode).toBe(200);
      expect((await userRow())[0].status).toBe('disabled');
      expect((await call(app, 'enable')).statusCode).toBe(200);
      expect((await userRow())[0].status).toBe('active');
      const rows = await seed.query<{ action: string }>(
        'select action from audit_event where subject_id = $1 order by at', [SUBJECT_USER]);
      expect(rows.map(r => r.action)).toEqual(['user.disabled', 'user.enabled']);
    } finally { await app.close(); }
  });

  it('leaves the person s NAME alone when it only turns the account off', async () => {
    // Disabling and retiring a name are different acts with different
    // consequences, and only one of them is irreversible.
    await plant();
    const app = adminApi();
    try {
      await call(app, 'disable');
      expect((await userRow())[0].display_name).toBe('P Leaver');
      expect((await userRow())[0].email).toBe('leaver@example.com');
    } finally { await app.close(); }
  });
});
