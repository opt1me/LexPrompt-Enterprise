import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

/**
 * PARTS 5A AND 5B'S DEFINITION OF DONE — the affordances, and the rules that
 * outlive the prohibitions they replaced.
 *
 * ## What this file is for, and what it deliberately is not
 *
 * Every behavioural claim in Parts 5A and 5B is proved by a suite that runs
 * the thing: `assignmentInbox.pg.test.ts`, `reviewAssignments.pg.test.ts`
 * and `search.pg.test.ts` against a real Postgres, `assignedToMe.*` and
 * `SearchPalette.test.tsx` and `ReportView.test.tsx` in jsdom, and
 * `stage5abDoD.compose.test.ts` on the running stack with three real
 * accounts. Restating any of them here would be two suites making one claim,
 * and the weaker copy is always the one that stays green when the property
 * breaks.
 *
 * So this asserts only what a SOURCE SCAN can honestly assert: that four
 * prohibitions became POSITIVE assertions rather than deletions, that the
 * two that must survive still do, and that Part 5C — the part that changes
 * what a request is capable of — has not started.
 */

const at = (p: string): string => path.join(ROOT, p);
const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...CORE_SOURCES];

function grepRepo(needle: RegExp, sources: string[] = ALL_SOURCES): string[] {
  return sources.filter(f => needle.test(codeOf(f))).map(rel).sort();
}

const COMPONENTS = WEB_SOURCES.filter(f => f.endsWith('.tsx') && !f.includes('.test.'));

describe('the scanners find something before anything is checked with them', () => {
  it('walks a realistic number of files in every workspace', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(30);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(COMPONENTS.length).toBeGreaterThan(40);
  });
});

