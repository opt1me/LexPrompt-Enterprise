import React from 'react';
import { CheckCircle2, Flag, XCircle, Circle, CircleDashed, Loader, AlertTriangle, CircleSlash } from 'lucide-react';
import type { Finding, PlaybookClause } from '../../types';
import type { PresenceMember } from '@lexprompt/core';
import { ClausePresence } from '../../components/PresenceRoster';
import type { DispositionAudience } from '../../lib/findingOutcome';

export interface ClauseIndexProps {
  clauses: PlaybookClause[];
  /** This document's findings, keyed by clause id — the caller resolves the
   *  key through `findingsKeyFor`, exactly as every other consumer does. */
  findings: Record<string, Finding>;
  activeClauseId: string | null;
  onSelect: (clauseId: string) => void;
  /**
   * WHO ELSE HAS SELECTED WHICH CLAUSE (§8, Task 23) — clause id to the
   * colleagues on it, EXCLUDING you, resolved by the caller.
   *
   * A SECOND MARK beside the status icon, never a change to it. The status
   * icon says what the machine produced and what a reviewer made of it; this
   * says who is reading it. One mark carrying both would be a face that
   * reads as a judgement, which is the one thing presence must never do.
   *
   * Optional: a rail rendered with none shows no markers, which is the same
   * as a review nobody else is in — and that is honest, because an absent
   * name never meant nobody is there.
   */
  presenceByClause?: Record<string, PresenceMember[]>;
  /** How a user id becomes a name, for the marker's own sentence. */
  audience?: DispositionAudience;
}

/** The first clause a human has not disposed of. A clause with NO finding
 *  counts as unchecked: a clause the run never reached is not a clause
 *  anybody signed off.
 *
 *  Deliberately WIDER than the rail's `unchecked` tally below, which
 *  excludes errored and cancelled clauses. This function answers "where
 *  does the reader go next?", and a clause that failed is somewhere they
 *  still have to go — to retry it. The tally answers a different question,
 *  "how much of this review is real output awaiting a human?", and a
 *  failure is not that. */
export function firstUncheckedClauseId(
  clauses: PlaybookClause[],
  findings: Record<string, Finding>,
): string | null {
  // `?.verification?.state`, not `?.verification.state`: `Finding.verification`
  // is documented as always present, but a live 401/authError path
  // (`App.authRedirect.test.tsx`) has produced findings that skip it, and a
  // navigation rail crashing the whole screen is a worse failure than the
  // rare clause it can't yet classify falling back to "unchecked" — the
  // same defensive shape `verificationCounts` already uses for exactly this
  // reason (`findingOutcome.ts`).
  const next = clauses.find(c => (findings[c.id]?.verification?.state ?? 'unchecked') === 'unchecked');
  return next ? next.id : null;
}

/**
 * The review screen's navigation rail (Task 23, `1b`'s three-pane ledger).
 * Purely a navigation surface over the SAME `findings` map the finding
 * column's cards read — every count and every icon is a per-clause lookup
 * in that one map, never a second pipeline, because the moment a second
 * renderer computes its own version of "how many are verified" the two can
 * disagree (CLAUDE.md's sibling-drift rule, and the reason the card view
 * and the grid are already two renderers over one map rather than two
 * pipelines).
 *
 * The status vocabulary is the one `FindingCard` and the grid's `Cell`
 * already use, for the reason spec §8.5 gives: a clause the model FAILED on
 * and a clause a human has not checked yet are different facts, and a rail
 * that drew both as the same grey circle would send a reader off to verify
 * an answer that was never produced.
 *
 * Minor 5 (final honesty review): this rail's counts are the ACTIVE
 * DOCUMENT's only — `findings` is the caller's map for one document, already
 * resolved through `findingsKeyFor` — while `ResultsView`'s header
 * (`progressLabel`) and `ExportGateBanner` both count the WHOLE RUN. Kept
 * that way rather than made to agree: the rail's job is to tell you which
 * clause of the document ON SCREEN still needs a look, so a run-wide number
 * here would answer a question this component was never asked. The
 * "unchecked" chip — the one word that also appears in the run-scoped
 * banner — says "unchecked here" rather than a bare number, so two
 * different-but-correct counts on one screen no longer look like a
 * disagreement.
 */
