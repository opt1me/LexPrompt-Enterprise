import { defineConfig } from 'vitest/config';

// A separate, single-project config for apps/api/test/**/*.compose.test.ts —
// the tests vitest.config.ts's `api` project deliberately EXCLUDES (Task 1),
// because they shell out to `docker compose exec` and must never run as
// part of the default `npx vitest run` gate, which has to stay green with
// no Docker daemon present at all.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['apps/api/test/**/*.compose.test.ts'],
    // These tests prove a network path is ABSENT, and absence takes as long
    // as the prober is willing to wait: the in-container fetch uses
    // `AbortSignal.timeout(8000)`, and `inApi`'s `execFileSync` allows
    // 30s. Vitest's default 5s test timeout is shorter than either, which
    // made the egress tests unpassable in BOTH directions — with egress
    // open they failed the assertion, and with egress correctly blocked
    // they died at 5s before the 8s abort could report `BLOCKED`. A test
    // that cannot go green whatever the system does is worse than no test:
    // it reads as coverage of the claim §5 rests on.
    //
    // Matched to `inApi`'s own 30s ceiling so the failure a reader sees is
    // the prober's, which names what it could not reach, rather than
    // Vitest's, which names only the clock.
    testTimeout: 30_000,
    // ONE STACK, ONE FILE AT A TIME. These suites all drive the same running
    // containers, and Stage 3 Task 11 added one that RESTARTS `api`
    // mid-test — which, run in parallel, made `egress.compose.test.ts`'s
    // probe fail with "could not reach the api" and read as though the
    // egress block had changed. A shared, mutable, restartable dependency is
    // the one thing file parallelism cannot be given.
    fileParallelism: false,
  },
});