describe('every inverted guard became a POSITIVE assertion, not a deletion (P46)', () => {
  it('names each released prohibition where it now asserts presence', () => {
    /*
     * FOUR STRINGS Stage 2, 3 and 4 forbade, and where each now asserts
     * presence instead. A guard that simply LOST its `it` would pass every
     * other test in the repository, which is why this one exists.
     *
     * FOUR DEFINITION-OF-DONE FILES carried the counter's prohibition, not
     * the two the plan named: `stage3DoD` and `stage4aDoD` had it too, and a
     * change that inverted only `stage2DoD` and `stage4DoD` would have
     * failed on the other two with a message about an affordance rather than
     * about a stale guard.
     */
    const s2 = codeOf(at('apps/api/test/stage2DoD.test.ts'));
    const s3 = codeOf(at('apps/api/test/stage3DoD.test.ts'));
    const s4a = codeOf(at('apps/api/test/stage4aDoD.test.ts'));
    const s4 = codeOf(at('apps/api/test/stage4DoD.test.ts'));

    for (const [name, code] of [['stage2', s2], ['stage3', s3], ['stage4a', s4a]] as const) {
      expect(code, `${name} no longer asserts the counter's presence`)
        .toMatch(/assignedToMe/i);
    }
    expect(s4).toMatch(/assignedToMe/i);
    expect(s4).toMatch(/AssigneeChip/);
    expect(s4).toMatch(/SearchPalette/);
    expect(s4).toMatch(/ReportView/);

    // …and the one that must STILL be forbidden by a guard.
    expect(s2).toMatch(/assigneeId/);
    expect(s2).toContain('R-G1');

    /*
     * THE FIRM TAG HAS NO GUARD AT ALL, and this is the honest form of that.
     *
     * The plan's brief said to assert `stage4DoD` still forbids it. No
     * shipped suite ever did: the absence is stated in `CLAUDE.md` and by
     * nothing executable, which is a rule with no enforcement — exactly the
     * shape the ⌘K guard turned out to be one layer along. So the absence is
     * asserted HERE for the first time, over the components, with the sanity
     * half a guard needs.
     */
    expect(grepRepo(/\bfirmTag\b|\bfirmName\b/, COMPONENTS)).toEqual([]);
    expect(/\bfirmTag\b/.test('const t = firmTag;')).toBe(true);
    expect(readFileSync(at('CLAUDE.md'), 'utf8')).toMatch(/no firm tag/i);
  });

  it('keeps the RULE each prohibition was protecting, now that the thing exists', () => {
    // A prohibition released without its rule is a prohibition deleted. Each
    // of these is the property that made the affordance safe to ship.
    const counter = codeOf(at('src/lib/assignedToMe.ts'));
    // THREE states: `ready` with zero and a failed read must not be the same
    // pixel.
    expect(counter).toMatch(/status: 'error'/);
    expect(counter).toMatch(/status: 'loading'/);

    // A CHIP IS NOT A DISPOSITION: no state or outcome ink, no disposition
    // word, and no control.
    const chip = codeOf(at('src/features/assignments/AssigneeChip.tsx'));
    expect(chip).not.toMatch(/text-state-|bg-state-|text-outcome-|bg-outcome-/);
    expect(chip).not.toMatch(/<button|<a\s/);
    for (const word of ['Verified', 'Flagged', 'Rejected', 'Unchecked', 'Approved']) {
      expect(chip, word).not.toContain(word);
    }
    // The sanity halves, so none of the `not` lines above is decoration.
    expect(/text-state-/.test('text-state-verified')).toBe(true);
    expect(/<button/.test('<button type="button">')).toBe(true);

    // THE CORPUS SENTENCE, in one place, on the palette.
    expect(codeOf(at('src/features/search/SearchPalette.tsx')))
      .toMatch(/does not search the text inside documents/);

    // THE REPORT borrows every sentence and fetches nothing.
    const report = codeOf(at('src/features/review/ReportView.tsx'));
    expect(report).toMatch(/exportSummaryLine/);
    expect(report).toMatch(/dispositionsAsAtLine/);
    expect(report).not.toMatch(/from '.*lib\/api/);
  });

  it('ships every surface behind those four names, at the path each is named by', () => {
    for (const file of [
      'src/lib/assignedToMe.ts',
      'src/features/assignments/AssignedToMe.tsx',
      'src/features/assignments/AssigneeChip.tsx',
      'src/features/search/useSearch.ts',
      'src/features/search/SearchPalette.tsx',
      'src/features/review/ReportView.tsx',
      'apps/api/src/routes/search.ts',
    ]) {
      expect(existsSync(at(file)), file).toBe(true);
    }
    // BY PATH, not by name: `UploadLocalData.tsx` exports a `ReportView` of
    // its own for the uploader's report, and a name grep answers the wrong
    // question in both directions.
    expect(grepRepo(/ReportView/, COMPONENTS))
      .toContain('src/features/review/ReportView.tsx');
  });
});

describe('one home for every piece of wording, still', () => {
  it('has exactly one id-to-name resolver', () => {
    // Every attribution surface in the app — the card's actor line, the
    // history panel, the roster, the activity feed and now the assignee chip
    // — resolves through one module, so there is one copy of a mutable field
    // in a tab rather than one per payload.
    expect(grepRepo(/export function userName/, WEB_SOURCES))
      .toEqual(['src/lib/api/users.ts']);
    expect(WEB_SOURCES.length).toBeGreaterThan(60);
  });

  it('has exactly one home for every piece of export wording', () => {
    for (const fn of ['exportSummaryLine', 'dispositionsAsAtLine', 'dispositionsMayChangeLine',
      'dispositionLabel', 'verificationLabel']) {
      expect(grepRepo(new RegExp(`export function ${fn}\\b`), WEB_SOURCES), fn)
        .toEqual(['src/lib/findingOutcome.ts']);
    }
    // The sanity half: the pattern finds a declaration that IS there.
    expect(grepRepo(/export function describeLoadError/, WEB_SOURCES))
      .toEqual(['src/lib/loadError.ts']);
  });

  it('has exactly one home for the unnamed-person wording, across four surfaces', () => {
    // The activity feed, the presence roster, the assignee chip and
    // `dispositionLabel` all render an id the directory does not hold. Two
    // wordings for one fact is how they come to disagree — so the STRING is
    // the same everywhere, checked rather than trusted.
    const users = grepRepo(/does not name/i, WEB_SOURCES);
    expect(users).toContain('src/features/assignments/AssigneeChip.tsx');
    expect(users).toContain('src/components/PresenceRoster.tsx');
    expect(users).toContain('src/lib/findingOutcome.ts');
    for (const file of users) {
      expect(codeOf(at(file)), file).toMatch(/this (workspace|record) does not name/i);
    }
  });
});

describe('Part 5C has not started — administration, where a screen writes policy', () => {
  it('has no admin write route, no migration and no panel yet', () => {
    // The seam between 5B and 5C is PRIVILEGE. Everything above could be
    // wrong and cost a person a retry; everything in 5C could be wrong and
    // cost a firm an access-control failure.
    expect(existsSync(at('apps/api/migrations/014_role_mapping_source.sql'))).toBe(false);
    expect(grepRepo(/RoleMappingPanel/, COMPONENTS)).toEqual([]);
    const grants = readFileSync(at('apps/api/migrations/001_identity.sql'), 'utf8')
      .replace(/--[^\n]*/g, '');
    expect(grants).toMatch(/grant select on role_mapping to lexprompt_app/);
    expect(grants).not.toMatch(/grant [^;]*insert[^;]*on role_mapping/i);
    expect(grants).not.toMatch(/grant [^;]*update[^;]*on role_mapping/i);
    // The sanity half: the scan can see a grant that IS there.
    expect(/grant [^;]*insert[^;]*on role_mapping/i
      .test('grant insert on role_mapping to lexprompt_app;')).toBe(true);
  });

  it('keeps every applied migration immutable — and the next free number is 015', () => {
    const migrations = readdirSync(at('apps/api/migrations')).filter(f => f.endsWith('.sql'));
    const numbers = migrations.map(f => Number(f.slice(0, 3))).sort((a, b) => a - b);
    // No gaps and no duplicates: a migration applied out of order is a
    // schema nobody can reproduce.
    expect(numbers).toEqual(numbers.map((_, i) => i));
    expect(migrations).toContain('013_assignment.sql');
    /*
     * PARTS 5A AND 5B ADDED NO MIGRATION AT ALL, which is the plan's own
     * ordering claim ("5A adds no grant, table or policy") asserted rather
     * than described.
     *
     * AND THE NEXT FREE NUMBER IS 015, NOT 014. The plan's Part 5C brief
     * names `014_role_mapping_source.sql`; `014_audit_partitions.sql`
     * already exists and an applied migration is immutable, so that file
     * name is taken and 5C's has to be `015_`. Recorded here, in the gate
     * that runs before 5C starts, because the alternative is discovering it
     * when two files claim one number.
     */
    expect(Math.max(...numbers)).toBe(14);
    expect(migrations).toContain('014_audit_partitions.sql');
  });

  it('adds no runtime dependency in any workspace', () => {
    // Compared against the versions Stage 4 closed with, listed here as
    // data. A new runtime dependency is a new thing in the bundle a firm's
    // browser executes, and it must be a decision rather than a side effect.
    const deps = (pkg: string): Record<string, string> =>
      (JSON.parse(readFileSync(at(pkg), 'utf8')) as {
        dependencies?: Record<string, string>;
      }).dependencies ?? {};
    expect(Object.keys(deps('package.json')).sort()).toEqual([
      '@lexprompt/core', 'docx', 'idb', 'jszip', 'lucide-react', 'mammoth',
      'oidc-client-ts', 'pdfjs-dist', 'pg', 'react', 'react-dom', 'react-markdown',
      'remark-gfm',
    ]);
    expect(Object.keys(deps('apps/api/package.json')).sort()).toEqual([
      '@azure/identity', '@azure/storage-blob', '@fastify/multipart', '@lexprompt/core',
      '@napi-rs/canvas', 'fastify', 'jose', 'pdfjs-dist', 'pg', 'undici', 'ws',
    ]);
    expect(Object.keys(deps('apps/gateway/package.json')).sort()).toEqual([
      '@azure/identity', '@azure/keyvault-secrets', '@lexprompt/core', 'fastify', 'undici',
    ]);
  });
});

describe('the affordances reach a person, which is the failure this project keeps having', () => {
  it('gives the search a visible control as well as a shortcut', () => {
    // Nineteen recorded instances of a correct mechanism with no path to it.
    // A feature reachable only by a key combination is one most people never
    // learn exists.
    const app = codeOf(at('src/App.tsx'));
    expect(app).toMatch(/SearchPalette/);
    expect(app).toMatch(/aria-label="Search this firm"/);
    expect(app).toMatch(/metaKey \|\| e\.ctrlKey/);
  });

  it('renders the counter and the report where a reader is', () => {
    const app = codeOf(at('src/App.tsx'));
    expect(app).toMatch(/<AssignedToMe/);
    expect(app).toMatch(/<ReportView/);
    // …and the Report tab is reachable from BOTH the card view and the grid,
    // rather than from whichever one happened to be wired.
    expect(codeOf(at('src/features/review/ResultsView.tsx'))).toMatch(/onOpenReport/);
    expect(codeOf(at('src/features/tabular/TabularReview.tsx'))).toMatch(/onOpenReport/);
  });

  it('states the app s own reach where an assignment is made', () => {
    // §17 Q2 is unanswered and saying so is the answer. An assigner who
    // believes an email went out has asked nobody.
    expect(codeOf(at('src/features/assignments/AssignPanel.tsx')))
      .toContain('Nothing is sent by email or chat.');
  });
});
