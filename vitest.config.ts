import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreAlias = {
  '@lexprompt/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@': path.resolve(__dirname, 'src'), ...coreAlias } },
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: false,
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.ts'],
          // src/lib/config.ts (Task 19) is the web app's ONE reader of
          // `import.meta.env`, and it throws at import time — deliberately,
          // per its own doc comment — if any of these four are missing.
          // `debug.ts` imports it, and `debug.ts` is imported by `db/open.ts`
          // et al., so almost every test in this project now imports
          // `config.ts` transitively. These are test-only stand-ins, never
          // read by the real app (which gets its own from `.env`/the
          // deployment): a real firm's values would never resolve a laptop
          // test run, and a laptop's values must never reach a firm's build.
          env: {
            VITE_API_BASE_URL: 'http://localhost:4000',
            VITE_OIDC_ISSUER: 'http://localhost:8088/realms/lexprompt',
            VITE_OIDC_CLIENT_ID: 'lexprompt-web-test',
            VITE_OIDC_SCOPE: 'openid profile email',
          },
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'core',
          environment: 'node',
          globals: false,
          include: ['packages/core/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'gateway',
          environment: 'node',
          globals: false,
          include: ['apps/gateway/test/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'api',
          environment: 'node',
          globals: false,
          include: ['apps/api/test/**/*.test.ts'],
          exclude: ['apps/api/test/**/*.compose.test.ts'],
        },
      },
    ],
  },
});
