import type { ReviewRun } from '../types';
import { unchecked } from './verification';

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
 * - **Notes carry over whenever `before` is a strict superset of
 *   `incoming`'s.** Notes are never removed by anything in this app — only
 *   added, by `handleAddNote` — so `before` (which may include a write made
 *   after `incoming` was captured) can safely win outright whenever every
 *   note `incoming` has is already present in `before` and `before` has
 *   more. This is deliberately NOT a plain "`incoming` is empty" check
 *   (`Task 10 fix round 1`): `handleRetryCell` reuses this same function for
 *   a finding `retryCell` never touches while a retry is in flight, and that
 *   finding's `incoming` copy is a frozen snapshot from before the retry
 *   started — it can be non-empty and still stale, e.g. one note already on
 *   it plus a second one a human adds mid-retry. A length-vs-empty check
 *   alone would silently drop that second note; comparing note identity
 *   (`id`) catches it. When `incoming` shows a note `before` does not have,
 *   `incoming` is trusted outright — that combination cannot happen from
 *   either real caller today, but treating it as "incoming knows something
 *   new" is the conservative reading if it ever does.
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

      // `before?.verification`/`.notes` are guarded, not assumed present:
      // a finding read from a persisted review that predates sub-project
      // B's schema (or a stale fixture) may carry neither field at all —
      // the same legacy shape `handleRetryCell`'s own reset guards against.
      // Treating a missing verification as `unchecked` (nothing to keep)
      // and missing notes as `[]` is the honest reading and keeps this
      // from crashing on data the type declares can't happen but that can
      // still show up at runtime — exactly the "quietly wrong" failure
      // this project exists to avoid, just inverted: a crash here is
      // worse than the modest degradation of not carrying state that was
      // never really there to carry.
      const beforeVerification = before.verification?.state ?? 'unchecked';
      const beforeNotes = before.notes ?? [];
      const findingNotes = finding.notes ?? [];

      const keepVerification =
        before.status === finding.status && beforeVerification !== 'unchecked';
      const keepNotes =
        beforeNotes.length > findingNotes.length &&
        findingNotes.every(n => beforeNotes.some(b => b.id === n.id));

      if (!keepVerification && !keepNotes) {
        findings[docId][clauseId] = finding;
        continue;
      }

      changed = true;
      findings[docId][clauseId] = {
        ...finding,
        verification: keepVerification ? before.verification! : (finding.verification ?? unchecked()),
        notes: keepNotes ? beforeNotes : findingNotes,
      };
    }
  }

  // Returning `incoming` unchanged when nothing was carried keeps React's
  // identity check meaningful for the overwhelmingly common case.
  return changed ? { ...incoming, findings } : incoming;
}
