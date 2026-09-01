import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The suites that need a REAL Postgres, in their own project.
 *
 * A fake Postgres is not acceptable (§14): half the point of moving to
 * Postgres is that it enforces constraints IndexedDB could not, and a
 * substitute that behaves subtly differently is the exact defect class this
 * project keeps finding. So these tests need a database, which means Docker,
 * which is why they are not part of `npm test` — the same reasoning that
 * already keeps `test:compose` in its own config.
 *
 * They are NOT optional and they do NOT skip. `pgHarness.ts` fails loudly
 * with the command that fixes it when the database is absent, because a
 * suite that skips itself reports green while testing nothing.
 */
export default defineConfig({
  resolve: { alias: { '@lexprompt/core': path.resolve(__dirname, 'packages/core/src/index.ts') } },
  test: {
    name: 'api-pg',
    environment: 'node',
    globals: false,
    include: ['apps/api/test/**/*.pg.test.ts'],
    // Checks, once, that the application tables are empty — a precondition a
    // large part of this suite has always had and never stated. See the file
    // for why the backfill suites cannot simply be scoped instead.
    setupFiles: ['apps/api/test/helpers/requireCleanDb.ts'],
    // One database, one schema: these files share a pool and each test rolls
    // its own transaction back, so they must not race each other.
    fileParallelism: false,
  },
});
