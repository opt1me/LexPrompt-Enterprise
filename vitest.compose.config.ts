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
  },
});
