import React, { useState } from 'react';
import { AlignLeft, Download, FileText, Loader, LayoutList, RotateCcw, CircleSlash, TriangleAlert } from 'lucide-react';
import type { Clause, DocumentFile, Finding, ReviewRun, RiskLevel } from '../../types';
import { findingKey } from '../../lib/verification';
import type { VerificationChange } from '../../lib/verification';
import { findingsKeyFor } from '../../lib/reviewTarget';
import { CellDetail } from './CellDetail';
import { buildTabularCsv } from './csv';

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
 * Rows are documents, columns are `run.templateSnapshot.clauses`. This is a
 * pure renderer over `run.findings` — the same map `ResultsView` reads — so
 * switching between card and tabular view never re-runs anything and never
 * loses state. It must never call `extractClause` or hold its own copy of
 * results; the only writes it triggers are `onRetryCell`, which is the same
 * callback the card view's Retry button calls.
 */
export function TabularReview({
  run, documents, onRetryCell, onOpenCards, interrupted = false,
  onVerify, onAddNote, verifyBusyKey, authorInitials,
}: TabularReviewProps) {
  const [wrapText, setWrapText] = useState(false);
  const [selected, setSelected] = useState<SelectedCell | null>(null);

  const clauses = run.templateSnapshot.clauses;

  const docName = (docId: string) => documents.find(d => d.id === docId)?.name ?? docId;

  const handleExport = () => {
    const csv = buildTabularCsv(run, documents);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${run.templateSnapshot.name || 'tabular-review'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedDoc = selected ? documents.find(d => d.id === selected.docId) ?? null : null;
  const selectedClause = selected ? clauses.find(c => c.id === selected.clauseId) ?? null : null;
  // Task 8A: a collection review's findings are keyed by the collection id
  // (`findingsKeyFor`), not by `selected.docId`/`docId` — those name which
  // document a cell's row belongs to for display, not the key its finding
  // lives under.
  const selectedFinding = selected
    ? run.findings[findingsKeyFor(run.target, selected.docId)]?.[selected.clauseId]
    : undefined;

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      <div className="h-14 border-b border-white/10 flex items-center justify-between px-6 bg-[#111] shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <h2 className="font-bold text-white flex items-center gap-2 shrink-0">Tabular review</h2>
          <span className="text-xs text-gray-500 bg-white/5 px-2 py-1 rounded border border-white/5 shrink-0">
            {run.documentIds.length} docs &middot; {clauses.length} clauses
          </span>
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
                    {clause.title}
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
            clause={selectedClause}
            finding={selectedFinding}
            onClose={() => setSelected(null)}
            onRetry={(clauseId) => onRetryCell(selected.docId, clauseId)}
            onVerify={onVerify ? (change) => onVerify(selected.docId, selected.clauseId, change) : undefined}
            onAddNote={onAddNote ? (text) => onAddNote(selected.docId, selected.clauseId, text) : undefined}
            verifyBusy={verifyBusyKey === findingKey(selected.docId, selected.clauseId)}
            authorInitials={authorInitials}
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
      <div className="flex items-start justify-between gap-1">
        <div className="flex items-start gap-1 min-w-0">
          {finding?.truncated && (
            <TriangleAlert className="w-3 h-3 text-yellow-400 shrink-0 mt-0.5" aria-label="Document truncated to fit context budget" />
          )}
          <div className={`${wrapText ? 'whitespace-normal' : 'truncate'} text-gray-300 max-h-32 overflow-hidden min-w-0`}>
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
    </td>
  );
}
