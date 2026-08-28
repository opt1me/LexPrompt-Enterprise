import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function walkIfPresent(dir: string): string[] {
  try { return walk(dir); } catch { return []; }
}

/**
 * S14: `packages/core` is the single home for anything both sides need.
 * A second copy of one of its exports is this project's most repeated
 * defect at client/server scale, where the two copies cannot even be read
 * side by side. This test names each export and forbids a second
 * definition of it outside the package.
 */
describe('import boundary (S14)', () => {
  // EXTEND THIS ARRAY in every task that adds a core export. By the end of
  // Stage 1 it reads:
  //   ['parseJsonLoose', 'createSseEventReader', 'sseFields', 'encodeFrame',
  //    'decodeFrame', 'readFrames', 'isPurpose', 'isProviderId',
  //    'jurisdictionLabel', 'isRetryableStatus', 'isSignInError',
  //    'isServiceConfigError']
  const exported = ['parseJsonLoose'];

  it('nothing outside packages/core defines an export of packages/core', () => {
    const files = [
      ...walkIfPresent(path.join(ROOT, 'src')),
      ...walkIfPresent(path.join(ROOT, 'apps')).filter(f => !f.includes(`${path.sep}test${path.sep}`)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of exported) {
        if (new RegExp(`(function|const|class)\\s+${name}\\b`).test(text)) {
          offenders.push(`${path.relative(ROOT, file)} redefines ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
