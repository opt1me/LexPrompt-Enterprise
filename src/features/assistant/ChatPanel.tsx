import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader, MessageSquare } from 'lucide-react';
import type { DocumentFile, Settings } from '../../types';
import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { isAuthFailure } from '../../lib/model/authFailure';
import { sendChatMessage, type ChatMessage } from './chatContext';

export interface ChatPanelProps {
  documents: DocumentFile[];
  settings: Settings;
  /** An auth-class failure (a rejected sign-in, or the firm's own
   *  configuration) must never be presented as if it were a model's answer
   *  (Important 4) — reported here instead of appearing in the chat
   *  history, with the real error, so the caller can split it into the
   *  right sentence for the right audience (Task 23's `handleModelError`)
   *  rather than a single "route to Settings" this project no longer has a
   *  credential there to justify. */
  onAuthError?: (error: unknown) => void;
  /** The matter `documents` belongs to, if any — passed straight through to
   *  `sendChatMessage`'s `InferContext` (Task 21). Absent for documents
   *  loaded outside a matter. */
  matterId?: string;
}

/**
 * Assistant tab beside Findings in ResultsView. Ported from the deleted
 * ResultsView.tsx:249-283, with two bugs fixed along the way:
 *
 *  1. The original streamed tokens by mutating `next[next.length - 1].content`
 *     in place, which mutates React state directly. Every update here builds
 *     a new array with a new last-message object instead.
 *  2. The original sent `doc.text` as context unconditionally. On a scanned
 *     document `text` is empty (or, worse, just page-number markers with no
 *     real content) and the model would answer anyway — a confabulated
 *     answer about a document it never read. `sendChatMessage` (chatContext.ts)
 *     now mirrors `extractClause`'s fallback: send page images when there's
 *     no text and the model can read images, and decline honestly — without
 *     spending a request — when there's nothing usable at all.
 */
export function ChatPanel({ documents, settings, onAuthError, matterId }: ChatPanelProps) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [contextLength, setContextLength] = useState<number | undefined>(undefined);
  const [modelSupportsImages, setModelSupportsImages] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Best-effort: the model list is only needed to size the context budget
  // and to know whether the selected model can read page images, so a
  // failed fetch just falls back to conservative defaults rather than
  // blocking or erroring the chat panel.
  useEffect(() => {
    let cancelled = false;
    gatewayModelClient.listModels()
      .then(models => {
        if (cancelled) return;
        const match = models.find(m => m.id === settings.modelChoiceId);
        setContextLength(match?.contextLength);
        setModelSupportsImages(match?.supportsImages ?? false);
      })
      .catch(() => {
        if (!cancelled) {
          setContextLength(undefined);
          setModelSupportsImages(false);
        }
      });
    return () => { cancelled = true; };
  }, [settings.modelChoiceId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const handleSend = async () => {
    const query = input.trim();
    if (!query || loading) return;

    const priorHistory = history;
    setInput('');
    setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'assistant', content: '' }]);
    setLoading(true);

    try {
      const full = await sendChatMessage({
        documents,
        query,
        history: priorHistory,
        contextLength,
        modelSupportsImages,
        settings,
        matterId,
        onDelta: (chunk) => {
          setHistory(prev => [
            ...prev.slice(0, -1),
            { ...prev[prev.length - 1], content: prev[prev.length - 1].content + chunk },
          ]);
        },
      });
      // A decline (no readable text or images) resolves without ever
      // calling onDelta, so the placeholder is still empty here. Setting
      // the final text directly — rather than trusting only the deltas —
      // also guards the streamed path against a dropped final event.
      setHistory(prev => [
        ...prev.slice(0, -1),
        { ...prev[prev.length - 1], content: full },
      ]);
    } catch (error) {
      if (isAuthFailure(error)) {
        // An auth-class rejection must never be presented as if it were a
        // model's answer — drop the empty placeholder bubble entirely
        // rather than filling it with the rejection, and hand the real
        // error to the caller so it can show the right sentence to the
        // right audience (Important 4 / Task 23).
        setHistory(prev => prev.slice(0, -1));
        onAuthError?.(error);
        return;
      }
      const message = error instanceof Error ? error.message : 'Error processing request.';
      setHistory(prev => [
        ...prev.slice(0, -1),
        { ...prev[prev.length - 1], content: message },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-card">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {history.length === 0 && (
          <p className="font-ui text-ui-sm text-ink-4 p-2">
            Ask a question about the loaded document{documents.length > 1 ? 's' : ''}.
          </p>
        )}
        {history.map((m, i) => (
          <div
            key={i}
            className={`p-3 rounded-card max-w-[90%] ${
              m.role === 'user'
                ? 'ml-auto bg-accent-tint border border-accent-edge'
                : 'bg-paper border border-rule'
            }`}
          >
            <div className="font-prose text-finding text-ink-prose max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ node, ...props }) => <h1 className="font-prose text-clause text-ink-1 mb-2 mt-4 border-b border-rule pb-1" {...props} />,
                  h2: ({ node, ...props }) => <h2 className="font-prose text-section text-ink-1 mb-2 mt-3" {...props} />,
                  h3: ({ node, ...props }) => <h3 className="font-ui text-ui font-semibold text-ink-1 mb-1 mt-2" {...props} />,
                  ul: ({ node, ...props }) => <ul className="list-disc pl-4 space-y-1 mb-2 text-ink-prose" {...props} />,
                  li: ({ node, ...props }) => <li className="text-finding" {...props} />,
                  p: ({ node, ...props }) => <p className="mb-2 leading-relaxed" {...props} />,
                }}
              >
                {m.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {loading && (
          <div className="p-2 font-ui text-ui-sm text-ink-4 flex items-center gap-2" data-busy="true" aria-live="polite">
            <Loader className="w-3 h-3 animate-spin text-accent" aria-hidden="true" />
            Assistant is thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="p-3 border-t border-rule bg-card">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask about the contract..."
            className="flex-1 bg-card border border-rule-strong rounded-control px-3 py-2 font-ui text-ui text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={loading}
            className="p-2 bg-accent text-page rounded-control hover:bg-accent-strong transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquare className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
