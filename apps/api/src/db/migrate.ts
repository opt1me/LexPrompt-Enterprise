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
/**
 * THE LEDGER READ IN THE OTHER DIRECTION: is there a row with no file?
 *
 * `runMigrations` asks one question — which files has this database not seen
 * — and applies those. It never asks the reverse, so a migration RENAMED or
 * DELETED is invisible in both directions: the ledger names a version this
 * image does not carry, and nothing anywhere says so. The live development
 * database is standing evidence that rows with no file are reachable (the
 * migration suite left three behind for weeks, `901_a`/`902_b`/`903_once`),
 * so this is not hypothetical.
 *
 * What it actually protects against is a deployment going BACKWARDS: an older
 * image started against a schema a newer one already migrated. Every table
 * the old code reads still exists, every query it issues still parses, and it
 * runs — against columns whose meaning changed under it. That is this
 * project's defining failure shape (something stale presented as correct)
 * arriving at the one layer where nothing above it can notice.
 *
 * SEPARATE FROM `runMigrations` rather than folded into it, deliberately: the
 * migration suite runs `runMigrations` over a temporary directory holding two
 * probe files, against a database whose ledger legitimately holds sixteen
 * real ones. A check inside `runMigrations` would refuse every one of those
 * runs, which is how a guard gets relaxed until it stops biting. This is
 * called by `main.ts`, over the shipped migration directory, where "the
 * ledger and the directory must agree" is exactly true.
 *
 * Returns the versions rather than throwing, so the caller decides what a
 * disagreement is worth — `main.ts` treats it as a refusal to start.
 */
export async function ledgerVersionsWithNoFile(db: Db, dir: string): Promise<string[]> {
  const known = new Set(
    readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => f.replace(/\.sql$/, '')),
  );
  return (await appliedVersions(db)).filter(version => !known.has(version));
}

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
