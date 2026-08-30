import type { Finding, ReviewRun } from '../types';
import { unchecked } from '@lexprompt/core';

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
 * Three different rules, because verification, a net position, and notes are
 * different claims:
 *
 * - **Verification carries over only while the status is unchanged.** A
 *   verification is a judgement about specific output. If the status moved,
 *   the cell was re-run or is new, so the output changed and the judgement
 *   no longer applies — `unchecked` is then the honest answer.
 * - **A net position's confirmation carries over the same way, for the same
 *   reason**: `confirmPosition`/`amendPosition` are a judgement about a
 *   specific synthesis, and `extractCollectionClause` (like `extractClause`)
 *   never writes anything but `unconfirmedPosition`. Without this, a
 *   confirmation made mid-run — sub-project C's own `handleConfirmNetPosition`
 *   / `handleAmendNetPosition`, App.tsx — would be silently overwritten the
 *   next time an unrelated clause's cell finished, exactly as an unguarded
 *   verification was before this function existed. Carried wholesale (not
 *   field by field) because `amended`/`proposed`/`byUserId`/`at` are one
 *   human decision, not independent facts to recombine.
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
      // `before.netPosition` is guarded for the same reason as above: a
      // standalone-document finding never has one at all, and this must not
      // treat that absence as anything to carry.
      const beforeNetPosition = before.netPosition;

      const keepVerification =
        before.status === finding.status && beforeVerification !== 'unchecked';
      const keepNotes =
        beforeNotes.length > findingNotes.length &&
        findingNotes.every(n => beforeNotes.some(b => b.id === n.id));
      const keepNetPosition =
        before.status === finding.status &&
        beforeNetPosition !== undefined &&
        beforeNetPosition.state !== 'unconfirmed';

      if (!keepVerification && !keepNotes && !keepNetPosition) {
        findings[docId][clauseId] = finding;
        continue;
      }

      changed = true;
      const merged: Finding = {
        ...finding,
        verification: keepVerification ? before.verification! : (finding.verification ?? unchecked()),
        notes: keepNotes ? beforeNotes : findingNotes,
      };
      // Set only when actually carrying it: `finding.netPosition` is
      // optional, and assigning it explicitly here even as `undefined` would
      // leave an `undefined`-valued key on the merged object — which
      // `structuredClone` (how IndexedDB writes every record) preserves,
      // unlike a key that was simply never set. `...finding` above already
      // carries whatever presence/absence `finding` itself had when this
      // branch does not override it.
      if (keepNetPosition) merged.netPosition = beforeNetPosition;
      findings[docId][clauseId] = merged;
    }
  }

  // Returning `incoming` unchanged when nothing was carried keeps React's
  // identity check meaningful for the overwhelmingly common case.
  return changed ? { ...incoming, findings } : incoming;
}
