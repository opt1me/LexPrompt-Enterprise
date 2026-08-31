import { describe, it, expect, afterAll } from 'vitest';
import { appDb, migratorDb, workerDb } from './helpers/pgHarness.ts';

/**
 * WHAT THE APP ROLE MAY WRITE TO `role_mapping` (P51), proved against the
 * real database as the real roles.
 *
 * ## Why this suite does not use `withPg`
 *
 * Every other pg suite runs inside one rolled-back transaction. This one
 * cannot: half its assertions are "the app role attempted X and the MIGRATOR
 * still sees the row unchanged", which is two roles on two connections, and
 * a row written inside one role's uncommitted transaction is invisible to
 * the other. So the fixtures are committed by the migrator and deleted by
 * the migrator in `afterAll` — as the migrator, because the app role cannot
 * delete a configuration row, which is the point of the whole file.
 *
 * A role mapping left behind changes who can do what in every suite that
 * runs afterwards, so the cleanup is not tidiness.
 *
 * ## The group values are namespaced
 *
 * `stage5-grants-*` under an ISSUER nothing deploys, so nothing this file
 * writes can grant anybody anything in the running stack even for the
 * milliseconds it exists.
 */
const WS = '00000000-0000-0000-0000-000000000001';
const ISSUER = 'https://stage5-grants.invalid/realms/none';

const CFG = 'stage5-grants-cfg';
const ADMIN_ROW = 'stage5-grants-admin';
const NEW_ADMIN = 'stage5-grants-a';
const NEW_CFG = 'stage5-grants-b';
const NO_SOURCE = 'stage5-grants-c';
const MIGRATOR_CFG = 'stage5-grants-d';

const ALL = [CFG, ADMIN_ROW, NEW_ADMIN, NEW_CFG, NO_SOURCE, MIGRATOR_CFG];

interface Row { role: string; source: string; group_value: string }

async function reseed(): Promise<void> {
  await migratorDb().query(
    'delete from role_mapping where issuer = $1 and group_value = any($2::text[])',
    [ISSUER, ALL]);
  await migratorDb().query(
    `insert into role_mapping (workspace_id, issuer, group_value, role, source)
     values ($1, $2, $3, 'reviewer', 'configuration'),
            ($1, $2, $4, 'partner',  'admin')`,
    [WS, ISSUER, CFG, ADMIN_ROW]);
}

async function rowsOf(...groups: string[]): Promise<Row[]> {
  return migratorDb().query<Row>(
    `select group_value, role, source from role_mapping
      where issuer = $1 and group_value = any($2::text[]) order by group_value`,
    [ISSUER, groups]);
}

/*
 * THE FIXTURES ARE REBUILT PER TEST, not in a `beforeAll`, and that is a
 * mutation-testing decision rather than a style one.
 *
 * `alter table role_mapping force row level security` — the one-line change
 * that breaks the startup seed — stops the MIGRATOR writing this table. With
 * the fixtures in a `beforeAll` that mutation killed the HOOK: vitest
 * reported all eleven cases as SKIPPED, and the named test that is supposed
 * to catch it (*"the MIGRATOR is unaffected by the policy"*) never ran at
 * all. A mutation that turns a suite grey instead of red is a mutation
 * nobody can point at a test for.
 *
 * Rebuilding per test also makes each case independent of the order the
 * others ran in.
 */
afterAll(async () => {
  await migratorDb().query(
    'delete from role_mapping where issuer = $1 and group_value = any($2::text[])',
    [ISSUER, ALL]);
});

