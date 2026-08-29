import { describe, it, expect } from 'vitest';
import { makeDb, type PgClientLike } from '../src/db/pool.ts';

/** Records every statement issued, and answers every query with no rows. */
function recorder(): { client: PgClientLike; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    client: {
      query: async (text: string) => { statements.push(text); return { rows: [] }; },
      release: () => { statements.push('RELEASE-CLIENT'); },
    },
  };
}

describe('Db.tx nests with savepoints, never with a second BEGIN', () => {
  it('opens a real transaction at depth 0', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await db.tx(async t => { await t.query('select 1'); });
    expect(statements).toEqual(['BEGIN', 'select 1', 'COMMIT', 'RELEASE-CLIENT']);
  });

  it('uses a SAVEPOINT for a nested tx, not a second BEGIN', async () => {
    // A second BEGIN inside an open transaction is a WARNING and a no-op in
    // Postgres: the inner "transaction" silently shares the outer one, so an
    // inner rollback takes the outer's work with it and an inner commit
    // commits the outer early. Both failures are invisible.
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await db.tx(async outer => {
      await outer.tx(async inner => { await inner.query('select 2'); });
    });
    expect(statements).toEqual([
      'BEGIN', 'SAVEPOINT sp1', 'select 2', 'RELEASE SAVEPOINT sp1', 'COMMIT', 'RELEASE-CLIENT',
    ]);
    expect(statements.filter(s => s === 'BEGIN')).toHaveLength(1);
  });

  it('rolls back to the savepoint when the inner block throws, and lets the error out', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await expect(db.tx(async outer => {
      await outer.tx(async () => { throw new Error('inner failed'); });
    })).rejects.toThrow('inner failed');
    expect(statements).toEqual([
      'BEGIN', 'SAVEPOINT sp1', 'ROLLBACK TO SAVEPOINT sp1', 'ROLLBACK', 'RELEASE-CLIENT',
    ]);
  });

  it('releases the client even when the outermost block throws', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await expect(db.tx(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(statements.at(-1)).toBe('RELEASE-CLIENT');
  });
});
