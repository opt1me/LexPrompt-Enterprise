import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
// Extracted rather than written a third time — `stage1DoD.test.ts` reuses the
// same three from `apps/api`, and this project's own rule is "when you find
// yourself writing a second copy, extract it then".
import { ROOT, rel, codeOf } from '../../apps/api/test/sourceScan.ts';

/**
 * **No screen in this app says a precedent document is not stored.**
 *
 * Server spec §18 item 3, verbatim: *"a precedent document is stored, is not
 * offerable as a review target or a collection member, and no screen in the
 * app says it is not stored — **searched for, not assumed**, across `src/`,
 * the README and the test suite."* The first two halves are refusals the API
 * makes, and `apps/api/test/precedent.pg.test.ts` proves them against a real
 * database. This file is the third half, and it is the one that cannot be
 * proved by any test of the feature: every one of them passes just as
 * happily with the old sentence still on the screen.
 *
 * That sentence — `PrecedentIntake`'s *"Read once to learn from. Never
 * stored."* — was TRUE when it was written. §11.1 made it false, and stated
 * as an acceptance condition that *"there is no release in which the storage
 * exists and the sentence does"*. S24 gives the cost of getting it wrong:
 * *"the app shows a lawyer 'Never stored' on the screen where they choose
 * which of their client's documents to upload, while storing them. That is
 * not a copy defect; it is the founding defect of this project in its purest
 * form, and it would be shipped deliberately."*
 *
 * ## Why this is a search rather than one assertion about one file
 *
 * The task brief listed six places the old promise lived, found by grepping
 * for `Never stored` / `never stored` / `stores none of them` / `read once`,
 * and warned that a seventh *"would be exactly the kind of thing this task
 * exists to catch"*. There was one, and that grep would not have found it:
 * `App.tsx`'s `REDLINES_DIRTY_MESSAGE`, the modal a person reads at the
 * moment of leaving, said leaving *"loses the documents you brought in"*.
 * That is the same false claim in words the pattern did not contain — which
 * is the whole argument for a check that stays in the suite rather than a
 * grep run once by hand.
 *
 * ## What it reads, and what it deliberately does not
 *
 * **Comment-stripped source** (`codeOf`), for the reason `sourceScan.ts`
 * gives at length: this codebase explains its own rules in prose, and this
 * change in particular leaves a RECORD of the old promise in several
 * comments — deliberately, because §11.1 requirement 5 says the stale
 * comments must be corrected rather than deleted, and a correction has to
 * quote what it corrects. A raw text scan flags every one of those and
 * leaves an executor two moves: relax the pattern until it stops biting, or
 * exempt the file. Both end with a guard that no longer searches for the
 * thing it names.
 *
 * There is **no exemption list**, deliberately (the same reasoning
 * `paletteScan`'s empty `SCAN_EXEMPT` records: a file-level exemption hides
 * everything in that file, not just the part you meant to protect).
 */

/** Phrases that assert a document is not kept. */
const NOT_STORED = new RegExp([
  'never stored', 'not stored', 'stores none of them', 'stored nowhere',
  'never persisted', 'not persisted', 'nothing is stored',
  'read once', 'reads them once',
  'loses the documents', 'lose the documents',
  'gone the moment', 'die with the tab', 'dies with the tab',
  'never written anywhere', 'written nowhere',
].join('|'), 'i');

/** What the claim has to be ABOUT for this guard to care. A precedent set,
 *  a precedent document, or the redlines flow that brings them in — matched
 *  against nearby TEXT, and against the file's own PATH, since every string
 *  in `features/redlines/` is about exactly this. */
const PRECEDENT_SUBJECT = /precedent|redline/i;

