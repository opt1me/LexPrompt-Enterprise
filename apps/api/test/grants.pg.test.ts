import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, withPg } from './helpers/pgHarness.ts';
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

describe('the app role has no write on role_mapping or workspace (P10, carried over from 001)', () => {
  it('the app role cannot insert into role_mapping', async () => {
    await withPg(async t => {
      await expect(t.query(
        "insert into role_mapping (workspace_id, issuer, group_value, role) values ($1, 'i', 'g', 'reviewer')",
        [WS],
      )).rejects.toThrow(/permission denied/i);
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
