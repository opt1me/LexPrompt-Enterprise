import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquare } from 'lucide-react';
import type { DocumentFile, Settings } from '../../types';
import { chatStream, listModels } from '../../lib/openrouter';

export interface ChatPanelProps {
  documents: DocumentFile[];
  settings: Settings;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT =
  'You are a helpful legal assistant. OUTPUT FORMATTING RULES: 1) Use ## for main sections. ' +
  '2) Use ### for subsections. 3) Use - for all lists (no numbered lists unless sequential). ' +
  '4) Bold **key terms**. 5) Keep paragraphs short. ALWAYS provide detailed reasoning based on CONTEXT.';

// A rough, explicit heuristic rather than an unexplained number: English
// legal prose runs close to 4 characters per token for OpenRouter's
// tokenizers, so `contextLength * 4` approximates the model's character
// budget. Half of that is reserved for the system prompt, prior turns and
// the model's own reply, leaving the other half for document context. This
// replaces the original's hardcoded 50,000-character cutoff, which was the
// same regardless of whether the selected model had an 8K or a 1M window.
const CHARS_PER_TOKEN = 4;
const CONTEXT_RESERVE_FRACTION = 0.5;
// Used only when the model's context length couldn't be looked up (list
// fetch failed, or the selected id isn't in the list) — a mid-sized window
// chosen so a lookup failure degrades to "conservative" rather than either
// "unusably tiny" or "silently unbounded".
const FALLBACK_CONTEXT_LENGTH = 32_000;

function contextBudgetChars(contextLength: number | undefined): number {
  const length = contextLength && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_LENGTH;
  return Math.floor(length * CHARS_PER_TOKEN * CONTEXT_RESERVE_FRACTION);
}

/**
 * Assistant tab beside Findings in ResultsView. Ported from the deleted
 * ResultsView.tsx:249-283, with one bug fixed along the way: the original
 * streamed tokens by mutating `next[next.length - 1].content` in place,
 * which mutates React state directly instead of replacing it. Every update
 * here builds a new array with a new last-message object instead.
 */
export function ChatPanel({ documents, settings }: ChatPanelProps) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [contextLength, setContextLength] = useState<number | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);

  // Best-effort: the model list is only needed to size the context budget,
  // so a failed fetch just falls back to FALLBACK_CONTEXT_LENGTH rather than
  // blocking or erroring the chat panel.
  useEffect(() => {
    let cancelled = false;
    listModels()
      .then(models => {
        if (cancelled) return;
        const match = models.find(m => m.id === settings.modelId);
        setContextLength(match?.contextLength);
      })
      .catch(() => {
        if (!cancelled) setContextLength(undefined);
      });
    return () => { cancelled = true; };
  }, [settings.modelId]);

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

    const budget = contextBudgetChars(contextLength);
    const context = documents
      .map(d => `--- ${d.name} ---\n${d.text}`)
      .join('\n\n')
      .slice(0, budget);
    const historyText = priorHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    const user = `CONTEXT: ${context}\nHISTORY: ${historyText}\nQUERY: ${query}`;

    try {
      await chatStream(
        { apiKey: settings.apiKey, modelId: settings.modelId, system: SYSTEM_PROMPT, user },
        (chunk) => {
          setHistory(prev => [
            ...prev.slice(0, -1),
            { ...prev[prev.length - 1], content: prev[prev.length - 1].content + chunk },
          ]);
        },
      );
    } catch (error) {
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
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {history.length === 0 && (
          <p className="text-xs text-gray-500 p-2">
            Ask a question about the loaded document{documents.length > 1 ? 's' : ''}.
          </p>
        )}
        {history.map((m, i) => (
          <div
            key={i}
            className={`p-3 rounded-lg text-xs max-w-[90%] ${
              m.role === 'user' ? 'ml-auto bg-violet-600 text-white' : 'bg-white/10 text-gray-300'
            }`}
          >
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ node, ...props }) => <h1 className="text-lg font-bold text-violet-300 mb-2 mt-4 border-b border-violet-500/30 pb-1" {...props} />,
                  h2: ({ node, ...props }) => <h2 className="text-base font-bold text-violet-200 mb-2 mt-3" {...props} />,
                  h3: ({ node, ...props }) => <h3 className="text-sm font-bold text-white mb-1 mt-2" {...props} />,
                  ul: ({ node, ...props }) => <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-300" {...props} />,
                  li: ({ node, ...props }) => <li className="text-xs" {...props} />,
                  p: ({ node, ...props }) => <p className="mb-2 leading-relaxed" {...props} />,
                }}
              >
                {m.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {loading && <div className="p-2 text-gray-500 text-xs animate-pulse">Assistant is thinking...</div>}
        <div ref={endRef} />
      </div>
      <div className="p-3 border-t border-white/10">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask about the contract..."
            className="flex-1 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={loading}
            className="p-2 bg-violet-600 text-white rounded-lg hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