/**
 * The true "never stored" sentences in this app, every one of which is about
 * a DERIVED VALUE rather than about a document:
 *
 *  - **page images** — regenerated on demand from the original bytes, ~⅓
 *    larger than their source, and never persisted anywhere (CLAUDE.md);
 *  - **a position's health** — computed from verified findings at read time,
 *    never stored, because a stored copy could disagree with its source;
 *  - **the matter activity feed** — derived at read time (R-G9), not a
 *    stored event log.
 *
 * Excluded by SUBJECT and not by file, deliberately: a file-level exemption
 * hides everything in that file rather than the part you meant to protect
 * (the `PdfCanvas` lesson), and these sentences stay scannable wherever
 * anyone moves them to. Each has a fixture below, so an entry that stops
 * matching anything is visible rather than silently inert.
 */
const NOT_ABOUT_A_DOCUMENT = /page image|position'?s health|health is derived|activity feed|derived at read time/i;

/** How far a subject may be from the claim and still be its subject. A
 *  wrapping string literal, or the `const REDLINES_DIRTY_MESSAGE =` line
 *  above the sentence that carries the claim. */
const WINDOW = 3;

export interface Claim { file: string; line: number; text: string }

/** Every line of `code` that claims a precedent document is not stored. */
export function claimsIn(file: string, code: string): Claim[] {
  const lines = code.split(/\r?\n/);
  const found: Claim[] = [];
  lines.forEach((line, i) => {
    if (!NOT_STORED.test(line)) return;
    if (NOT_ABOUT_A_DOCUMENT.test(line)) return;
    // A file whose PATH names the subject is about it throughout — every
    // rendered string in `features/redlines/` is about these documents. This
    // half is not optional: restoring the old sentence into
    // `PrecedentIntake`'s header put "Never stored." three lines from
    // nothing else and the window test alone let it through, which is
    // precisely the mutation this guard exists for.
    const window = PRECEDENT_SUBJECT.test(file)
      ? file
      : lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
    if (!PRECEDENT_SUBJECT.test(window)) return;
    // In a TEST, a negated assertion is the OPPOSITE of a claim — it is what
    // proves the old sentence is gone from the screen. `.not.` on the same
    // line is the only shape that reads that way, and requiring it on the
    // line rather than in the window keeps a nearby positive assertion from
    // being excused by a negative one three lines up.
    if (/\.test\.tsx?$/.test(file) && /\.not\./.test(line)) return;
    found.push({ file, line: i + 1, text: line.trim() });
  });
  return found;
}

/**
 * This file, and only this file.
 *
 * A scanner cannot scan itself: every fixture below is a sample of the exact
 * thing it looks for, so scanning this file reports its own unit tests as
 * violations. That is the ONE exclusion here, it is a single exact path
 * rather than a pattern anything else could fall into, and it is asserted to
 * be exactly that one path — because the failure mode this project has
 * already paid for is an exemption that quietly grew to cover a whole file
 * of unrelated things (`PdfCanvas`, three hidden states, guard green
 * throughout). What it hides is a test file that renders no screen, and the
 * scanner's own behaviour is pinned by the fixtures it hides.
 */
const SELF = 'src/test/precedentPromise.test.ts';

/** Every `.ts`/`.tsx` under `src/`, TESTS INCLUDED — §18 names the test
 *  suite explicitly, because a test still asserting the old promise is how
 *  the promise gets restored. */
