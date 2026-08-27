import type { ReviewRun } from '../types';

/**
 * Re-applies the human-authored parts of a run — verification and notes —
 * onto a snapshot produced by the run engine.
 *
 * `runReview` owns its own copy of the run and emits a full snapshot on
 * every cell transition. It never sets a verification: every `Finding` it
 * builds carries `unchecked()`. So without this, a verification made while
 * a run is still going is overwritten by the next unrelated cell finishing,
 * and the debounced save persists the loss — the user watches a finding go
 * verified and then silently un-verify itself.
 *
 * Two different rules, because verification and notes are different claims:
 *
 * - **Verification carries over only while the status is unchanged.** A
 *   verification is a judgement about specific output. If the status moved,
 *   the cell was re-run or is new, so the output changed and the judgement
 *   no longer applies — `unchecked` is then the honest answer.
 * - **Notes always carry over.** A note is a human's own commentary
 *   ("check this against the side letter"), not a claim about the current
 *   output, and it stays useful across a re-run. This matches the rule in
 *   Step 4, which clears verification on retry and deliberately keeps notes.
 */
export function carryHumanState(previous: ReviewRun | null, incoming: ReviewRun): ReviewRun {
  if (!previous) return incoming;

  let changed = false;
  const findings: ReviewRun['findings'] = {};

  for (const [docId, byClause] of Object.entries(incoming.findings)) {
    findings[docId] = {};
    for (const [clauseId, finding] of Object.entries(byClause)) {
      const before = previous.findings[docId]?.[clauseId];
      if (!before) {
        findings[docId][clauseId] = finding;
        continue;
      }

      const keepVerification =
        before.status === finding.status && before.verification.state !== 'unchecked';
      const keepNotes = before.notes.length > 0 && finding.notes.length === 0;

      if (!keepVerification && !keepNotes) {
        findings[docId][clauseId] = finding;
        continue;
      }

      changed = true;
      findings[docId][clauseId] = {
        ...finding,
        verification: keepVerification ? before.verification : finding.verification,
        notes: keepNotes ? before.notes : finding.notes,
      };
    }
  }

  // Returning `incoming` unchanged when nothing was carried keeps React's
  // identity check meaningful for the overwhelmingly common case.
  return changed ? { ...incoming, findings } : incoming;
}
