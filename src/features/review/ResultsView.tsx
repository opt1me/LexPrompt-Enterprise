import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Table, Mail, FileDown, Loader } from 'lucide-react';
import type { Clause, DocumentFile, Finding, ReviewRun, Settings } from '../../types';
import { FindingCard } from './FindingCard';
import { DocumentViewer } from './DocumentViewer';
import { exportDocx } from './exportDocx';
import { draftEmail } from '../assistant/draftEmail';
import { suggestRevision } from '../assistant/suggestRevision';
import { RevisionModal, type RevisionData } from '../assistant/RevisionModal';

// Both of these pull in `react-markdown` + `remark-gfm`, which are only ever
// needed once a user opens the Assistant tab or drafts an email — not on
// first paint. Lazy-loading them (the same pattern `documents.ts` uses for
// pdfjs and mammoth, and `exportDocx.ts` uses for `docx`) keeps that weight
// out of the entry chunk for the common case where neither is touched.
const ChatPanel = lazy(() => import('../assistant/ChatPanel').then(m => ({ default: m.ChatPanel })));
const EmailModal = lazy(() => import('../assistant/EmailModal').then(m => ({ default: m.EmailModal })));

export interface ResultsViewProps {
  run: ReviewRun;
  documents: DocumentFile[];
  settings: Settings;
  onRetryCell: (docId: string, clauseId: string) => void;
  /** Optional: wired in Task 17. Renders the "Tabular view" toggle only when supplied. */
  onOpenTabular?: () => void;
  /** Reports a failure from an assistant action (email, revision, export) so
   *  the caller can surface it however it surfaces other errors (a toast in
   *  App.tsx). Failures here are non-fatal to the run itself. */
  onError?: (message: string) => void;
}

type Tab = 'findings' | 'chat';

/**
 * Two panes: findings list (one FindingCard per clause, in template order)
 * on the left, DocumentViewer on the right. A document switcher above the
 * list swaps both panes together when the run covers more than one
 * document. `highlights` is local state set by a citation click and handed
 * straight to the viewer — that's the whole feature this task exists for.
 *
 * The left pane also carries a Findings/Assistant tab switch (Task 18):
 * Findings holds the cards plus Draft Email / Export DOCX actions, and
 * Assistant is the chat panel scoped to the active document.
 */
export function ResultsView({ run, documents, settings, onRetryCell, onOpenTabular, onError }: ResultsViewProps) {
  const [activeDocId, setActiveDocId] = useState(run.documentIds[0] ?? '');
  const [highlights, setHighlights] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('findings');

  const [emailLoading, setEmailLoading] = useState(false);
  const [emailContent, setEmailContent] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState(false);

  const [revisionLoadingClauseId, setRevisionLoadingClauseId] = useState<string | null>(null);
  const [revisionData, setRevisionData] = useState<RevisionData | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);

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

  const reportError = (fallback: string, error: unknown) => {
    onError?.(error instanceof Error ? error.message : fallback);
  };

  const handleDraftEmail = async () => {
    if (!activeDocId) return;
    setEmailLoading(true);
    try {
      const body = await draftEmail(run, activeDocId, settings);
      setEmailContent(body);
    } catch (error) {
      reportError('Could not draft the email.', error);
    } finally {
      setEmailLoading(false);
    }
  };

  const handleExport = async () => {
    if (!activeDocId || !activeDoc) return;
    setExportLoading(true);
    try {
      await exportDocx(run, activeDocId, activeDoc.name);
    } catch (error) {
      reportError('Could not export the report.', error);
    } finally {
      setExportLoading(false);
    }
  };

  const handleSuggestFix = async (clause: Clause, finding: Finding) => {
    setRevisionLoadingClauseId(clause.id);
    try {
      const original = finding.citations[0] ?? finding.summary ?? '';
      const revised = await suggestRevision(clause.title, original, finding.riskAnalysis ?? '', settings);
      setRevisionData({ title: clause.title, original, revised });
      setRevisionOpen(true);
    } catch (error) {
      reportError('Could not generate a revision.', error);
    } finally {
      setRevisionLoadingClauseId(null);
    }
  };

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

        <div className="flex border-b border-white/10 shrink-0">
          <button
            onClick={() => setTab('findings')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === 'findings' ? 'text-violet-400 border-b-2 border-violet-500' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Findings
          </button>
          <button
            onClick={() => setTab('chat')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === 'chat' ? 'text-violet-400 border-b-2 border-violet-500' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Assistant
          </button>
        </div>

        {tab === 'findings' ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-white text-sm">Analysis</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleDraftEmail}
                  disabled={emailLoading || !activeDocId}
                  title="Draft Email"
                  className="p-2 bg-white/5 rounded hover:bg-white/10 transition-colors text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {emailLoading ? <Loader className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                </button>
                <button
                  onClick={handleExport}
                  disabled={exportLoading || !activeDocId}
                  title="Export DOCX"
                  className="p-2 bg-violet-600 rounded hover:bg-violet-500 transition-colors text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exportLoading ? <Loader className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {run.templateSnapshot.clauses.map(clause => (
              <FindingCard
                key={clause.id}
                clause={clause}
                finding={findings[clause.id]}
                onCiteClick={setHighlights}
                onRetry={(clauseId) => onRetryCell(activeDocId, clauseId)}
                onSuggestFix={handleSuggestFix}
                suggestFixLoading={revisionLoadingClauseId === clause.id}
              />
            ))}
          </div>
        ) : (
          <Suspense fallback={<div className="p-4 text-xs text-gray-500">Loading assistant…</div>}>
            <ChatPanel documents={activeDoc ? [activeDoc] : []} settings={settings} />
          </Suspense>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <DocumentViewer doc={activeDoc} highlights={highlights} />
      </div>

      {emailContent !== null && (
        <Suspense fallback={null}>
          <EmailModal isOpen onClose={() => setEmailContent(null)} content={emailContent} />
        </Suspense>
      )}

      <RevisionModal isOpen={revisionOpen} onClose={() => setRevisionOpen(false)} data={revisionData} />
    </div>
  );
}