describe('what the APP role may write to role_mapping (P51)', () => {
  it('reads every row, whatever its source', async () => {
    await reseed();
    // THE CASE THE `for all` MUTATION KILLS. One `for all to lexprompt_app
    // using (source = 'admin')` in place of the three write policies passes
    // every write assertion in this file and narrows the READ to admin rows
    // — which is every sign-in through a configured mapping failing at
    // once, in production, with nothing here going red but this.
    const rows = await appDb().query<Row>(
      `select group_value, source from role_mapping
        where issuer = $1 and group_value = any($2::text[]) order by source`,
      [ISSUER, [CFG, ADMIN_ROW]]);
    expect(rows.map(r => r.source)).toEqual(['admin', 'configuration']);
  });

  it('inserts an admin row', async () => {
    await reseed();
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, $3, 'reviewer', 'admin')`, [WS, ISSUER, NEW_ADMIN])).resolves.toBeDefined();
    expect((await rowsOf(NEW_ADMIN))[0]).toMatchObject({ role: 'reviewer', source: 'admin' });
  });

  it('CANNOT insert a configuration row', async () => {
    await reseed();
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, $3, 'admin', 'configuration')`, [WS, ISSUER, NEW_CFG]))
      .rejects.toThrow(/row-level security/i);
    expect(await rowsOf(NEW_CFG)).toEqual([]);
  });

  it('CANNOT insert without naming a source — the DEFAULT is refused, not applied', async () => {
    await reseed();
    // The column defaults to 'configuration' (so migration 015 back-fills
    // correctly), which means an INSERT that omits it is refused by the
    // policy rather than quietly becoming deployment configuration. That is
    // the direction that fails loudly.
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role)
       values ($1, $2, $3, 'admin')`, [WS, ISSUER, NO_SOURCE]))
      .rejects.toThrow(/row-level security/i);
    expect(await rowsOf(NO_SOURCE)).toEqual([]);
  });

  it('CANNOT update a configuration row — not its role, not its source, not anything', async () => {
    await reseed();
    for (const stmt of [
      `update role_mapping set role = 'admin' where issuer = $1 and group_value = $2`,
      `update role_mapping set source = 'admin' where issuer = $1 and group_value = $2`,
    ]) {
      const before = await rowsOf(CFG);
      await appDb().query(stmt, [ISSUER, CFG]).catch(() => { /* see below */ });
      const after = await rowsOf(CFG);
      // An UPDATE that matches no row under RLS AFFECTS NOTHING and does not
      // throw. So the assertion is over the DATA, not over an exception —
      // asserting only `.rejects` here would pass against a policy that
      // silently did nothing, and would also pass against no policy at all
      // if the statement happened to error for another reason.
      expect(after).toEqual(before);
      expect(after[0]).toMatchObject({ role: 'reviewer', source: 'configuration' });
    }
  });

  it('CANNOT promote an admin row to configuration', async () => {
    await reseed();
    await appDb().query(
      `update role_mapping set source = 'configuration' where issuer = $1 and group_value = $2`,
      [ISSUER, ADMIN_ROW]).catch(() => { /* the WITH CHECK raises; the data is the assertion */ });
    expect((await rowsOf(ADMIN_ROW))[0].source).toBe('admin');
  });

  it('CAN update an admin row it owns, which is what makes the refusals above about the ROW', async () => {
    await reseed();
    // Without this the five refusals could all be produced by an absent
    // grant, and the suite would prove "the app cannot write this table" —
    // which is what shipped BEFORE this migration.
    await expect(appDb().query(
      `update role_mapping set role = 'admin' where issuer = $1 and group_value = $2`,
      [ISSUER, ADMIN_ROW])).resolves.toBeDefined();
    expect((await rowsOf(ADMIN_ROW))[0].role).toBe('admin');
    await migratorDb().query(
      `update role_mapping set role = 'partner' where issuer = $1 and group_value = $2`,
      [ISSUER, ADMIN_ROW]);
  });

  it('CANNOT delete a configuration row, and CAN delete an admin one', async () => {
    await reseed();
    await appDb().query(
      'delete from role_mapping where issuer = $1 and group_value = $2', [ISSUER, CFG])
      .catch(() => { /* a DELETE matching no row under RLS does not throw */ });
    expect(await rowsOf(CFG)).toHaveLength(1);

    await migratorDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, $3, 'reviewer', 'admin')
       on conflict (issuer, group_value) do update set source = 'admin'`,
      [WS, ISSUER, NEW_ADMIN]);
    await appDb().query(
      'delete from role_mapping where issuer = $1 and group_value = $2', [ISSUER, NEW_ADMIN]);
    expect(await rowsOf(NEW_ADMIN)).toEqual([]);
  });

  it('the WORKER role holds nothing on role_mapping, not even select', async () => {
    await expect(workerDb().query('select 1 from role_mapping')).rejects.toThrow(/permission denied/i);
  });

  it('the MIGRATOR is unaffected by the policy — it owns the table', async () => {
    await reseed();
    // Without this the seed silently stops working and the only symptom is
    // that role mappings stop being revoked by configuration. `force row
    // level security` is the one-line change that breaks it.
    await expect(migratorDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, $3, 'reviewer', 'configuration')`, [WS, ISSUER, MIGRATOR_CFG]))
      .resolves.toBeDefined();
    expect((await rowsOf(MIGRATOR_CFG))[0].source).toBe('configuration');
  });
});

describe('what `select … for update` can see, which a handler has to know', () => {
  it('LOCKS an admin row and CANNOT see a configuration one, though a plain select sees both', async () => {
    await reseed();
    /*
     * Postgres applies the UPDATE policy's USING clause to a locking
     * SELECT, and silently drops the rows that fail it. So a
     * last-admin-mapping guard written as `select … where role = 'admin'
     * for update` would not see an admin mapping that came from
     * `API_ROLE_MAPPINGS`, would count one fewer than exists, and would
     * refuse a delete that was perfectly safe.
     *
     * `routes/admin/roleMappings.ts` therefore locks and counts in two
     * statements, in that order, and this case is why. Discovered by
     * probing the database rather than by reading the manual.
     */
    const c = await appDb().query<{ group_value: string }>(
      `select group_value from role_mapping
        where issuer = $1 and group_value = any($2::text[]) order by group_value`,
      [ISSUER, [CFG, ADMIN_ROW]]);
    expect(c.map(r => r.group_value)).toEqual([ADMIN_ROW, CFG].sort());

    await appDb().tx(async t => {
      const locked = await t.query<{ group_value: string }>(
        `select group_value from role_mapping
          where issuer = $1 and group_value = any($2::text[]) for update`,
        [ISSUER, [CFG, ADMIN_ROW]]);
      expect(locked.map(r => r.group_value)).toEqual([ADMIN_ROW]);
    });
  });
});
