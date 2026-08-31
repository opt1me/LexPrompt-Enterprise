import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import { roleFor, seedRoleMappings } from '../src/auth/roles.ts';

const WS = '00000000-0000-0000-0000-000000000001';
const KC = 'http://keycloak:8080/realms/lexprompt';
const ENTRA = 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0';
/** An issuer no deployment seeds and no test maps, so a lookup against it
 *  returns no rows whatever the live `role_mapping` happens to hold. */
const NO_SUCH_ISSUER = 'https://no-such-issuer.invalid/realms/none';

const MAPPINGS = [
  // Keycloak: bare group NAMES, because the realm's mapper sets
  // `full.path` to false. Checked against infra/keycloak/lexprompt-realm.json
  // and against a REAL token minted by the running stack, whose `groups`
  // claim reads ["reviewers"] — not ["/reviewers"].
  { issuer: KC, groupValue: 'reviewers', role: 'reviewer' },
  { issuer: KC, groupValue: 'partners', role: 'partner' },
  { issuer: KC, groupValue: 'admins', role: 'admin' },
  // Entra: security-group OBJECT IDS. Same table, same lookup, same code —
  // which is the property this file exists to prove rather than assume.
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000001', role: 'reviewer' },
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000002', role: 'partner' },
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000003', role: 'admin' },
] as const;

const seed = (t: Parameters<typeof seedRoleMappings>[0]) =>
  seedRoleMappings(t, WS, MAPPINGS.map(m => ({ ...m })));

describe('roleFor, against both issuers', () => {
  it('maps a Keycloak group NAME to a role', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['partners'])).toBe('partner');
    }, migratorDb());
  });

  it('maps an Entra group OBJECT ID to a role, through the same code', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, ENTRA, ['8f2c1a55-0000-4000-8000-000000000002'])).toBe('partner');
    }, migratorDb());
  });

  it('does NOT let one issuer group grant a role under the other issuer', async () => {
    // The reason the primary key carries the issuer. A local realm's group
    // name must be worth nothing in a tenant, and vice versa.
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, ENTRA, ['admins']).catch((e: unknown) => e);
      expect((err as ModelError).code).toBe('no_role');
    }, migratorDb());
  });

  it('takes the HIGHEST role when a person is in several mapped groups', async () => {
    // admin > partner > reviewer. A person in reviewers and admins is an
    // admin: taking the lowest would mean ADDING a group could REMOVE
    // access, which nobody would predict.
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['reviewers', 'admins'])).toBe('admin');
      expect(await roleFor(t, KC, ['admins', 'reviewers'])).toBe('admin');
    }, migratorDb());
  });

  it('ignores unmapped groups alongside a mapped one', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['all-staff', 'london-office', 'reviewers'])).toBe('reviewer');
    }, migratorDb());
  });

  it('refuses a user in no mapped group, plainly, and not as an empty app', async () => {
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, KC, ['all-staff']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe('no_role');
      expect((err as ModelError).status).toBe(403);
      expect((err as ModelError).message).toMatch(/administrator/i);
      // Naming the groups is what makes the message actionable: an
      // administrator reading "you are in: all-staff" can map it; one
      // reading "no access" cannot do anything at all.
      expect((err as ModelError).message).toMatch(/all-staff/);
    }, migratorDb());
  });

  it('refuses an EMPTY group list the same way, and says which groups it saw', async () => {
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, KC, []).catch((e: unknown) => e) as ModelError;
      expect(err.code).toBe('no_role');
      expect(err.message).toMatch(/no groups/i);
    }, migratorDb());
  });
});

