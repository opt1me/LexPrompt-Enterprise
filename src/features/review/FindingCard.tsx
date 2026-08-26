import React from 'react';
import { Loader, ShieldAlert, MousePointerClick, AlertTriangle, RotateCcw, Wand2, CircleSlash, TriangleAlert } from 'lucide-react';
import type { Clause, Finding } from '../../types';
import { RiskBadge } from '../../components/RiskBadge';
import { Button } from '../../components/Button';

export interface FindingCardProps {
  clause: Clause;
  finding: Finding | undefined;
  onCiteClick: (quotes: string[]) => void;
  onRetry: (clauseId: string) => void;
  /** Optional: wired in Task 18. Renders "Suggest Fix" on High/Medium risk
   *  findings only. Omitted entirely (e.g. in the tabular cell detail panel)
   *  when the caller has no revision flow to hand it off to. */
  onSuggestFix?: (clause: Clause, finding: Finding) => void;
  /** Shows a spinner on this card's Suggest Fix button while a revision for
   *  this specific clause is being generated. */
  suggestFixLoading?: boolean;
}

// Written fresh, not ported: the corresponding classes in the deleted
// components/ResultsView.tsx (lines ~184, 206, 250) were mangled by a
// formatter into things like `flex - 1 py - 3 text - sm`, with stray spaces
// inside the Tailwind class names, so those elements render unstyled in the
// old app. Nothing here is copied from that file.
const CARD_SHELL = 'bg-[#1a1a1a] rounded-xl border';

/**
 * One clause's finding for the active document. `status` drives the whole
 * shape of the card: pending is a dimmed placeholder, running is a skeleton,
 * error surfaces the message with a Retry, and done is the full card with
 * citations that drive the document viewer's highlights.
 */
export function FindingCard({ clause, finding, onCiteClick, onRetry, onSuggestFix, suggestFixLoading }: FindingCardProps) {
  const status = finding?.status ?? 'pending';

  if (status === 'pending') {
    return (
      <div className={`${CARD_SHELL} border-white/5 border-dashed p-4 opacity-40`}>
        <span className="text-sm text-gray-500">{clause.title}</span>
      </div>
    );
  }

  if (status === 'running') {
    return (
      <div className={`${CARD_SHELL} border-white/5`}>
        <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5 rounded-t-xl">
          <span className="font-semibold text-sm text-white">{clause.title}</span>
          <Loader className="w-3.5 h-3.5 text-violet-400 animate-spin" />
        </div>
        <div className="p-4 space-y-2">
          <div className="h-2.5 bg-white/10 rounded w-full animate-pulse" />
          <div className="h-2.5 bg-white/10 rounded w-5/6 animate-pulse" />
          <div className="h-2.5 bg-white/10 rounded w-2/3 animate-pulse" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={`${CARD_SHELL} border-red-500/20`}>
        <div className="p-3 border-b border-red-500/10 flex justify-between items-center bg-red-500/5 rounded-t-xl">
          <span className="font-semibold text-sm text-white">{clause.title}</span>
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-red-300 leading-relaxed">{finding?.error || 'Something went wrong.'}</p>
          <Button variant="ghost" onClick={() => onRetry(clause.id)} className="w-full text-xs">
            <RotateCcw className="w-3 h-3" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  // Cancelled: the run was stopped deliberately (or this cell never got a
  // turn before that happened). Calm and neutral on purpose — never the red
  // error treatment, and never a raw DOMException string — but still
  // offers Retry, since re-running just this one cell is a reasonable next
  // step once the user is ready.
  if (status === 'cancelled') {
    return (
      <div className={`${CARD_SHELL} border-white/10`}>
        <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5 rounded-t-xl">
          <span className="font-semibold text-sm text-white">{clause.title}</span>
          <CircleSlash className="w-3.5 h-3.5 text-gray-400" />
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-gray-400 leading-relaxed">Cancelled before this clause was reviewed.</p>
          <Button variant="ghost" onClick={() => onRetry(clause.id)} className="w-full text-xs">
            <RotateCcw className="w-3 h-3" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  // done
  return (
    <div className={`${CARD_SHELL} border-white/5`}>
      <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5 rounded-t-xl">
        <span className="font-semibold text-sm text-white">{clause.title}</span>
        <RiskBadge level={finding?.riskLevel} />
      </div>
      <div className="p-4 space-y-3">
        {finding?.truncated && (
          <div className="flex items-start gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-[11px] text-yellow-300">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              This document exceeds the selected model&apos;s context budget — only part of it was reviewed for
              this clause.
            </span>
          </div>
        )}
        <p className="text-xs text-gray-300 leading-relaxed">{finding?.summary}</p>

        {finding?.riskAnalysis && (
          <div className="bg-red-900/10 p-2 rounded border border-red-500/10">
            <div className="text-[10px] text-red-400 font-bold mb-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" /> RISK ANALYSIS
            </div>
            <p className="text-xs text-gray-400">{finding.riskAnalysis}</p>
            {onSuggestFix && (finding.riskLevel === 'High' || finding.riskLevel === 'Medium') && (
              <Button
                variant="ghost"
                onClick={() => onSuggestFix(clause, finding)}
                loading={suggestFixLoading}
                className="mt-2 w-full py-1 text-[10px] bg-red-500/20 text-red-300 border-red-500/10 hover:bg-red-500/30"
              >
                <Wand2 className="w-3 h-3" /> Suggest Fix
              </Button>
            )}
          </div>
        )}

        {finding && finding.citations.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {finding.citations.map((c, i) => (
              <div key={i} className="group relative">
                <button
                  onClick={() => onCiteClick([c])}
                  className="text-[10px] bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white px-2 py-1 rounded border border-white/5 flex items-center gap-1 transition-colors"
                >
                  <MousePointerClick className="w-3 h-3" /> Ref {i + 1}
                </button>
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-64 p-3 bg-black/90 backdrop-blur border border-white/20 rounded-lg hidden group-hover:block z-50 text-[10px] text-gray-300 shadow-xl pointer-events-none">
                  <div className="text-white font-bold mb-1 border-b border-white/10 pb-1">Verbatim Quote</div>
                  &quot;{c}&quot;
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
