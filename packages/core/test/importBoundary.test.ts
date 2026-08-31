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

    // The run outbox's vocabulary (Stage 3 Task 12, P22). The reason these
    // belong here is the same reason the SSE names do: five event types are
    // the shape a browser and a worker have to agree on exactly, and a
    // second `RUN_EVENT_TYPES` in `src/lib/` — one type longer, or one
    // renamed — is a client that silently drops the event telling it a run
    // failed.
    'RUN_EVENT_TYPES', 'isRunEventType', 'RUN_STATES', 'RUN_CELL_STATES',

    // "Still being read" is not "read, and it says nothing" (Stage 3 Tasks 9
    // and 24). `parseState.ts`'s own docstring is the argument for these
    // being here: the fact is stated by the browser's two hydrations, the
    // server's two hydrations, the run route's refusal, the matter's
    // document list and the browser's pre-flight — *"a sentence repeated in
    // five places is a sentence that will be true in four of them"*. It
    // shipped once with `parseState` on the wire and no reader anywhere,
    // and a second copy of the SENTENCE is how the two refusals come to
    // describe different conditions.
    'isNotYetRead', 'notYetReadMessage', 'notYetReadMessageFor',
    'STILL_READING_NOTICE', 'failedToRead', 'couldNotBeReadMessageFor',

    // ---- Stage 4's WebSocket protocol (the cross-stage seam review, M4) ----
    //
    // THIS ARRAY WAS LAST EXTENDED IN STAGE 3, by the commit whose own
    // preamble is quoted above — the one that widened it after finding it
    // "omitted the five SSE/frame ones its own comment said it should carry".
    // Stages 4 and 5 then added twenty-seven core exports and none of them
    // reached here, `packages/core/src/api/socket.ts` entire among them: a
    // file that did not exist before Stage 4 and that is the SAME CLASS as
    // the SSE names one stage later. A browser and a server agreeing on a
    // subprotocol token, a close code and a channel key is exactly the
    // agreement a second copy breaks silently — a client subscribes to a
    // channel the server never fans out to, and nothing anywhere says so.
    //
    // The ledger no longer depends on anybody remembering: the case below
    // ("the ledger names every value export") derives the real set from
    // `packages/core/src` and fails BY NAME on the next one that is added
    // without being listed here. This array is the documented half of that
    // check, not its only half.
    'isClientFrame', 'isSubscriptionRef', 'subscriptionKey',
    'EVENT_TYPES', 'isEventType', 'PRESENCE_SCREENS', 'isPresenceScreen',
    'WS_PATH', 'WS_SUBPROTOCOL', 'WS_BEARER_PREFIX',
    'WS_CLOSE_UNAUTHENTICATED', 'WS_CLOSE_UNRESPONSIVE',
    'SEARCH_MIN_CHARS',

    // ---- the error and capability vocabulary both processes share ----
    //
    // `ModelError` is the class every refusal in this system is thrown as,
    // and `MODEL_ERROR_CODES` the closed set a browser switches on. A second
    // `ModelError` in `src/` would be a class an `instanceof` check quietly
    // stops recognising, which is a refusal rendered as an unknown crash.
    'ModelError', 'MODEL_ERROR_CODES', 'PURPOSES', 'PROVIDER_IDS',

    // ---- Stage 4's changeset/playbook vocabulary ----
    //
    // `isDecided`/`isPublishable` decide whether a changeset may be published
    // at all, and `nextVersionContent`/`applyItem` decide what a published
    // version CONTAINS. Two copies of either is two answers to "what did v4
    // say", which is the one question a review's snapshot exists to make
    // answerable.
    'isDecided', 'isPublishable', 'applyItem', 'nextVersionContent',
    'changeSummaryFor', 'provenanceFor', 'publishedTextFor',
    'defaultExtractPrompt', 'effectiveReason', 'newClauseTitle',
  ];

  /**
   * Names listed above that are TYPES, not values.
   *
   * They are deliberately in the ledger — a second `Role` union or a second
   * `MeResponse` shape is the same drift one level up — but the derivation
   * below reads value exports only, because `redefinition` matches
   * `function|const|class` and a ledger holding names the scan cannot act on
   * would be a longer list that guards nothing extra.
   */
  const typeOnly = ['Role', 'MeResponse'];

  const scanned = (): string[] => [
    ...walkIfPresent(path.join(ROOT, 'src')),
    ...walkIfPresent(path.join(ROOT, 'apps')).filter(f => !f.includes(`${path.sep}test${path.sep}`)),
  ];

  const redefinition = (name: string): RegExp =>
    new RegExp(`(function|const|class)\\s+${name}\\b`);

  /** Every VALUE `packages/core` exports, read from its own source. The
   *  ledger above is checked against this rather than against somebody's
   *  memory of what the last task added. */
  const coreValueExports = (): string[] => {
    const names = new Set<string>();
    const pattern = /^export\s+(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
    for (const file of walk(path.join(ROOT, 'packages/core/src'))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) names.add(match[1]);
    }
    return [...names].sort();
  };

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

  it('the derivation finds what it claims to read', () => {
    /*
     * THE SANITY HALF, and it is the half three guards in this repository
     * were missing when they went stale. A derivation that walked an empty
     * directory, or whose pattern stopped matching, would report "nothing
     * missing" over the whole package and read exactly like coverage.
     */
    const found = coreValueExports();
    expect(found.length).toBeGreaterThan(100);
    // Named individually: a count survives one export being deleted and
    // another added, which is the drift this is here to notice.
    expect(found).toContain('subscriptionKey');
    expect(found).toContain('extractClause');
    expect(found).toContain('findingsKeyFor');
    // …and the pattern does not mistake a type or a re-export for a value.
    expect(found).not.toContain('MeResponse');
  });

  it('the ledger names every value export packages/core has', () => {
    /*
     * WHY THIS EXISTS RATHER THAN A LONGER ARRAY.
     *
     * The array's own comment has said "EXTEND THIS ARRAY in every task that
     * adds a core export" since Stage 3, and two whole stages did not. An
     * instruction in a comment is not a guard; this is. A task that adds a
     * core export and forgets the ledger now fails HERE, by name, instead of
     * leaving a silently unguarded export for the next reviewer to diff by
     * hand.
     */
    const found = coreValueExports();
    const missing = found.filter(name => !exported.includes(name));
    expect(missing, 'core exports with no entry in `exported` above — a second copy of '
      + 'any of these in src/ or apps/ would pass this suite unnoticed. Add them, with a '
      + 'line saying what a second copy would break').toEqual([]);

    // The other direction: a ledger entry for something that no longer
    // exists is a name the scan spends time on and a reader trusts.
    const stale = exported.filter(name => !found.includes(name) && !typeOnly.includes(name));
    expect(stale, 'names in `exported` that packages/core no longer exports').toEqual([]);
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