export function ClauseIndex({
  clauses, findings, activeClauseId, onSelect, presenceByClause, audience,
}: ClauseIndexProps) {
  let high = 0, flagged = 0, unchecked = 0, failed = 0, cancelled = 0;
  for (const clause of clauses) {
    const f = findings[clause.id];
    if (f?.riskLevel === 'High') high++;
    // An errored or a cancelled clause produced no answer at all, so it is
    // neither checked nor waiting to be checked. Counting either as
    // "unchecked" overstates how much of this review is real output a human
    // still has to read, and hides that some of it has to be RE-RUN before
    // anybody can read anything.
    if (f?.status === 'error') failed++;
    else if (f?.status === 'cancelled') cancelled++;
    else if (f?.verification?.state === 'flagged') flagged++;
    else if ((f?.verification?.state ?? 'unchecked') === 'unchecked') unchecked++;
  }

  return (
    <nav
      aria-label="Clauses"
      className="w-full md:w-[258px] shrink-0 border-r border-rule bg-card flex flex-col min-h-0"
    >
      <div className="p-3 border-b border-rule flex flex-wrap gap-2">
        <span className="font-mono text-chip uppercase text-risk-high">{high} high</span>
        <span className="font-mono text-chip uppercase text-risk-med">{flagged} flagged</span>
        <span className="font-mono text-chip uppercase text-ink-4" title="Unchecked clauses in this document only">{unchecked} unchecked here</span>
        {/* Rendered only when non-zero: the three above between them account
            for every clause that produced an answer, so "0 failed" is a
            reassurance nobody asked for. When they ARE non-zero they have to
            be said, because those clauses are missing from the other three
            counts and the reader would otherwise never learn they exist. */}
        {failed > 0 && (
          <span className="font-mono text-chip uppercase text-risk-high">{failed} failed</span>
        )}
        {cancelled > 0 && (
          <span className="font-mono text-chip uppercase text-ink-3">{cancelled} cancelled</span>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto min-h-0">
        {clauses.map((clause, i) => {
          const f = findings[clause.id];
          const active = clause.id === activeClauseId;
          const busy = f?.status === 'running';
          const failedHere = f?.status === 'error';
          const cancelledHere = f?.status === 'cancelled';
          return (
            <li key={clause.id}>
              <button
                type="button"
                onClick={() => onSelect(clause.id)}
                {...(busy ? { 'data-busy': 'true', 'aria-live': 'polite' as const } : {})}
                aria-current={active ? 'true' : undefined}
                className={`w-full text-left px-3.5 py-2 border-l-2 flex items-start gap-2 ${active ? 'border-l-ink-1 bg-chip-fill' : 'border-l-transparent hover:bg-chip-fill'}`}
              >
                <StatusIcon finding={f} />
                <span className="min-w-0 flex-1">
                  <span className={`block font-ui text-ui-sm truncate ${active ? 'font-semibold text-ink-1' : 'text-ink-2'}`}>
                    {clause.title}
                  </span>
                  {/* The icons are `aria-hidden`, so this line is the only
                      status a screen reader gets — it carries the same fact
                      the icon does, not just the clause's position. */}
                  <span className={`block font-mono text-pin ${failedHere ? 'text-risk-high' : 'text-ink-4'}`}>
                    {busy
                      ? 'Extracting…'
                      : failedHere
                        ? 'Failed — retry'
                        : cancelledHere
                          ? 'Cancelled'
                          : `Clause ${i + 1} of ${clauses.length}`}
                  </span>
                </span>
                {/* AFTER the clause's own text and status, deliberately: it
                    is the least of the three facts on this row, and putting
                    a face where the status icon sits would be the swap this
                    component's `presenceByClause` doc comment forbids. */}
                <ClausePresence
                  members={presenceByClause?.[clause.id] ?? []}
                  audience={audience}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The handoff's status-icon vocabulary, used consistently everywhere.
 *  Deliberately not `role="status"`: that role belongs to the chips this
 *  screen already renders, and a positional `[role="status"]` query
 *  elsewhere in this codebase has already broken once on a second element
 *  quietly claiming the same role.
 *
 *  `error` and `cancelled` are tested BEFORE the verification switch, and
 *  have to be: both carry `verification.state === 'unchecked'` (nothing
 *  derives verification — CLAUDE.md), so falling through would draw the
 *  plain grey circle of an answered-but-unchecked clause over a clause that
 *  produced no answer. The two treatments are `FindingCard`'s and the
 *  grid's, unchanged: error is a failure (`AlertTriangle`, `risk-high`),
 *  cancelled is calm (`CircleSlash`, `ink-4`) — the user stopped the run,
 *  nothing went wrong. */
function StatusIcon({ finding }: { finding: Finding | undefined }) {
  const size = 'w-3.5 h-3.5 mt-0.5 shrink-0';
  if (!finding || finding.status === 'pending') return <CircleDashed className={`${size} text-ink-6 opacity-50`} aria-hidden="true" />;
  if (finding.status === 'running') return <Loader className={`${size} text-ink-6 animate-spin`} aria-hidden="true" />;
  if (finding.status === 'error') return <AlertTriangle className={`${size} text-risk-high`} aria-hidden="true" />;
  if (finding.status === 'cancelled') return <CircleSlash className={`${size} text-ink-4`} aria-hidden="true" />;
  switch (finding.verification?.state) {
    case 'verified': return <CheckCircle2 className={`${size} text-state-verified`} aria-hidden="true" />;
    case 'flagged': return <Flag className={`${size} text-state-flagged`} aria-hidden="true" />;
    case 'rejected': return <XCircle className={`${size} text-state-rejected`} aria-hidden="true" />;
    default: return <Circle className={`${size} text-ink-6`} aria-hidden="true" />;
  }
}
