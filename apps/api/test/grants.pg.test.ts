import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, withPg, workerDb } from './helpers/pgHarness.ts';
import type { Tx } from '../src/db/pool.ts';

const WS = '00000000-0000-0000-0000-000000000001';

async function aPlaybookAndVersion(t: Tx, playbookId: string, versionId: string): Promise<void> {
  await t.query(
    `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
     values ($1, $2, 'P', now(), now(), 1)`, [playbookId, WS]);
  await t.query(
    `insert into playbook_version (id, workspace_id, playbook_id, version_number, content, published_at)
     values ($1, $2, $3, 1, '{}'::jsonb, now())`, [versionId, WS, playbookId]);
}

describe('a published playbook version is immutable by GRANT, not by convention', () => {
  it('lets the app role INSERT a version', async () => {
    // The positive half. Without it, a revoke of every grant would pass the
    // two below and break publishing entirely.
    await withPg(async t => {
      await aPlaybookAndVersion(t, 'pv-ins-pb', 'pv-ins-v1');
      const rows = await t.query<{ n: string }>(
        "select count(*)::text n from playbook_version where id = 'pv-ins-v1'");
      expect(rows[0].n).toBe('1');
    }, appDb());
  });

  it('refuses an UPDATE by the app role', async () => {
    await withPg(async t => {
      await aPlaybookAndVersion(t, 'pv-upd-pb', 'pv-upd-v1');
      await expect(t.query("update playbook_version set summary = 'rewritten' where id = 'pv-upd-v1'"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('refuses a DELETE by the app role', async () => {
    await withPg(async t => {
      await aPlaybookAndVersion(t, 'pv-del-pb', 'pv-del-v1');
      await expect(t.query("delete from playbook_version where id = 'pv-del-v1'"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  // That last case is the one that makes the suite mean something. Without
  // it, a `playbook_version` table that does not exist would also produce
  // "permission denied"-shaped failures, and three green tests would be
  // proving nothing.
  it('…and the migrator CAN, which is what makes the refusal above about the role and not the table', async () => {
    await withPg(async t => {
      await aPlaybookAndVersion(t, 'pv-mig-pb', 'pv-mig-v1');
      await expect(t.query("update playbook_version set summary = summary where id = 'pv-mig-v1'"))
        .resolves.toBeDefined();
    }, migratorDb());
  });
});

describe('the app role has no write on a CONFIGURATION role mapping, and none at all on workspace', () => {
  /*
   * NARROWED BY MIGRATION 015, NOT DELETED (P51).
   *
   * Until 015 the app role held no write grant on `role_mapping` at all, and
   * this case asserted `permission denied`. §7 has always said the table is
   * admin-editable, so 015 gives the app role `insert, update, delete` and
   * bounds it, by row-level security, to `source = 'admin'` rows — the seed
   * keeps the configuration half, and `lexprompt_migrator` owns the table so
   * RLS (enabled WITHOUT `force`) does not apply to it.
   *
   * What this case protected is unchanged and is asserted here: NO REQUEST
   * MAY WRITE A DEPLOYMENT-CONFIGURATION ROW. The refusal is now the policy
   * rather than the grant, so the message is Postgres's row-level-security
   * one. `roleMappingGrants.pg.test.ts` is where the whole boundary lives,
   * verb by verb, including the positive half that makes each refusal about
   * the ROW rather than about a missing grant.
   */
  it('the app role cannot insert a CONFIGURATION role mapping', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into role_mapping (workspace_id, issuer, group_value, role, source)
         values ($1, 'i', 'g', 'reviewer', 'configuration')`,
        [WS],
      )).rejects.toThrow(/row-level security/i);
    }, appDb());
  });

  it('…and cannot insert one that names no source at all', async () => {
    // The column DEFAULTS to 'configuration', so an omitted `source` is
    // refused by the policy rather than quietly becoming deployment
    // configuration. Asserted here as well as in `roleMappingGrants` because
    // this is the file a reader opens to ask "what may a request write".
    await withPg(async t => {
      await expect(t.query(
        "insert into role_mapping (workspace_id, issuer, group_value, role) values ($1, 'i', 'g2', 'reviewer')",
        [WS],
      )).rejects.toThrow(/row-level security/i);
    }, appDb());
  });

  it('the app role holds nothing at all on workspace', async () => {
    // The describe has named `workspace` since Stage 2 and no case ever
    // asserted it — the sibling half of a pair, missing, in a file whose
    // whole subject is what a role may do. Migration 015 widened the OTHER
    // half of this describe's subject, so the untouched half is written down
    // here rather than left as a claim in a heading.
    // TWO transactions, not two statements in one: the first refusal aborts
    // the transaction, so a second statement inside it comes back with
    // "current transaction is aborted" and the assertion would be testing
    // Postgres's error cascade rather than the grant.
    await withPg(async t => {
      await expect(t.query("insert into workspace (id, name) values (gen_random_uuid(), 'sneaky')"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
    await withPg(async t => {
      await expect(t.query("update workspace set name = 'renamed' where id = $1", [WS]))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });
});

describe('the app role has ordinary read/write on the six mutable record tables', () => {
  it('lets the app role UPDATE and DELETE a matter', async () => {
    await withPg(async t => {
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at) values ('m-rw', $1, 'M', now(), now())`,
        [WS]);
      await expect(t.query("update matter set name = 'M2' where id = 'm-rw'")).resolves.toBeDefined();
      await expect(t.query("delete from matter where id = 'm-rw'")).resolves.toBeDefined();
    }, appDb());
  });
});

describe('the engine holds no grant on assignment (Task 24)', () => {
  it('refuses the worker role a SELECT, and refuses it an INSERT', async () => {
    /*
     * The worker performs no act that assigns anything and reads nothing
     * that depends on one, so it holds nothing on this table -- the same
     * shape 006 gives the disposition tables and 012 gives `audit_event`,
     * and stated as an explicit `revoke` in 013 rather than as an absent
     * grant, because an absent grant is undone by one careless `grant all`.
     *
     * Attempted AS THE ROLE. A refusal proved any other way is a refusal
     * about the code rather than about the database.
     */
    await withPg(async t => {
      await expect(t.query('select id from assignment limit 1'))
        .rejects.toThrow(/permission denied/i);
    }, workerDb());
    await withPg(async t => {
      await expect(t.query(
        `insert into assignment
           (id, review_id, findings_key, clause_id, workspace_id,
            assignee_user_id, assigned_by_user_id)
         values ('a1', 'r', 'k', 'c', $1, $1, $1)`, [WS],
      )).rejects.toThrow(/permission denied/i);
    }, workerDb());
  });

  it('…and the app role CAN read it, which is what makes the refusal about the role', async () => {
    // Without this half, a table that did not exist would pass the test
    // above for entirely the wrong reason.
    await withPg(async t => {
      await expect(t.query('select id from assignment limit 1')).resolves.toBeDefined();
    }, appDb());
  });
});
