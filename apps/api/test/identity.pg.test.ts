import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, withPg } from './helpers/pgHarness.ts';

const WS = '00000000-0000-0000-0000-000000000001';
// NOT `as const`: `Db.query`'s second parameter is `unknown[]` (mutable), and
// an `as const` tuple's values array comes back `readonly [...]`, which does
// not satisfy it — the brief's reference code failed `npm run typecheck`
// exactly this way.
const insertUser = (subject: string, issuer = 'https://issuer.test', role = 'reviewer'): [string, unknown[]] =>
  [`insert into app_user
      (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
    values (gen_random_uuid(), $1, $2, $3, 'a@x', 'A', 'A', $4, 'active')`,
   [WS, issuer, subject, role]];

describe('001_identity', () => {
  it('seeds exactly one workspace', async () => {
    const rows = await migratorDb().query<{ n: string }>('select count(*)::text n from workspace');
    expect(rows[0].n).toBe('1');
  });

  it('keys a person on (issuer, subject) and refuses a duplicate pair', async () => {
    await withPg(async t => {
      await t.query(...insertUser('sub-1'));
      await expect(t.query(...insertUser('sub-1'))).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('lets the SAME subject exist under a DIFFERENT issuer', async () => {
    // Not a curiosity. A Keycloak `sub` and an Entra `oid` are both opaque
    // strings and neither is ever compared with the other (§7). A unique
    // constraint on `subject` alone would make one issuer's account collide
    // with the other's — a bug only ever met in a tenant.
    await withPg(async t => {
      await t.query(...insertUser('collide', 'http://keycloak:8080/realms/lexprompt'));
      await t.query(...insertUser('collide', 'https://login.microsoftonline.com/t/v2.0'));
      const rows = await t.query<{ n: string }>("select count(*)::text n from app_user where subject = 'collide'");
      expect(rows[0].n).toBe('2');
    });
  });

  it('refuses a role outside the three', async () => {
    await withPg(async t => {
      await expect(t.query(...insertUser('sub-2', 'https://issuer.test', 'superuser')))
        .rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a status outside active/disabled', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into app_user (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
         values (gen_random_uuid(), $1, 'i', 's', 'a@x', 'A', 'A', 'reviewer', 'pending')`, [WS],
      )).rejects.toThrow(/check constraint/i);
    });
  });

  it('keys role_mapping on (issuer, group_value), so two issuers can name one role differently', async () => {
    await withPg(async t => {
      await t.query(
        `insert into role_mapping (workspace_id, issuer, group_value, role) values
           ($1, 'http://keycloak:8080/realms/lexprompt', 'partners', 'partner'),
           ($1, 'https://login.microsoftonline.com/t/v2.0', '8f2c1a55-0000-4000-8000-000000000002', 'partner')`,
        [WS],
      );
      // Counts ITS OWN TWO ROWS, not every partner mapping in the database.
      //
      // The unscoped count passed only while nothing ever wrote to
      // `role_mapping`. Since Task 4 the api container seeds the configured
      // mappings at startup and commits them, and these suites run against
      // that same database through `scripts/pg-forward.sh` — so a table-wide
      // count now reads the live stack's `partners -> partner` row as well
      // and fails with 3, in a test about primary keys. Scoping it to the
      // pair of rows this test inserted is what the assertion was always
      // trying to say.
      const rows = await t.query<{ n: string }>(
        `select count(*)::text n from role_mapping
          where role = 'partner'
            and (issuer, group_value) in (
              ('http://keycloak:8080/realms/lexprompt', 'partners'),
              ('https://login.microsoftonline.com/t/v2.0', '8f2c1a55-0000-4000-8000-000000000002'))`);
      expect(rows[0].n).toBe('2');
    }, migratorDb());
  });

  it('gives the app role what a request needs on app_user, and nothing on workspace', async () => {
    await withPg(async t => {
      await expect(t.query('select count(*) from app_user')).resolves.toBeDefined();
      await expect(t.query("insert into workspace (id, name) values (gen_random_uuid(), 'sneaky')"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('gives the app role no DELETE on app_user — disabling is the mechanism, not deletion', async () => {
    await withPg(async t => {
      await expect(t.query("delete from app_user where subject = 'nobody'"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });
});
