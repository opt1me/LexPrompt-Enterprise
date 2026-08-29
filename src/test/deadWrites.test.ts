import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Nothing in the app writes to the browser-local database any more.
 *
 * `open.ts`'s read-only handle enforces this at run time; this enforces it in
 * the source, which catches the thing the run-time guard cannot: code written
 * against a database it opens for itself. The two are complementary, and this
 * one is the cheaper of the pair to read.
 *
 * ## Why it is worth a test at all
 *
 * From Part 2A every repository was an HTTP client while `migrateIfNeeded`
 * carried on writing converted playbooks into the `playbooks` object store —
 * a store the app had stopped reading. It ran on every cold load, for months,
 * and nothing anywhere said so. A write to a store nothing reads is work
 * silently lost, which is this project's founding failure shape wearing a
 * different hat: not a wrong answer, but an action a person believes
 * happened and did not.
 *
 * ## The two exemptions, and why each is safe
 *
 * `src/test/seedLocalData.ts` opens the database directly, because the
 * uploader's own fixtures have to be able to put a firm's data into a browser
 * before the uploader reads it out. It is under `src/test/`, so nothing the
 * app ships can import it.
 *
 * `src/lib/db/open.ts` names `'readwrite'` inside the guard that REFUSES one.
 */

const SRC = resolve(__dirname, '..');

/** Files the guard itself lives in, or that exist to write fixtures. Every
 *  other file under `src/` is scanned — including tests, deliberately: a test
 *  that writes through `getDb()` is a test asserting against a state the app
 *  can no longer reach. */
const ALLOWED = [
  'lib/db/open.ts',
  'lib/db/open.test.ts',
  'test/seedLocalData.ts',
  'test/deadWrites.test.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    const rel = relative(SRC, full).split(sep).join('/');
    if (!/\.tsx?$/.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

const files = walk(SRC).filter(f => !ALLOWED.includes(f));
const codeOf = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('the browser-local database is written by nothing', () => {
  it('scans the whole of src/', () => {
    // A guard that silently stopped finding files would pass forever. This
    // is the number that says it is still looking.
    expect(files.length).toBeGreaterThan(80);
  });

  it("opens no 'readwrite' IndexedDB transaction anywhere", () => {
    const offenders = files.filter(f => /'readwrite'/.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it('has no second opener of the local database beside open.ts', () => {
    // `openDB(` outside `open.ts` is a handle that never passes through the
    // read-only wrapper, so the run-time guard would never see it.
    const offenders = files.filter(f => /\bopenDB\s*[(<]/.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });
});
