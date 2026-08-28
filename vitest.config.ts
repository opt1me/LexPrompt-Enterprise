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
