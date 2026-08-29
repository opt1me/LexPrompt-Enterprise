import { afterAll } from 'vitest';
import { Pool } from 'pg';
import { makeDb, type Db, type Tx } from '../../src/db/pool.ts';

/**
 * These suites need a REAL Postgres and they do not skip without one.
 *
 * A skipped suite reports green while testing nothing — the shape §14 calls
 * unacceptable and the shape this project has already shipped. So the
 * absence of a database is a loud failure carrying the command that fixes
 * it, not a `describe.skip`.
 */
function requireUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set, and these suites run against a real Postgres by design `
      + '(spec §14: "A fake Postgres is not acceptable"). Start the stack with '
      + '`npm run compose:up`, run `scripts/pg-forward.sh`, then export the two URLs it '
      + 'prints. These suites are NOT skipped without a database.',
    );
  }
  return value;
}

let appPool: Pool | undefined;
let migratorPool: Pool | undefined;

/** A `Db` on the migrator role — the schema owner. */
export function migratorDb(): Db {
  migratorPool ??= new Pool({ connectionString: requireUrl('LEXPROMPT_TEST_MIGRATION_URL'), max: 4 });
  return makeDb(migratorPool);
}

/** A `Db` on the app role — the role a request actually runs as, and
 *  therefore the only role a grant test can prove anything with. */
export function appDb(): Db {
  appPool ??= new Pool({ connectionString: requireUrl('LEXPROMPT_TEST_DATABASE_URL'), max: 4 });
  return makeDb(appPool);
}

afterAll(async () => {
  await appPool?.end();
  await migratorPool?.end();
  appPool = undefined;
  migratorPool = undefined;
});

/**
 * The pinned transaction, presented as a `Db`.
 *
 * A route takes a `Db`; `withPg` hands out a `Tx` bound to ONE client whose
 * work is always rolled back. Wrapping the second as the first is what lets
 * a route suite run the real SQL against the real database and still leave
 * nothing behind — every statement the route issues lands on the same
 * pinned client, so it is inside the transaction the harness discards.
 *
 * `tx` is forwarded, not re-implemented: `pool.ts` turns a nested `tx` into
 * a SAVEPOINT, which is exactly what a route's own transaction needs to be
 * here. Opening a second connection instead would put the route's writes
 * OUTSIDE the rollback, and they would survive the test.
 */
export function dbOn(t: Tx): Db {
  return {
    query: (text, values) => t.query(text, values),
    tx: run => t.tx(run),
  };
}

class RollbackSignal extends Error {}

/**
 * Runs `body` inside a transaction that is ALWAYS rolled back.
 *
 * The `Tx` handed in is bound to one pinned client, so everything the body
 * does — including its own nested `tx()` calls, which become savepoints — is
 * discarded at the end. That is what lets these suites share one database
 * with no truncate between tests, and it is why `pool.ts`'s savepoint
 * nesting is load-bearing rather than tidy.
 *
 * The body's own failure is captured and re-thrown AFTER the rollback, so a
 * failing assertion still leaves the database clean.
 */
export async function withPg(body: (t: Tx) => Promise<void>, db: Db = appDb()): Promise<void> {
  let thrown: unknown;
  await db.tx(async t => {
    try { await body(t); } catch (err) { thrown = err; }
    throw new RollbackSignal();
  }).catch((err: unknown) => { if (!(err instanceof RollbackSignal)) throw err; });
  if (thrown) throw thrown;
}
