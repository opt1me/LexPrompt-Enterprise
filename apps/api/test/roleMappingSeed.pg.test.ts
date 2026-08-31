import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import { seedRoleMappings } from '../src/auth/roles.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * THE SEED OWNS CONFIGURATION ROWS ONLY, and says so when it takes one back.
 *
 * Migration 015 gave `role_mapping` a second writer. `seedRoleMappings`'s
 * delete-half made the table EQUAL the configuration, which was right when
 * the configuration was the only writer and is catastrophic now: every
 * container restart would erase every mapping an administrator had made, and
 * from the screen it would look exactly like a change that never saved.
 *
 * Everything here runs as the MIGRATOR inside a rolled-back transaction —
 * the seed's own connection, and the only role that can write a
 * configuration row at all.
 */
const WS = '00000000-0000-0000-0000-000000000001';
const I = 'https://stage5-seed.invalid/realms/none';

/** An admin-authored row, written the way the route writes one. */
async function insertAdminRow(t: Tx, groupValue: string, role: string): Promise<void> {
  await t.query(
    `insert into role_mapping (workspace_id, issuer, group_value, role, source, created_at)
     values ($1, $2, $3, $4, 'admin', now())`,
    [WS, I, groupValue, role]);
}

async function groupValues(t: Tx): Promise<string[]> {
  const rows = await t.query<{ group_value: string }>(
    'select group_value from role_mapping where issuer = $1 order by group_value', [I]);
  return rows.map(r => r.group_value);
}

describe('seedRoleMappings after migration 015', () => {
  it('deletes a configuration row the variable no longer names', async () => {
    await withPg(async t => {
      await seedRoleMappings(t, WS, [
        { issuer: I, groupValue: 'keep', role: 'reviewer' },
        { issuer: I, groupValue: 'drop', role: 'reviewer' },
      ]);
      expect(await groupValues(t)).toEqual(['drop', 'keep']);
      await seedRoleMappings(t, WS, [{ issuer: I, groupValue: 'keep', role: 'reviewer' }]);
      // The revocation half, unchanged: taking an entry out of
      // API_ROLE_MAPPINGS and redeploying is still how a deployment revokes.
      expect(await groupValues(t)).toEqual(['keep']);
    }, migratorDb());
  });

  it('LEAVES an admin-authored row alone', async () => {
    await withPg(async t => {
      await insertAdminRow(t, 'house-counsel', 'partner');
      await seedRoleMappings(t, WS, [{ issuer: I, groupValue: 'keep', role: 'reviewer' }]);
      expect(await groupValues(t)).toEqual(['house-counsel', 'keep']);
      // The mutation this kills: leaving the delete-half unscoped, which
      // wipes every admin mapping on every container restart and looks, from
      // a screen, exactly like a change that never saved.
    }, migratorDb());
  });

  it('supersedes an admin row that configuration later claims, and records it ON THE ROW (P52)', async () => {
    await withPg(async t => {
      await insertAdminRow(t, 'house-counsel', 'partner');
      const superseded = await seedRoleMappings(t, WS, [
        { issuer: I, groupValue: 'house-counsel', role: 'admin' },
      ]);
      const [row] = await t.query<{
        role: string; source: string; converted_from_admin_at: Date | null;
      }>(
        `select role, source, converted_from_admin_at from role_mapping
          where issuer = $1 and group_value = $2`, [I, 'house-counsel']);
      expect(row.role).toBe('admin');                       // configuration wins
      expect(row.source).toBe('configuration');
      expect(row.converted_from_admin_at).not.toBeNull();   // permanently visible on the row

      // …and it is REPORTED, so `main.ts` can put it in the startup log. A
      // supersession that happened only in a table nobody watches is a
      // supersession nobody sees.
      expect(superseded).toEqual([{
        issuer: I, groupValue: 'house-counsel', previousRole: 'partner', role: 'admin',
      }]);
    }, migratorDb());
  });

  it('reports the ROLE CHANGE and the ROW CHANGE from two different statements', async () => {
    /*
     * The pair the mutation instruction is about. Removing the supersession
     * SELECT must take the report and `converted_from_admin_at` down and
     * LEAVE `role`/`source` correct — if all four move together they are one
     * statement's output and the assertions above are weaker than they look.
     *
     * Here that separation is asserted directly: a collision on a row that
     * has ALREADY been converted still upserts (role and source stay right)
     * and reports nothing, because the pre-scan is what produces the report.
     */
    await withPg(async t => {
      await insertAdminRow(t, 'house-counsel', 'partner');
      await seedRoleMappings(t, WS, [{ issuer: I, groupValue: 'house-counsel', role: 'admin' }]);
      const again = await seedRoleMappings(t, WS, [
        { issuer: I, groupValue: 'house-counsel', role: 'reviewer' },
      ]);
      expect(again).toEqual([]);
      const [row] = await t.query<{ role: string; source: string }>(
        'select role, source from role_mapping where issuer = $1 and group_value = $2',
        [I, 'house-counsel']);
      expect(row).toEqual({ role: 'reviewer', source: 'configuration' });
    }, migratorDb());
  });

  it('is idempotent — a second run supersedes nothing further', async () => {
    await withPg(async t => {
      await insertAdminRow(t, 'house-counsel', 'partner');
      const mappings = [{ issuer: I, groupValue: 'house-counsel', role: 'admin' as const }];
      const first = await seedRoleMappings(t, WS, mappings);
      const [row1] = await t.query<{ converted_from_admin_at: Date }>(
        `select converted_from_admin_at from role_mapping
          where issuer = $1 and group_value = $2`, [I, 'house-counsel']);
      const second = await seedRoleMappings(t, WS, mappings);
      const [row2] = await t.query<{ converted_from_admin_at: Date }>(
        `select converted_from_admin_at from role_mapping
          where issuer = $1 and group_value = $2`, [I, 'house-counsel']);
      expect(first).toHaveLength(1);
      // Without the `converted_from_admin_at is null` guard, every restart
      // reports another supersession and writes another instant, and an
      // operator reads one supersession as a hundred.
      expect(second).toEqual([]);
      expect(row2.converted_from_admin_at.getTime()).toBe(row1.converted_from_admin_at.getTime());
    }, migratorDb());
  });

  it('an empty mapping list still empties CONFIGURATION rows and still leaves admin ones', async () => {
    // config.ts refuses to start with API_ROLE_MAPPINGS unset; an explicitly
    // EMPTY list is a deliberate "no configured mappings" and is honoured.
    await withPg(async t => {
      await seedRoleMappings(t, WS, [{ issuer: I, groupValue: 'cfg', role: 'reviewer' }]);
      await insertAdminRow(t, 'house-counsel', 'partner');
      await seedRoleMappings(t, WS, []);
      expect(await groupValues(t)).toEqual(['house-counsel']);
    }, migratorDb());
  });

  it('does not sweep ANOTHER workspace’s admin rows either', async () => {
    const OTHER = '00000000-0000-0000-0000-0000000000fe';
    await withPg(async t => {
      await t.query('insert into workspace (id, name) values ($1, $2)', [OTHER, 'Other']);
      await t.query(
        `insert into role_mapping (workspace_id, issuer, group_value, role, source)
         values ($1, $2, 'other-admin-row', 'admin', 'admin')`, [OTHER, I]);
      await seedRoleMappings(t, WS, [{ issuer: I, groupValue: 'keep', role: 'reviewer' }]);
      expect(await groupValues(t)).toEqual(['keep', 'other-admin-row']);
    }, migratorDb());
  });
});
