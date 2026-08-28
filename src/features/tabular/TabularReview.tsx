import React, { useState } from 'react';
import { AlignLeft, Download, FileText, Info, Loader, LayoutList, RotateCcw, CircleSlash, TriangleAlert } from 'lucide-react';
import type { DocumentFile, Finding, Review, ReviewRun, RiskLevel } from '../../types';
import { findingKey } from '../../lib/verification';
import type { VerificationChange } from '../../lib/verification';
import { findingsKeyFor, isCollectionTarget } from '../../lib/reviewTarget';
import { verificationCounts, isVerifiable } from '../../lib/findingOutcome';
import { StateChip } from '../../components/StateChip';
import { RiskChip } from '../../components/RiskChip';
import { CellDetail } from './CellDetail';
import { downloadTabularCsv } from './csv';

export interface TabularReviewProps {
  run: ReviewRun;
  documents: DocumentFile[];
  onRetryCell: (docId: string, clauseId: string) => void;
  /** Switches back to the card view (`ResultsView`). Optional so the grid can be used standalone. */
  onOpenCards?: () => void;
  /** Mirrors `FindingCard`'s `interrupted` prop (Important 1): true when this
   *  run is not currently live, so a `pending`/`running` cell means "stalled
   *  after an abandoned run," not "still in flight" — and gets the same
   *  Retry a done/error/cancelled cell already has. */
  interrupted?: boolean;
  /** Forwarded to `CellDetail` for whichever cell is open (Task 10). */
  onVerify?: (docId: string, clauseId: string, change: VerificationChange) => Promise<void>;
  onAddNote?: (docId: string, clauseId: string, text: string) => Promise<void>;
  verifyBusyKey?: string | null;
  authorInitials?: string;
  /** The grid's way out of triage: hands the clicked cell's `docId`/
   *  `clauseId` off to the ledger (Task 10). Optional, like `onVerify` and
   *  `onAddNote` — omitted, `CellDetail` renders with no such affordance
   *  rather than a button that goes nowhere. */
  onOpenInReview?: (docId: string, clauseId: string) => void;
}

interface SelectedCell {
  docId: string;
  clauseId: string;
}

// Subtle background tints so a scanned row reads its risk at a glance
// without needing to open every cell — deliberately faint (5% alpha), since
// the grid already has a lot going on and this is a secondary signal.
const RISK_CELL_CLASSES: Record<RiskLevel, string> = {
  High: 'bg-red-500/5',
  Medium: 'bg-yellow-500/5',
  Low: 'bg-green-500/5',
  Info: 'bg-blue-500/5',
};

/**
 * Task 12: how many FINDINGS across this run deviate from a standard
 * position, and whether any clause carries one at all. Derived the same
 * flat walk `verificationCounts` uses — every document's every clause's
 * finding — because "absent is not zero": a run where nothing was ever
 * compared to a house position must show no count at all, not a
 * "0 deviating" chip implying a comparison that never happened.
 *
 * m7 (final honesty review): this counts finding-INSTANCES, not distinct
 * clauses — a single clause deviating in all three documents of a 3-doc run
 * contributes 3, not 1. The label this feeds says so explicitly ("deviating
 * findings"), because it sits beside a "N docs · M clauses" summary and a
 * bare "N deviating" reads as a tally of clauses, which it is not and can
 * exceed.
 *
 * `unclear` is deliberately excluded from the tally. It means the model
 * could not tell, not that it found a conflict — counting it here would
 * report a deviation nobody actually found, the same distinction
 * `positionOutcomeLabel` (`findingOutcome.ts`) draws for the exports.
 *
 * Gated on `isVerifiable`, the same guard `findingOutcome.ts`'s
 * `positionOutcomeLabel` applies via `hasStandingPosition`. Stale as of the
 * final honesty review: `failRetryCell` (`App.tsx`) does NOT carry a
 * previous attempt's `positionOutcome` forward — it builds from `busy`,
 * which already has none, and only carries `netPosition`. The gate stays
 * right regardless: `extractClause`'s `noContent` branch attaches a
 * `positionOutcome` to an `error` finding directly, and without this guard
 * the exporters and this index could disagree about whether that still
 * counts — exactly the sibling-drift shape this project keeps paying for.
 */
function positionOutcomeCounts(findings: Review['findings']): { deviating: number; hasPosition: boolean } {
  let deviating = 0;
  let hasPosition = false;
  for (const byClause of Object.values(findings ?? {})) {
    for (const finding of Object.values(byClause ?? {})) {
      if (!isVerifiable(finding) || finding.positionOutcome === undefined) continue;
      hasPosition = true;
      if (finding.positionOutcome === 'deviates') deviating++;
    }
  }
  return { deviating, hasPosition };
}