describe('seedRoleMappings makes the table EQUAL the configuration', () => {
  it('rewrites a role that changed, rather than leaving the old one beside it', async () => {
    await withPg(async t => {
      await seedRoleMappings(t, WS, [{ issuer: KC, groupValue: 'partners', role: 'reviewer' }]);
      await seedRoleMappings(t, WS, [{ issuer: KC, groupValue: 'partners', role: 'partner' }]);
      expect(await roleFor(t, KC, ['partners'])).toBe('partner');
    }, migratorDb());
  });

  it('marks every row it writes as `configuration`, which is what the delete-half is scoped by', async () => {
    // Migration 015 split this table between two writers. The seed writing a
    // row WITHOUT `source = 'configuration'` would take the column's default
    // — which is the same value — and so would look correct here; what it
    // would NOT do is convert an admin row it collided with, and the row
    // would keep a source its content no longer matches. Asserted directly
    // because it is the field the delete's own predicate reads.
    await withPg(async t => {
      await seed(t);
      const rows = await t.query<{ source: string }>(
        'select source from role_mapping where issuer = $1', [KC]);
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.source === 'configuration')).toBe(true);
    }, migratorDb());
  });

  it('REVOKES a mapping the configuration no longer names', async () => {
    // `role_mapping` is deployment configuration in this stage: the app role
    // holds no write grant, so removing the entry from API_ROLE_MAPPINGS and
    // redeploying is the ONLY way an administrator takes a role away. An
    // upsert-only seed would leave the row granting `admin` forever while
    // the configuration said otherwise — a revocation that silently did not
    // happen.
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['admins'])).toBe('admin');
      await seedRoleMappings(t, WS, [{ issuer: KC, groupValue: 'reviewers', role: 'reviewer' }]);
      const err = await roleFor(t, KC, ['admins']).catch((e: unknown) => e) as ModelError;
      expect(err.code).toBe('no_role');
      expect(await roleFor(t, KC, ['reviewers'])).toBe('reviewer');
    }, migratorDb());
  });

  it('leaves ANOTHER workspace\u2019s mappings alone', async () => {
    // The sweep is scoped to workspace_id, so one workspace\u2019s deployment
    // cannot empty another\u2019s table. §6 has one workspace today; the scope is
    // what stops that being an assumption baked into a DELETE.
    const OTHER = '00000000-0000-0000-0000-0000000000ff';
    await withPg(async t => {
      await t.query('insert into workspace (id, name) values ($1, $2)', [OTHER, 'Other']);
      await seedRoleMappings(t, OTHER, [{ issuer: KC, groupValue: 'others', role: 'admin' }]);
      await seed(t);
      const rows = await t.query<{ workspace_id: string }>(
        'select workspace_id from role_mapping where group_value = $1', ['others']);
      expect(rows).toHaveLength(1);
    }, migratorDb());
  });
});

describe('the role a request runs under is READ by the app role, and its CONFIGURATION half is writable by nobody', () => {
  // roleFor runs on the app connection in production (main.ts resolves the
  // actor inside `db.tx`), so the SELECT grant in 001_identity.sql is
  // load-bearing on the sign-in path: without it every sign-in in the firm
  // fails at once. Proved by running the real query as the real role.
  it('the app role can run roleFor\u2019s lookup', async () => {
    await withPg(async t => {
      // NO_SUCH_ISSUER, not `KC` (Part 2A m6). The stated reason used to be
      // "no rows are visible inside this rolled-back transaction", and that
      // was not why it passed: these suites run against the LIVE database,
      // whose `role_mapping` carries the rows `compose:up` seeded — and it
      // passed only because the deployed issuer is
      // `http://localhost:8088/realms/lexprompt` (the BROWSER issuer) while
      // this file's `KC` is the container address. A deployment that set
      // `OIDC_ISSUER_BROWSER` to the container address — a configuration
      // `config.ts`'s own refusal message warns about — would resolve
      // `roleFor(t, KC, ['reviewers'])` to 'reviewer' and fail a test about
      // GRANTS for a reason that has nothing to do with grants.
      //
      // An issuer nothing can ever have a mapping for makes the stated
      // reason true whatever the live table holds, and keeps the property
      // this case was written for: the SELECT SUCCEEDS and returns no rows,
      // so the refusal is LexPrompt's `no_role` rather than Postgres
      // refusing the read. Revoke the app role's SELECT on `role_mapping`
      // and this fails with a permission error instead.
      const err = await roleFor(t, NO_SUCH_ISSUER, ['reviewers']).catch((e: unknown) => e);
      // The honest outcome is `no_role` — what matters is that it is LexPrompt
      // refusing, not Postgres refusing the read.
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe('no_role');
    });
  });

  it('the app role cannot INSERT a CONFIGURATION role mapping, so no request can supersede the deployment', async () => {
    /*
     * NARROWED BY MIGRATION 015 (P51), not deleted. The describe's heading
     * said "WRITABLE by nobody" and that was true of Stage 2's table; §7 has
     * always said the table is admin-editable, and 015 gives the app role
     * the three write verbs bounded by row-level security to `source =
     * 'admin'`.
     *
     * What this case was protecting survives exactly: a request cannot write
     * the half of the table `API_ROLE_MAPPINGS` owns. The refusal moved from
     * the grant to the policy, so the message moved with it.
     */
    await withPg(async t => {
      const err = await t.query(
        `insert into role_mapping (workspace_id, issuer, group_value, role, source)
         values ($1,$2,$3,$4,'configuration')`,
        [WS, KC, 'attackers', 'admin'],
      ).catch((e: unknown) => e) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/row-level security/i);
    });
  });
});
