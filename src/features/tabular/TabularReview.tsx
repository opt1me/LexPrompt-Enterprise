import React, { useState } from 'react';
import { AlignLeft, Download, FileText, Info, Loader, LayoutList, RotateCcw, CircleSlash, TriangleAlert } from 'lucide-react';
import type { DocumentFile, Finding, Review, ReviewRun, RiskLevel } from '../../types';
import { findingKey } from '../../lib/verification';
import type { VerificationChange } from '../../lib/verification';
import { findingsKeyFor, isCollectionTarget } from '../../lib/reviewTarget';
import { verificationCounts, isVerifiable, positionOutcomeCounts } from '../../lib/findingOutcome';
import { StateChip } from '../../components/StateChip';
import { RiskChip } from '../../components/RiskChip';
import { Button } from '../../components/Button';
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
// without needing to open every cell — deliberately faint (the design
// system's own 5%-ish washes), since the grid already has a lot going on
// and this is a secondary signal.
const RISK_CELL: Record<RiskLevel, string> = {
  High: 'bg-risk-high-tint',
  Medium: 'bg-risk-med-tint',
  Low: 'bg-risk-low-tint',
  Info: 'bg-draft-tint',
};

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
    <div className="h-full flex flex-col bg-paper">
      <div className="h-14 border-b border-rule bg-card flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="font-prose text-section text-ink-1 flex items-center gap-2 shrink-0">Tabular review</h2>
          <span className="font-mono text-chip uppercase bg-chip-fill text-ink-4 rounded-chip px-2 py-1 shrink-0">
            {run.documentIds.length} docs &middot; {clauses.length} clauses
          </span>
          {positionCounts.hasPosition && (
            <span className="font-mono text-chip uppercase text-outcome-deviates border border-outcome-deviates rounded-chip px-2 py-1 shrink-0">
              {positionCounts.deviating} deviating finding{positionCounts.deviating === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setWrapText(w => !w)}
            className={`px-3 py-2 rounded-control font-ui text-button font-semibold transition-colors flex items-center gap-2 border ${
              wrapText
                ? 'bg-accent-tint text-accent border-accent-edge'
                : 'bg-chip-fill text-ink-2 border-rule hover:bg-rule'
            }`}
          >
            <AlignLeft className="w-4 h-4" aria-hidden="true" /> Wrap
          </button>
          <Button variant="ghost" onClick={handleExport} className="shrink-0">
            <Download className="w-4 h-4" aria-hidden="true" /> Export CSV
          </Button>
          {onOpenCards && (
            <Button variant="ghost" onClick={onOpenCards} className="shrink-0">
              <LayoutList className="w-4 h-4" aria-hidden="true" /> Card view
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <table className="w-full border-collapse">
            <thead className="bg-card sticky top-0 z-10">
              <tr>
                <th className="text-left p-4 border-b border-r border-rule font-mono text-label uppercase text-ink-4 w-64 sticky left-0 bg-card z-20">
                  Document
                </th>
                {clauses.map(clause => (
                  <th
                    key={clause.id}
                    className="text-left p-4 border-b border-r border-rule font-mono text-label uppercase text-ink-4 min-w-[220px]"
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
                <tr key={docId} className="group hover:bg-chip-fill transition-colors">
                  <td
                    className="p-3 border-b border-r border-rule font-ui text-ui-sm text-ink-1 sticky left-0 bg-paper truncate max-w-[250px]"
                    title={docName(docId)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-control bg-chip-fill flex items-center justify-center text-ink-4 shrink-0">
                        <FileText className="w-4 h-4" aria-hidden="true" />
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
            <div className="p-10 text-center font-ui text-ui text-ink-4">No documents in this run.</div>
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
  const riskClass = finding?.riskLevel ? RISK_CELL[finding.riskLevel] : '';
  const selectedRing = isSelected ? 'ring-1 ring-inset ring-accent' : '';

  if (status === 'pending') {
    return (
      <td
        onClick={onOpen}
        className={`p-3 border-b border-r border-rule font-ui text-ui-sm cursor-pointer ${interrupted ? '' : 'opacity-40'} ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-5 italic">Pending</span>
          {interrupted && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill shrink-0"
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </td>
    );
  }

  if (status === 'running') {
    return (
      <td onClick={onOpen} className={`p-3 border-b border-r border-rule font-ui text-ui-sm cursor-pointer ${selectedRing}`}>
        <div className="flex items-center justify-between gap-2">
          {/* R-G20/§8.6: the word "Extracting…" is what survives
             `prefers-reduced-motion` — the spinner and the pulsing bar are
             both collapsed by index.css's reduced-motion block, so the text
             must never be the only thing motion carries. */}
          {/* `aria-live` WITHOUT `role="status"` (R-GP2). This file's own
             tests find the verification chip with
             `container.querySelector('[role="status"]')` — the FIRST match
             — so a busy cell carrying that role would answer instead, and
             the assertion would quietly read the wrong element rather than
             fail. `aria-live="polite"` announces identically; the role is
             the part that collides. */}
          <div className="flex items-center gap-2 text-ink-4" data-busy="true" aria-live="polite">
            <Loader className="w-3 h-3 animate-spin text-accent" aria-hidden="true" />
            <span className="font-mono text-pin">Extracting…</span>
            <div className="h-2 bg-chip-fill rounded-inset w-16 lex-pulse" />
          </div>
          {interrupted && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill shrink-0"
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
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
        className={`p-3 border-b border-r border-rule font-ui text-ui-sm cursor-pointer bg-risk-high-tint ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-risk-high truncate">{finding?.error || 'Error'}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill shrink-0"
            title="Retry"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
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
        className={`p-3 border-b border-r border-rule font-ui text-ui-sm cursor-pointer opacity-70 ${selectedRing}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-4 flex items-center gap-1.5">
            <CircleSlash className="w-3 h-3" aria-hidden="true" /> Cancelled
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill shrink-0"
            title="Retry"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </td>
    );
  }

  // done
  return (
    <td
      onClick={onOpen}
      className={`p-3 border-b border-r border-rule font-ui text-ui-sm cursor-pointer transition-colors ${riskClass} ${selectedRing}`}
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
              <TriangleAlert className="w-3 h-3 text-risk-med shrink-0 mt-0.5" aria-label="Document truncated to fit context budget" />
            )}
            {/* A readable sentence, not a truncated blob: wrapped shows the
               summary in full, and the default (unwrapped) view clamps to
               three lines rather than cutting a single line off mid-word. */}
            <div
              data-testid="cell-summary"
              className={`${wrapText ? 'whitespace-normal' : 'line-clamp-3'} font-prose text-finding text-ink-prose min-w-0`}
            >
              {finding?.summary || <span className="font-ui text-ink-5 italic">Empty</span>}
            </div>
          </div>
          {/* Mirrors FindingCard's done-state Retry control: a Verification
             only ever exists on a `done` finding, so re-running one — the
             spec's rule that a re-run resets its verification — needs a
             trigger reachable from a done cell, not just error/cancelled ones. */}
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill shrink-0"
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
    <div className="h-full flex flex-col items-center justify-center gap-4 bg-paper text-center p-10">
      <Info className="w-10 h-10 text-ink-4" aria-hidden="true" />
      <h2 className="font-prose text-section text-ink-1">No comparison grid for this review</h2>
      <p className="font-ui text-ui text-ink-2 max-w-md">
        This review targets a collection of {documentCount} linked documents. A collection
        produces one position per clause, not one answer per document — there is nothing
        to compare across rows, so the grid is not shown here.
      </p>
      {onOpenCards && (
        <Button variant="ghost" onClick={onOpenCards}>
          <LayoutList className="w-4 h-4" aria-hidden="true" /> Open in review
        </Button>
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
  High: 'bg-risk-high',
  Medium: 'bg-risk-med',
  Low: 'bg-risk-low',
  Info: 'bg-draft',
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
      <div className="h-1.5 w-full rounded-meter overflow-hidden bg-chip-fill flex" role="img" aria-label={riskLabel}>
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
        <span className="font-mono text-pin text-ink-4">{counts.verified}/{counts.total} verified</span>
      )}
    </div>
  );
}
