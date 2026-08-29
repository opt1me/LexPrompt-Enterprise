import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './sourceScan.ts';

describe('the real-Postgres suites are wired to something that runs them', () => {
  it('finds the .pg.test.ts files (a guard that matches nothing passes vacuously)', () => {
    const files = readdirSync(path.join(ROOT, 'apps/api/test')).filter(f => f.endsWith('.pg.test.ts'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('the ordinary api project EXCLUDES them, so npm test needs no database', () => {
    expect(readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8'))
      .toContain("'apps/api/test/**/*.pg.test.ts'");
  });

  it('and vitest.pg.config.ts includes them', () => {
    expect(readFileSync(path.join(ROOT, 'vitest.pg.config.ts'), 'utf8'))
      .toContain("include: ['apps/api/test/**/*.pg.test.ts']");
  });

  it('package.json has a script that runs them', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['test:pg']).toContain('vitest.pg.config.ts');
  });
});
