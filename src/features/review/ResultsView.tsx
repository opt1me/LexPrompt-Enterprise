import React, { useEffect, useMemo, useState } from 'react';
import { Table } from 'lucide-react';
import type { DocumentFile, ReviewRun } from '../../types';
import { FindingCard } from './FindingCard';
import { DocumentViewer } from './DocumentViewer';

export interface ResultsViewProps {
  run: ReviewRun;
  documents: DocumentFile[];
  onRetryCell: (docId: string, clauseId: string) => void;
  /** Optional: wired in Task 17. Renders the "Tabular view" toggle only when supplied. */
  onOpenTabular?: () => void;
}

/**
 * Two panes: findings list (one FindingCard per clause, in template order)
 * on the left, DocumentViewer on the right. A document switcher above the
 * list swaps both panes together when the run covers more than one
 * document. `highlights` is local state set by a citation click and handed
 * straight to the viewer — that's the whole feature this task exists for.
 */
export function ResultsView({ run, documents, onRetryCell, onOpenTabular }: ResultsViewProps) {
  const [activeDocId, setActiveDocId] = useState(run.documentIds[0] ?? '');
  const [highlights, setHighlights] = useState<string[]>([]);

  // If a fresh run replaces this one with a different document set, don't
  // keep pointing at a stale id.
  useEffect(() => {
    if (!run.documentIds.includes(activeDocId)) {
      setActiveDocId(run.documentIds[0] ?? '');
      setHighlights([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const activeDoc = useMemo(
    () => documents.find(d => d.id === activeDocId) ?? null,
    [documents, activeDocId],
  );

  const handleSwitchDoc = (id: string) => {
    setActiveDocId(id);
    setHighlights([]);
  };

  const findings = run.findings[activeDocId] ?? {};

  return (
    <div className="h-full flex flex-col lg:flex-row bg-[#09090b]">
      <div className="w-full lg:w-1/3 border-r border-white/10 flex flex-col bg-[#111] min-h-0">
        <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
          {run.documentIds.length > 1 ? (
            <select
              value={activeDocId}
              onChange={(e) => handleSwitchDoc(e.target.value)}
              className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white outline-none"
            >
              {run.documentIds.map(id => {
                const doc = documents.find(d => d.id === id);
                return (
                  <option key={id} value={id}>{doc?.name ?? id}</option>
                );
              })}
            </select>
          ) : (
            <span className="text-sm font-medium text-white truncate">{activeDoc?.name ?? 'Document'}</span>
          )}

          {onOpenTabular && (
            <button
              onClick={onOpenTabular}
              className="shrink-0 flex items-center gap-1.5 text-xs text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 px-2.5 py-1.5 rounded-lg border border-white/5 transition-colors"
            >
              <Table className="w-3.5 h-3.5" /> Tabular view
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {run.templateSnapshot.clauses.map(clause => (
            <FindingCard
              key={clause.id}
              clause={clause}
              finding={findings[clause.id]}
              onCiteClick={setHighlights}
              onRetry={(clauseId) => onRetryCell(activeDocId, clauseId)}
            />
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <DocumentViewer doc={activeDoc} highlights={highlights} />
      </div>
    </div>
  );
}
