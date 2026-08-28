import React from 'react';
import { CheckCircle2, Flag, XCircle, Circle, CircleDashed, Loader } from 'lucide-react';
import type { Finding, PlaybookClause } from '../../types';

export interface ClauseIndexProps {
  clauses: PlaybookClause[];
  /** This document's findings, keyed by clause id — the caller resolves the
   *  key through `findingsKeyFor`, exactly as every other consumer does. */
  findings: Record<string, Finding>;
  activeClauseId: string | null;
  onSelect: (clauseId: string) => void;
}

/** The first clause a human has not disposed of. A clause with NO finding
 *  counts as unchecked: a clause the run never reached is not a clause
 *  anybody signed off. */
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
 * column's cards read — it derives no count or status of its own that the
 * cards do not already carry, because the moment a second renderer computes
 * its own version of "how many are verified" the two can disagree
 * (CLAUDE.md's sibling-drift rule, and the reason the card view and the
 * grid are already two renderers over one map rather than two pipelines).
 */
export function ClauseIndex({ clauses, findings, activeClauseId, onSelect }: ClauseIndexProps) {
  let high = 0, flagged = 0, unchecked = 0;
  for (const clause of clauses) {
    const f = findings[clause.id];
    if (f?.riskLevel === 'High') high++;
    if (f?.verification?.state === 'flagged') flagged++;
    if ((f?.verification?.state ?? 'unchecked') === 'unchecked') unchecked++;
  }

  return (
    <nav
      aria-label="Clauses"
      className="w-full md:w-[258px] shrink-0 border-r border-rule bg-card flex flex-col min-h-0"
    >
      <div className="p-3 border-b border-rule flex flex-wrap gap-2">
        <span className="font-mono text-chip uppercase text-risk-high">{high} high</span>
        <span className="font-mono text-chip uppercase text-risk-med">{flagged} flagged</span>
        <span className="font-mono text-chip uppercase text-ink-4">{unchecked} unchecked</span>
      </div>
      <ul className="flex-1 overflow-y-auto min-h-0">
        {clauses.map((clause, i) => {
          const f = findings[clause.id];
          const active = clause.id === activeClauseId;
          const busy = f?.status === 'running';
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
                <span className="min-w-0">
                  <span className={`block font-ui text-ui-sm truncate ${active ? 'font-semibold text-ink-1' : 'text-ink-2'}`}>
                    {clause.title}
                  </span>
                  <span className="block font-mono text-pin text-ink-4">
                    {busy ? 'Extracting…' : `Clause ${i + 1} of ${clauses.length}`}
                  </span>
                </span>
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
 *  quietly claiming the same role. */
function StatusIcon({ finding }: { finding: Finding | undefined }) {
  const size = 'w-3.5 h-3.5 mt-0.5 shrink-0';
  if (!finding || finding.status === 'pending') return <CircleDashed className={`${size} text-ink-6 opacity-50`} aria-hidden="true" />;
  if (finding.status === 'running') return <Loader className={`${size} text-ink-6 animate-spin`} aria-hidden="true" />;
  switch (finding.verification?.state) {
    case 'verified': return <CheckCircle2 className={`${size} text-state-verified`} aria-hidden="true" />;
    case 'flagged': return <Flag className={`${size} text-state-flagged`} aria-hidden="true" />;
    case 'rejected': return <XCircle className={`${size} text-state-rejected`} aria-hidden="true" />;
    default: return <Circle className={`${size} text-ink-6`} aria-hidden="true" />;
  }
}
