import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migratorDb } from './helpers/pgHarness.ts';
import { ledgerVersionsWithNoFile, runMigrations, appliedVersions } from '../src/db/migrate.ts';

/** The versions this suite writes into the real ledger. Named once, because
 *  they are deleted in two places — before each case that writes one, and
 *  after the whole suite. */
const PROBE_VERSIONS = ['901_a', '902_b', '903_once'];

describe('runMigrations applies each file once, in order, under a lock', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lexmig-'));
    writeFileSync(path.join(dir, '901_a.sql'), 'create table mig_probe_a (x int);');
    writeFileSync(path.join(dir, '902_b.sql'), 'create table mig_probe_b (x int);');
  });

  /*
   * THIS SUITE USED TO LEAVE ITS ROWS BEHIND (cross-stage seam review, m3).
   *
   * It deleted them BEFORE each run and never after, so the development
   * database carried `901_a`, `902_b` and `903_once` — plus three probe
   * tables — for weeks: three ledger rows naming migrations no directory in
   * this repository holds. That was harmless while nothing asked the reverse
   * question. `ledgerVersionsWithNoFile` asks it now, and `main.ts` refuses to
   * start on the answer, so a suite that leaves its probes behind would leave
   * the API unable to boot against the database it ran on.
   *
   * The before-each deletes stay: they are what makes each case re-runnable
   * after a crash. This is the other half.
   */
  afterAll(async () => {
    const db = migratorDb();
    await db.query('drop table if exists mig_probe_a, mig_probe_b, mig_probe_once');
    await db.query('delete from schema_migration where version = any($1)', [PROBE_VERSIONS]);
  });

  it('applies both files and records both versions', async () => {
    const db = migratorDb();
    await db.query('drop table if exists mig_probe_a, mig_probe_b');
    await db.query("delete from schema_migration where version in ('901_a','902_b')");
    await runMigrations(db, dir);
    expect(await appliedVersions(db)).toEqual(expect.arrayContaining(['901_a', '902_b']));
  });

  it('is idempotent: a second run applies nothing and does not throw', async () => {
    // The first run created `mig_probe_a`; re-running the same SQL would fail
    // with "relation already exists" if the ledger were not consulted, which
    // is what stops this being a tautology.
    await expect(runMigrations(migratorDb(), dir)).resolves.toBeUndefined();
  });

  it('two concurrent runners do not both apply the same file', async () => {
    // The IndexedDB precedent is exact: a flag alone was not enough for the
    // pre-D playbook migration, because two callers both read no flag and
    // both published. The lock is what actually closes it, and only if it is
    // taken BEFORE the ledger is read.
    const dir2 = mkdtempSync(path.join(tmpdir(), 'lexmig2-'));
    writeFileSync(path.join(dir2, '903_once.sql'), 'create table mig_probe_once (x int);');
    const a = migratorDb(); const b = migratorDb();
    await a.query('drop table if exists mig_probe_once');
    await a.query("delete from schema_migration where version = '903_once'");
    const results = await Promise.allSettled([runMigrations(a, dir2), runMigrations(b, dir2)]);
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    const rows = await a.query<{ n: string }>(
      "select count(*)::text as n from schema_migration where version = '903_once'",
    );
    expect(rows[0].n).toBe('1');
  });

  it('names the file when one fails, rather than reporting a bare syntax error', async () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'lexmigbad-'));
    writeFileSync(path.join(bad, '904_broken.sql'), 'this is not sql;');
    await expect(runMigrations(migratorDb(), bad)).rejects.toThrow(/904_broken\.sql/);
  });
});

describe('the ledger is read in the other direction too (m3)', () => {
  /*
   * `runMigrations` asks which files this database has not seen. Nothing
   * asked which versions it HAS seen that this build does not carry — so a
   * migration renamed or deleted was invisible in both directions, and an
   * older image started against a newer schema ran happily against columns
   * whose meaning had changed under it.
   */
  it('names a ledger row this directory has no file for', async () => {
    const db = migratorDb();
    const dir = mkdtempSync(path.join(tmpdir(), 'lexmigrev-'));
    writeFileSync(path.join(dir, '905_present.sql'), 'create table mig_probe_rev (x int);');
    await db.query('drop table if exists mig_probe_rev');
    await db.query(
      "delete from schema_migration where version in ('905_present','906_from_the_future')");
    try {
      await runMigrations(db, dir);
      // The file this directory DOES hold is applied, and is therefore not
      // reported — asserted by name rather than by an empty list, because a
      // temporary directory of one file legitimately does not explain the
      // sixteen real migrations this database has also applied. The whole
      // ledger against the SHIPPED directory is the case below.
      const before = await ledgerVersionsWithNoFile(db, dir);
      expect(before).not.toContain('905_present');
      expect(before).not.toContain('906_from_the_future');

      // Now a row a NEWER build wrote, which this directory knows nothing
      // about — the deployment-went-backwards case, exactly.
      await db.query("insert into schema_migration (version) values ('906_from_the_future')");
      expect(await ledgerVersionsWithNoFile(db, dir)).toContain('906_from_the_future');
    } finally {
      await db.query('drop table if exists mig_probe_rev');
      await db.query(
        "delete from schema_migration where version in ('905_present','906_from_the_future')");
    }
  });

  it('is silent about the real migration directory, which must agree with the ledger', async () => {
    // THE SANITY HALF, and the one an operator actually depends on: the
    // shipped directory and this database agree right now. A check that
    // could only ever be exercised against a temporary directory would never
    // have caught the three phantom rows this suite itself left behind.
    const shipped = path.join(process.cwd(), 'apps/api/migrations');
    expect(await ledgerVersionsWithNoFile(migratorDb(), shipped)).toEqual([]);
  });
});
