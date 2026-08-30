import type { Db, Tx } from '../db/pool.ts';

/** How far ahead the horizon is kept, in months. A year, the same width
 *  `012_audit_event.sql` created once. */
export const AUDIT_PARTITION_HORIZON_MONTHS = 12;

/**
 * ROLLS THE `audit_event` PARTITION HORIZON FORWARD, at startup.
 *
 * `012_audit_event.sql` created twelve months of partitions and said the
 * routine that keeps them coming was "a deployment concern named in the
 * README". It was not named in the README and it did not exist, so twelve
 * months after a deployment's first migration the next audited act would
 * fail with `no partition of relation "audit_event" found for row` — and
 * because `appendAudit` runs in the caller's transaction with no catch, that
 * failure rolls back the act itself. Not the audit row: the matter, the
 * document, the run, the assignment.
 *
 * ## Why here and not in a migration
 *
 * A migration runs ONCE. The horizon has to move with the calendar, so it
 * has to be re-applied by something that runs again — and the cheapest thing
 * that runs again, on a connection that owns the schema, is startup. The
 * function itself lives in `014_audit_partitions.sql` because creating a
 * partition is DDL and only the migrator role may issue it; this is the
 * call, not the logic.
 *
 * ## Why it is allowed to fail
 *
 * `refuseToStart` is the right answer to a schema that will not migrate. It
 * is the WRONG answer to a horizon that is merely not as wide as it could
 * be: the partitions for this month and the next eleven are, on any
 * deployment that has ever started, already there. Refusing to start would
 * turn a maintenance shortfall into an outage now, to prevent one in a
 * year's time. So a failure is REPORTED — named, with the manual command —
 * and the process starts. It is the one thing about this whole finding that
 * must not be silent.
 */
export async function ensureAuditPartitions(
  // A `Db` OR a `Tx`: `main.ts` calls it on the migrator pool, and a test
  // calls it inside the transaction it rolls back — Postgres makes a
  // `create table` transactional, which is what lets that test leave no
  // partitions behind.
  db: Pick<Db | Tx, 'query'>, months = AUDIT_PARTITION_HORIZON_MONTHS,
): Promise<number> {
  const rows = await db.query<{ ensure_audit_partitions: number }>(
    'select ensure_audit_partitions($1) as ensure_audit_partitions', [months]);
  return Number(rows[0]?.ensure_audit_partitions ?? 0);
}

/**
 * The same call, with its failure turned into a sentence an operator can act
 * on rather than a startup refusal. Returns whether the horizon was moved
 * forward, so a caller can log it.
 */
export async function ensureAuditPartitionsOrWarn(
  db: Pick<Db | Tx, 'query'>, write: (s: string) => void,
  months = AUDIT_PARTITION_HORIZON_MONTHS,
): Promise<void> {
  try {
    const made = await ensureAuditPartitions(db, months);
    if (made > 0) {
      write(`api: created ${made} monthly audit_event partition(s); the horizon is `
        + `${months} months wide\n`);
    }
  } catch (err) {
    write(
      'api: COULD NOT ROLL THE audit_event PARTITION HORIZON FORWARD '
      + `(${(err as Error).message}). LexPrompt is starting anyway — the partitions it `
      + 'already has still cover today. But when the last one ends, every audited act '
      + '(creating a matter, adding a document, starting a run, making an assignment) '
      + 'will fail and roll back. Run this against the database as the migrator role: '
      + `select ensure_audit_partitions(${months});\n`);
  }
}
