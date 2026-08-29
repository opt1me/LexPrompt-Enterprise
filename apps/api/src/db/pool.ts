import { Pool, type QueryResultRow } from 'pg';

/** The slice of `pg`'s client this module uses. Narrowed deliberately so a
 *  test can supply one without reproducing sixty members, and so nothing
 *  here reaches for a `pg` convenience a pinned test client cannot answer. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface PgPoolLike { connect(): Promise<PgClientLike>; }

export interface Tx {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  /** Nested work in the same transaction, isolated by a savepoint. */
  tx<T>(run: (t: Tx) => Promise<T>): Promise<T>;
}

export interface Db {
  /** A single statement outside any transaction. */
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  /** Everything in `run` succeeds together or not at all. */
  tx<T>(run: (t: Tx) => Promise<T>): Promise<T>;
}

/**
 * `BEGIN` at depth 0, `SAVEPOINT` below it.
 *
 * Postgres answers a second `BEGIN` inside an open transaction with a
 * warning and does nothing, so a naive nested implementation gives the inner
 * block a transaction that is not one: its `ROLLBACK` discards the outer
 * block's work and its `COMMIT` commits the outer block early, neither of
 * them raising anything. Every write path in this stage is at least two
 * levels deep somewhere — a route's transaction containing a helper's — so
 * this is not a nicety, and the test harness depends on it besides.
 */
function bind(client: PgClientLike, depth: number): Tx {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
      const result = await client.query(text, values);
      return result.rows as R[];
    },
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      const name = `sp${depth + 1}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const value = await run(bind(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (err) {
        // The rollback's own failure must not REPLACE the error that caused
        // it — the same rule, and the same sibling, as `tx` below. See the
        // long form there.
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        } catch { /* swallowed deliberately: see the note in `tx` */ }
        throw err;
      }
    },
  };
}

export function makeDb(pool: PgPoolLike): Db {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
      const client = await pool.connect();
      try {
        const result = await client.query(text, values);
        return result.rows as R[];
      } finally {
        client.release();
      }
    },
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const value = await run(bind(client, 0));
          await client.query('COMMIT');
          return value;
        } catch (err) {
          // The ROLLBACK's own failure must not REPLACE the error that
          // caused it. A connection that has already gone away makes
          // `ROLLBACK` throw, and rethrowing that handed the caller a
          // transport error instead of the constraint violation that
          // actually happened — the wrong diagnosis, delivered with
          // apparent authority, at the one moment a caller is trying to
          // find out what it did wrong. Postgres discards an uncommitted
          // transaction when the connection closes anyway, so there is
          // nothing left un-rolled-back to report.
          try {
            await client.query('ROLLBACK');
          } catch { /* swallowed deliberately: see above */ }
          throw err;
        }
      } finally {
        client.release();
      }
    },
  };
}

/** Builds the real pool. The only place `pg`'s `Pool` is constructed. */
export function makePool(connectionString: string, max: number): Pool {
  return new Pool({ connectionString, max });
}
