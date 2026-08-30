import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db, Tx } from './pool.ts';
import { MIGRATION_STEPS, type MigrationStep } from './migrationSteps.ts';

/** A stable key for the advisory lock. Any constant works as long as it is
 *  the same in every process; a literal is clearer in `pg_locks` than a hash
 *  of a string nobody would recognise. */
const MIGRATION_LOCK = 8_142_337_001;

async function ensureLedger(runner: Pick<Tx, 'query'>): Promise<void> {
  await runner.query(`
    create table if not exists schema_migration (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function appliedVersions(db: Db): Promise<string[]> {
  await ensureLedger(db);
  const rows = await db.query<{ version: string }>(
    'select version from schema_migration order by version',
  );
  return rows.map(r => r.version);
}

/**
 * Applies every `.sql` file in `dir` this database has not seen, in filename
 * order, recording each — the whole lot in ONE transaction holding an
 * advisory lock taken BEFORE the ledger is read.
 *
 * The ordering is the entire guarantee, and the pre-D playbook migration is
 * the precedent: a flag alone was not enough there, because two concurrent
 * callers both read no flag and both published. Postgres serialises on the
 * advisory lock exactly as IndexedDB serialises overlapping readwrite
 * transactions, so a second runner blocks, then re-reads the ledger inside
 * its own transaction and finds the first runner's rows.
 *
 * A migration may also have a TypeScript half — `steps`, defaulting to
 * `MIGRATION_STEPS` — run inside the same transaction, immediately after its
 * `.sql` file and before its ledger row. Exactly one does: the findings
 * backfill, whose refusals have to name every row they will not move.
 *
 * `pg_advisory_xact_lock`, not `pg_advisory_lock`: the transaction lock is
 * released by COMMIT or ROLLBACK and cannot be leaked by a process that dies
 * holding it. A leaked session lock would leave every future deploy hanging
 * with no message at all.
 */
export async function runMigrations(
  db: Db,
  dir: string,
  steps: Record<string, MigrationStep> = MIGRATION_STEPS,
): Promise<void> {
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  await db.tx(async t => {
    await t.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await ensureLedger(t);
    const done = new Set(
      (await t.query<{ version: string }>('select version from schema_migration')).map(r => r.version),
    );
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      try {
        await t.query(sql);
        // A migration's TypeScript half, in the SAME transaction, after its
        // SQL and before its ledger row — so a refusal it raises rolls back
        // the file's own tables too, and "nothing has been changed" is true
        // rather than nearly true. See `migrationSteps.ts`.
        await steps[version]?.(t);
      } catch (err) {
        // Named, always. A migration that fails with only Postgres's own
        // message leaves an operator reading a syntax error with no idea
        // which of eleven files produced it.
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      await t.query('insert into schema_migration (version) values ($1)', [version]);
    }
  });
}