/**
 * Rows are documents, columns are `run.templateSnapshot.clauses`. This is a
 * pure renderer over `run.findings` — the same map `ResultsView` reads — so
 * switching between card and tabular view never re-runs anything and never
 * loses state. It must never call `extractClause` or hold its own copy of
 * results; the only writes it triggers are `onRetryCell`, which is the same
 * callback the card view's Retry button calls.
 */
export function TabularReview({
  run, documents, onRetryCell, onOpenCards, interrupted = false,
  onVerify, onAddNote, verifyBusyKey, authorInitials, onOpenInReview,
}: TabularReviewProps) {
  const [wrapText, setWrapText] = useState(false);
  const [selected, setSelected] = useState<SelectedCell | null>(null);

  // A collection produces one position per clause, however many documents
  // fed it — there is nothing to compare across rows, so the comparison
  // grid this component renders below is refused entirely rather than
  // rendering a "comparison" that would just repeat the same synthesised
  // answer under every document's name.
  if (isCollectionTarget(run.target)) {
    return <CollectionNotComparable documentCount={run.documentIds.length} onOpenCards={onOpenCards} />;
  }

  const clauses = run.templateSnapshot.clauses;

  const docName = (docId: string) => documents.find(d => d.id === docId)?.name ?? docId;

  const handleExport = () => downloadTabularCsv(run, documents);

  const selectedDoc = selected ? documents.find(d => d.id === selected.docId) ?? null : null;
  const selectedClause = selected ? clauses.find(c => c.id === selected.clauseId) ?? null : null;
  // Task 8A: a collection review's findings are keyed by the collection id
  // (`findingsKeyFor`), not by `selected.docId`/`docId` — those name which
  // document a cell's row belongs to for display, not the key its finding
  // lives under.
  const selectedFinding = selected
    ? run.findings[findingsKeyFor(run.target, selected.docId)]?.[selected.clauseId]
    : undefined;

  // Task 12: the clause index counts deviations. `hasPosition` gates the
  // chip's very presence — see `positionOutcomeCounts`'s own doc comment for
  // why a run with no standard positions gets no chip at all, not "0".
  const positionCounts = positionOutcomeCounts(run.findings);

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      <div className="h-14 border-b border-white/10 flex items-center justify-between px-6 bg-[#111] shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="font-bold text-white flex items-center gap-2 shrink-0">Tabular review</h2>
          <span className="text-xs text-gray-500 bg-white/5 px-2 py-1 rounded border border-white/5 shrink-0">
            {run.documentIds.length} docs &middot; {clauses.length} clauses
          </span>
          {positionCounts.hasPosition && (
            <span className="text-xs text-rose-300 bg-rose-500/10 px-2 py-1 rounded border border-rose-500/20 shrink-0">
              {positionCounts.deviating} deviating finding{positionCounts.deviating === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setWrapText(w => !w)}
            className={`px-3 py-2 text-xs font-medium rounded transition-colors flex items-center gap-2 border ${
              wrapText
                ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/50'
                : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
            }`}
          >
            <AlignLeft className="w-4 h-4" /> Wrap
          </button>
          <button
            onClick={handleExport}
            className="px-3 py-2 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-gray-300 transition-colors flex items-center gap-2 border border-white/10"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          {onOpenCards && (
            <button
              onClick={onOpenCards}
              className="px-3 py-2 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-gray-300 transition-colors flex items-center gap-2 border border-white/10"
            >
              <LayoutList className="w-4 h-4" /> Card view
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <table className="w-full border-collapse">
            <thead className="bg-[#1a1a1a] sticky top-0 z-10 shadow-lg">
              <tr>
                <th className="text-left p-4 border-b border-r border-white/10 text-[11px] uppercase tracking-wider font-bold text-gray-500 w-64 sticky left-0 bg-[#1a1a1a] z-20 shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                  Document
                </th>
                {clauses.map(clause => (
                  <th
                    key={clause.id}
                    className="text-left p-4 border-b border-r border-white/10 text-[11px] uppercase tracking-wider font-bold text-gray-400 min-w-[220px]"
                  >
                    <div className="flex flex-col gap-1.5">
                      <span>{clause.title}</span>
                      <ColumnRiskBar run={run} clauseId={clause.id} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.documentIds.map(docId => (
                <tr key={docId} className="group hover:bg-[#111] transition-colors">
                  <td
                    className="p-3 border-b border-r border-white/10 text-xs font-medium text-white sticky left-0 bg-[#09090b] group-hover:bg-[#111] truncate max-w-[250px] shadow-[1px_0_0_0_rgba(255,255,255,0.1)]"
                    title={docName(docId)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-gray-400 border border-white/5 shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <span className="truncate">{docName(docId)}</span>
                    </div>
                  </td>
                  {clauses.map(clause => (
                    <Cell
                      key={clause.id}
                      finding={run.findings[findingsKeyFor(run.target, docId)]?.[clause.id]}
                      wrapText={wrapText}
                      isSelected={selected?.docId === docId && selected?.clauseId === clause.id}
                      onOpen={() => setSelected({ docId, clauseId: clause.id })}
                      onRetry={() => onRetryCell(docId, clause.id)}
                      interrupted={interrupted}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {run.documentIds.length === 0 && (
            <div className="p-10 text-center text-gray-500">No documents in this run.</div>
          )}
        </div>

        {selected && selectedClause && (
          <CellDetail
            doc={selectedDoc}
            documents={documents}
            clause={selectedClause}
            finding={selectedFinding}
            onClose={() => setSelected(null)}
            onRetry={(clauseId) => onRetryCell(selected.docId, clauseId)}
            onVerify={onVerify ? (change) => onVerify(selected.docId, selected.clauseId, change) : undefined}
            onAddNote={onAddNote ? (text) => onAddNote(selected.docId, selected.clauseId, text) : undefined}
            verifyBusy={verifyBusyKey === findingKey(selected.docId, selected.clauseId)}
            authorInitials={authorInitials}
            onOpenInReview={onOpenInReview ? () => onOpenInReview(selected.docId, selected.clauseId) : undefined}
          />
        )}
      </div>
    </div>
  );
}

interface CellProps {
  finding: Finding | undefined;
  wrapText: boolean;
  isSelected: boolean;
  onOpen: () => void;
  onRetry: () => void;
  /** Mirrors `FindingCard`'s `interrupted` — see `TabularReviewProps`. */
  interrupted?: boolean;
}

/** One grid cell. Status mirrors `FindingCard`: pending dims, running pulses,
 *  error turns red with an inline retry, done shows the (risk-tinted) summary. */
function Cell({ finding, wrapText, isSelected, onOpen, onRetry, interrupted = false }: CellProps) {
  const status = finding?.status ?? 'pending';
  const riskClass = finding?.riskLevel ? RISK_CELL_CLASSES[finding.riskLevel] : '';
  const selectedRing = isSelected ? 'shadow-[inset_0_0_0_2px_rgba(139,92,246,0.6)]' : '';

  if (status === 'pending') {
    return (
      <td
        onClick={onOpen}
        className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer ${interrupted ? '' : 'opacity-40'} ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-gray-600 italic">Pending</span>
          {interrupted && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white shrink-0"
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>
      </td>
    );
  }

  if (status === 'running') {
    return (
      <td onClick={onOpen} className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer ${selectedRing}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-gray-500">
            <Loader className="w-3 h-3 animate-spin text-violet-400" />
            <div className="h-2 bg-white/10 rounded w-16 animate-pulse" />
          </div>
          {interrupted && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white shrink-0"
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>
      </td>
    );
  }

  if (status === 'error') {
    return (
      <td
        onClick={onOpen}
        className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer bg-red-500/10 ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-red-400 truncate">{finding?.error || 'Error'}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white shrink-0"
            title="Retry"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </td>
    );
  }

  // Cancelled: calm and neutral, distinct from an error — the run was
  // stopped deliberately, this cell simply never finished.
  if (status === 'cancelled') {
    return (
      <td
        onClick={onOpen}
        className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer opacity-70 ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-gray-400 flex items-center gap-1.5">
            <CircleSlash className="w-3 h-3" /> Cancelled
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white shrink-0"
            title="Retry"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </td>
    );
  }

  // done
  return (
    <td
      onClick={onOpen}
      className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer transition-colors ${riskClass} ${selectedRing}`}
    >
      <div className="flex flex-col gap-1.5 min-w-0">
        {/* Task 10: the defect sub-project B found — a rejected cell and a
           verified cell looked identical because neither showed any
           verification state at all. StateChip (what a human concluded) and
           RiskChip (what the model concluded) are kept as two separate
           indicators here exactly as they are on `FindingCard` — a
           High-risk finding nobody has checked and a High-risk finding a
           lawyer verified are different things, and one badge cannot say
           which. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {finding && <StateChip verification={finding.verification} />}
          <RiskChip level={finding?.riskLevel} />
        </div>
        <div className="flex items-start justify-between gap-1">
          <div className="flex items-start gap-1 min-w-0">
            {finding?.truncated && (
              <TriangleAlert className="w-3 h-3 text-yellow-400 shrink-0 mt-0.5" aria-label="Document truncated to fit context budget" />
            )}
            {/* A readable sentence, not a truncated blob: wrapped shows the
               summary in full, and the default (unwrapped) view clamps to
               three lines rather than cutting a single line off mid-word. */}
            <div className={`${wrapText ? 'whitespace-normal' : 'line-clamp-3'} text-gray-300 min-w-0`}>
              {finding?.summary || <span className="text-gray-600 italic">Empty</span>}
            </div>
          </div>
          {/* Mirrors FindingCard's done-state Retry control: a Verification
             only ever exists on a `done` finding, so re-running one — the
             spec's rule that a re-run resets its verification — needs a
             trigger reachable from a done cell, not just error/cancelled ones. */}
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 hover:bg-white/10 rounded text-gray-500 hover:text-white shrink-0"
            title="Re-run this clause"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            <span className="sr-only">Retry</span>
          </button>
        </div>
      </div>
    </td>
  );
}

/**
 * A collection has one position per clause, however many documents fed it
 * — there is nothing to compare across rows. Rendering the grid anyway
 * would either show an empty table (misleading: the review isn't empty) or
 * repeat the same synthesised answer under every member document's name
 * (misleading the other way: implying a per-document disagreement that was
 * never assessed). Neither is acceptable, so this explains instead.
 */
function CollectionNotComparable({
  documentCount, onOpenCards,
}: { documentCount: number; onOpenCards?: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 bg-[#09090b] text-center p-10">
      <Info className="w-10 h-10 text-gray-500" aria-hidden="true" />
      <h2 className="font-bold text-white text-lg">No comparison grid for this review</h2>
      <p className="text-sm text-gray-400 max-w-md">
        This review targets a collection of {documentCount} linked documents. A collection
        produces one position per clause, not one answer per document — there is nothing
        to compare across rows, so the grid is not shown here.
      </p>
      {onOpenCards && (
        <button
          onClick={onOpenCards}
          className="px-3 py-2 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-gray-300 transition-colors flex items-center gap-2 border border-white/10"
        >
          <LayoutList className="w-4 h-4" /> Open in review
        </button>
      )}
    </div>
  );
}

/** Every finding, for one clause, across every row of the grid — the
 *  subset `verificationCounts` needs to summarise one column without this
 *  component re-deriving its own tally (Task 10: reuse, don't recount
 *  inline, so the grid and any report built from the same run can never
 *  quote different numbers). Only entries that actually have a `Finding`
 *  are included, matching `verificationCounts`' own iteration. */
function columnFindingsFor(run: ReviewRun, clauseId: string): Review['findings'] {
  const out: Review['findings'] = {};
  for (const docId of run.documentIds) {
    // `findingsKeyFor` is the one place a findings key is derived — this
    // component only ever runs past the `isCollectionTarget` guard above,
    // so this is always `docId` in practice, but going through it rather
    // than indexing `run.findings[docId]` directly is what keeps this file
    // from becoming an eighth copy of the document-key mistake this
    // sub-project has already made six times.
    const key = findingsKeyFor(run.target, docId);
    const finding = run.findings[key]?.[clauseId];
    if (finding) out[docId] = { [clauseId]: finding };
  }
  return out;
}

const RISK_BAR_ORDER: RiskLevel[] = ['High', 'Medium', 'Low', 'Info'];

const RISK_BAR_CLASSES: Record<RiskLevel, string> = {
  High: 'bg-red-500',
  Medium: 'bg-yellow-500',
  Low: 'bg-green-500',
  Info: 'bg-blue-500',
};

/** One clause column header's risk-distribution mini-bar plus a
 *  verification summary line, so a lawyer scanning the top of the grid can
 *  see at a glance which clause is worth reading down before opening a
 *  single cell. */
function ColumnRiskBar({ run, clauseId }: { run: ReviewRun; clauseId: string }) {
  const findings = columnFindingsFor(run, clauseId);
  const counts = verificationCounts(findings);

  const riskCounts: Record<RiskLevel, number> = { High: 0, Medium: 0, Low: 0, Info: 0 };
  for (const byClause of Object.values(findings)) {
    const level = byClause[clauseId]?.riskLevel;
    if (level) riskCounts[level]++;
  }
  const riskTotal = RISK_BAR_ORDER.reduce((sum, level) => sum + riskCounts[level], 0);
  const riskLabel = riskTotal === 0
    ? 'No risk data yet'
    : `Risk distribution: ${RISK_BAR_ORDER.map(level => `${riskCounts[level]} ${level}`).join(', ')}`;

  return (
    <div className="flex flex-col gap-1 normal-case font-normal">
      <div className="h-1.5 w-full rounded-full overflow-hidden bg-white/10 flex" role="img" aria-label={riskLabel}>
        {riskTotal > 0 && RISK_BAR_ORDER.map(level => (
          riskCounts[level] > 0 && (
            <span
              key={level}
              className={RISK_BAR_CLASSES[level]}
              style={{ width: `${(riskCounts[level] / riskTotal) * 100}%` }}
            />
          )
        ))}
      </div>
      {counts.total > 0 && (
        <span className="text-[10px] text-gray-500">{counts.verified}/{counts.total} verified</span>
      )}
    </div>
  );
}
