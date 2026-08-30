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
  // EXTEND THIS ARRAY in every task that adds a core export.
  //
  // It held eight names and omitted the five SSE/frame ones its own comment
  // said it should carry — the five that are, by this project's own
  // account, the highest-drift-risk exports in the repository ("five
  // providers means five event framings, and the naive reading of that is
  // five parsers — five surfaces for a bug this project has already paid
  // for twice", `sse.ts`). The scanner built to prevent a second copy was
  // the one that did not look for them: a second `createSseEventReader`
  // with subtly different CRLF or flush handling passed silently, and the
  // file read like coverage.
  const exported = [
    'parseJsonLoose', 'isPurpose', 'isProviderId', 'jurisdictionLabel',
    'isRetryableStatus', 'isSignInError', 'isServiceConfigError',
    'SERVICE_CONFIG_HINT',
    'createSseEventReader', 'sseFields', 'encodeFrame', 'decodeFrame', 'readFrames',
    'isModelErrorCode', 'truncationRefusal',
    'Role', 'ROLES', 'isRole', 'MeResponse',

    // ---- the review closure (Stage 3 Task 2, §13 Stage 0) ----
    //
    // Fourteen modules moved out of `src/lib/` so the browser and the worker
    // run ONE review engine. Every name below is exactly the kind this guard
    // was built for: `derivePage` is the only place a citation page number is
    // produced, `resetVerification` is the only thing that clears a human's
    // judgement when a clause is re-run, `findingsKeyFor` is the one place a
    // findings key is derived (six defects in sub-project C came from code
    // that keyed by document id inline), and `SCAN_TEXT_THRESHOLD` is the
    // per-page scan test this project has had to fix three times. A second
    // copy of any of them, reachable only from the other process, is the
    // failure S14 exists for.
    'isAuthFailure', 'isAccessRefusedError',
    'codeFromStatus', 'modelErrorFrom', 'inferResponseFrom',
    'uid', 'mapWithConcurrency',
    'SCAN_TEXT_THRESHOLD', 'pageSegments', 'pageSegmentsWithNumbers',
    'hasNoTextLayer', 'normalizeForMatch', 'findQuoteRects',
    'derivePage', 'repairCitations',
    'VerificationError', 'unchecked', 'requiresReason', 'applyVerification',
    'resetVerification', 'findingKey', 'makeNote',
    'NetPositionError', 'unconfirmedPosition', 'confirmPosition', 'amendPosition',
    'resetPosition', 'positionText', 'stepEffectText',
    'NO_RATIONALE_NOTE', 'OUTCOMES', 'normalisePositionOutcome',
    'DEFAULT_RISK_TOLERANCE', 'resolveRiskCriteria', 'riskCriteriaBlock',
    'isCollectionTarget', 'targetDocumentIds', 'findingsKeyFor',
    'extractableText', 'usableText', 'assessDocument', 'contextBudgetChars',
    'orderedMembers', 'buildCollectionPrompt',

    // The extractors themselves (Stage 3 Task 3). A second `extractClause`
    // is not a style problem: it is two functions deciding what a review of
    // a scanned document says, in two processes, with no way to read them
    // side by side.
    'extractClause', 'buildClausePrompt', 'clauseSchema', 'CLAUSE_SCHEMA',
    'extractCollectionClause', 'collectionClauseSchema', 'COLLECTION_CLAUSE_SCHEMA',
  ];

  const scanned = (): string[] => [
    ...walkIfPresent(path.join(ROOT, 'src')),
    ...walkIfPresent(path.join(ROOT, 'apps')).filter(f => !f.includes(`${path.sep}test${path.sep}`)),
  ];

  const redefinition = (name: string): RegExp =>
    new RegExp(`(function|const|class)\\s+${name}\\b`);

  it('the scanner is actually reading files, and its pattern bites', () => {
    // A guard that walks nothing passes vacuously, and this one now names
    // fifty-odd exports — the more names it carries, the more convincing its
    // silence looks. Both halves are checked before that silence is trusted.
    expect(scanned().length).toBeGreaterThan(150);
    expect(redefinition('findingsKeyFor').test('export function findingsKeyFor(t) {')).toBe(true);
    expect(redefinition('derivePage').test('const derivePage = (t) => 1;')).toBe(true);
    // …and does not bite on a call, or on an import of the real one.
    expect(redefinition('findingsKeyFor').test('const k = findingsKeyFor(target);')).toBe(false);
    expect(redefinition('unchecked').test("import { unchecked } from '@lexprompt/core';")).toBe(false);
  });

  it('nothing outside packages/core defines an export of packages/core', () => {
    // The mutation this test exists for: paste `export function
    // findingsKeyFor` into `src/lib/` and confirm THIS test fails. Restore.
    // A boundary guard that has never been shown to fail is a comment.
    const offenders: string[] = [];
    for (const file of scanned()) {
      const text = readFileSync(file, 'utf8');
      for (const name of exported) {
        if (redefinition(name).test(text)) {
          offenders.push(`${path.relative(ROOT, file)} redefines ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
