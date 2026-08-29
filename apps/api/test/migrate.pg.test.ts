import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migratorDb } from './helpers/pgHarness.ts';
import { runMigrations, appliedVersions } from '../src/db/migrate.ts';

describe('runMigrations applies each file once, in order, under a lock', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lexmig-'));
    writeFileSync(path.join(dir, '901_a.sql'), 'create table mig_probe_a (x int);');
    writeFileSync(path.join(dir, '902_b.sql'), 'create table mig_probe_b (x int);');
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