function webSources(dir = path.join(ROOT, 'src'), out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'fixtures', 'test_docs'].includes(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) webSources(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Everything the offender scan actually reads. */
function scanned(): string[] {
  return webSources().filter(f => rel(f) !== SELF);
}

describe('the scanner finds the files it scans (a guard over nothing passes vacuously)', () => {
  const files = webSources().map(rel);

  it('reaches the screens, the wiring and the test that assert the promise', () => {
    expect(files).toContain('src/features/redlines/PrecedentIntake.tsx');
    expect(files).toContain('src/features/redlines/PrecedentUploadPanel.tsx');
    expect(files).toContain('src/App.tsx');
    expect(files).toContain('src/lib/privacyCopy.ts');
    // The test suite, which `walk` in `sourceScan.ts` deliberately excludes
    // and this scan deliberately does not.
    expect(files).toContain('src/App.redlines.test.tsx');
    expect(files.length).toBeGreaterThan(150);
  });

  it('excludes exactly one file, and it is this one', () => {
    const read = new Set(scanned().map(rel));
    expect(files.filter(f => !read.has(f))).toEqual([SELF]);
  });

  it('actually reads those files rather than an empty string', () => {
    const intake = codeOf(path.join(ROOT, 'src/features/redlines/PrecedentIntake.tsx'));
    expect(intake).toContain('PRECEDENT_STORAGE_PRIVACY');
    expect(intake.length).toBeGreaterThan(2000);
  });
});

describe('claimsIn recognises a claim, and recognises what is not one', () => {
  it('flags the exact sentence this change removed', () => {
    const found = claimsIn('x.tsx', 'export function PrecedentIntake() {\n'
      + '  return <p>Read once to learn from. Never stored.</p>;\n}');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });

  it('flags the SEVENTH place, whose words the brief s own grep did not contain', () => {
    const found = claimsIn('App.tsx', 'const REDLINES_DIRTY_MESSAGE =\n'
      + "  'This learning session … so leaving loses the documents you brought in. Leave anyway?';");
    expect(found).toHaveLength(1);
  });

  it('flags a TEST that asserts the old promise is present', () => {
    const found = claimsIn('a.test.tsx',
      "// a precedent\nexpect(occurrences('Never stored')).toBe(1);");
    expect(found).toHaveLength(1);
  });

  it('does NOT flag a test asserting the old promise is GONE', () => {
    expect(claimsIn('a.test.tsx',
      "// a precedent screen\nexpect(text).not.toContain('Never stored');")).toEqual([]);
  });

  // One fixture per `NOT_ABOUT_A_DOCUMENT` entry, so an entry that has
  // stopped matching anything real shows up here rather than sitting inert.
  it('does NOT flag the page-images sentence', () => {
    expect(claimsIn('x.ts',
      '// precedent\nconst s = "Page images generated for scanned PDFs are never stored";'))
      .toEqual([]);
  });

  it('does NOT flag a position s health, which is derived', () => {
    expect(claimsIn('x.ts',
      "// precedent\nconst s = \"A position's health is derived, never stored\";")).toEqual([]);
  });

  it('does NOT flag the activity feed, which is derived at read time', () => {
    expect(claimsIn('x.ts',
      '// redline\nconst s = "The activity feed is derived and never stored";')).toEqual([]);
  });

  it('does NOT flag a claim with no precedent subject anywhere near it', () => {
    expect(claimsIn('x.ts', 'const s = "The draft is never stored";')).toEqual([]);
  });
});

describe('§18 item 3: nothing in this app denies that a precedent is kept', () => {
  it('finds no such claim anywhere under src/', () => {
    const offenders = scanned().flatMap(f => claimsIn(rel(f), codeOf(f)));
    expect(offenders.map(o => `${o.file}:${o.line} ${o.text}`)).toEqual([]);
  });

  it('finds no such claim in the README', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    // Markdown has no comments to strip, and the sanity check is that the
    // section this is about is genuinely in the file being read.
    expect(readme).toContain('## Learning from redlines');
    expect(claimsIn('README.md', readme).map(o => `${o.line} ${o.text}`)).toEqual([]);
  });

  it('and the screen states the NEW promise, so this cannot pass by saying nothing', () => {
    // The positive half. Every assertion above is satisfied by a screen with
    // no storage sentence at all, which would be a different failure with
    // the same green suite: a lawyer choosing a client's document told
    // nothing about where it goes.
    const intake = codeOf(path.join(ROOT, 'src/features/redlines/PrecedentIntake.tsx'));
    expect(intake).toContain('{PRECEDENT_STORAGE_PRIVACY}');
    const copy = readFileSync(path.join(ROOT, 'src/lib/privacyCopy.ts'), 'utf8');
    expect(copy).toContain("Stored in your firm's LexPrompt");
    expect(copy).toContain('never offered as something to review');
  });
});
