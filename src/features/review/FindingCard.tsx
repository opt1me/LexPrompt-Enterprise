import React, { useState } from 'react';
import { Loader, ShieldAlert, AlertTriangle, RotateCcw, Wand2, CircleSlash, TriangleAlert } from 'lucide-react';
import type { Clause, Finding } from '../../types';
import type { VerificationChange } from '../../lib/verification';
import { RiskChip } from '../../components/RiskChip';
import { StateChip } from '../../components/StateChip';
import { Button } from '../../components/Button';
import { EvidenceList } from './EvidenceList';
import { VerificationControls } from './VerificationControls';
import { NotesPanel } from './NotesPanel';
import { NetPositionPanel } from './NetPositionPanel';
import { VariationTrailModal, type TrailDocumentInfo } from './VariationTrailModal';
import { isVerifiable } from '../../lib/findingOutcome';

export interface FindingCardProps {
  clause: Clause;
  finding: Finding | undefined;
  onCiteClick: (quotes: string[], documentId?: string) => void;
  onRetry: (clauseId: string) => void;
  /** Optional: wired in Task 18. Renders "Suggest Fix" on High/Medium risk
   *  findings only. Omitted entirely (e.g. in the tabular cell detail panel)
   *  when the caller has no revision flow to hand it off to. */
  onSuggestFix?: (clause: Clause, finding: Finding) => void;
  /** Shows a spinner on this card's Suggest Fix button while a revision for
   *  this specific clause is being generated. */
  suggestFixLoading?: boolean;
  /** True when the review this card belongs to is NOT currently live — i.e.
   *  nothing is actually calling the API for it right now. A `pending` or
   *  `running` card normally means "still queued/in flight, wait" and offers
   *  no Retry; that reading is wrong for a review reopened after an
   *  abandoned run (tab closed, reload, crash) mid-way through, where those
   *  same statuses mean "this cell never got a turn and never will on its
   *  own." When `interrupted` is true, pending/running cells get the same
   *  Retry action error/cancelled cells already have, so a stalled review is
   *  actually finishable rather than stuck forever looking like work still
   *  in flight (Important 1). Defaults to `false` so a genuinely live run's
   *  cards are unaffected. */
  interrupted?: boolean;
  /** documentId to display name, for the pin on each piece of evidence. A
   *  review can cover several documents; a quote has to say which one it is
   *  from. Optional so a caller with no name to give (a bare preview, or a
   *  finding not yet attached to any document) can omit it — `EvidenceList`
   *  falls back to the id in that case. `CellDetail` (the tabular cell
   *  detail panel) always has its one document in hand and passes it. */
  documentNames?: Record<string, string>;
  /** Reports the human's verification intent. Optional: a card rendered
   *  somewhere with no way to persist (a preview) simply shows the state
   *  chip and no controls, rather than offering an action that goes
   *  nowhere. */
  onVerify?: (change: VerificationChange) => void;
  /** True while this card's verification write is in flight. */
  verifyBusy?: boolean;
  /** Reports a new note's text. Optional, same reasoning as `onVerify`: a
   *  card with no way to persist simply omits the notes panel. */
  onAddNote?: (text: string) => void;
  /** True while this card's note write is in flight. */
  noteBusy?: boolean;
  /** The local profile's initials, shown against a note the user is about to
   *  write. Defaults to 'ME' when omitted (ruling R1: attribution is real
   *  but local — there is one user). */
  authorInitials?: string;
  /** Reports the human's intent to accept a collection clause's synthesised
   *  net position as written. Optional, same reasoning as `onVerify`: a card
   *  with no way to persist (a preview) shows the position and its state
   *  but no controls. */
  onConfirmNetPosition?: () => void;
  /** Reports the human's rewritten net position text. */
  onAmendNetPosition?: (text: string) => void;
  /** True while this card's net position write is in flight. */
  netPositionBusy?: boolean;
  /** documentId to what the variation trail needs to show about it — see
   *  `VariationTrailModal`. Optional: a caller with nothing to show for a
   *  document (or no trail to show at all) simply omits it, and any trail
   *  step naming an id absent here renders as unavailable rather than
   *  crashing. */
  documentInfo?: Record<string, TrailDocumentInfo>;
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
 * citations that drive the document viewer's highlights. `interrupted` (see
 * its own doc comment) additionally offers Retry on pending/running cards,
 * for a review reopened after an abandoned run rather than one actually
 * in flight.
 */
export function FindingCard({
  clause, finding, onCiteClick, onRetry, onSuggestFix, suggestFixLoading, interrupted = false, documentNames,
  onVerify, verifyBusy, onAddNote, noteBusy, authorInitials,
  onConfirmNetPosition, onAmendNetPosition, netPositionBusy, documentInfo,
}: FindingCardProps) {
  const status = finding?.status ?? 'pending';
  const [trailOpen, setTrailOpen] = useState(false);

  if (status === 'pending') {
    return (
      <div className={`${CARD_SHELL} border-white/5 border-dashed p-4 ${interrupted ? '' : 'opacity-40'} space-y-3`}>
        <span className="text-sm text-gray-500">{clause.title}</span>
        {interrupted && (
          <>
            <p className="text-xs text-gray-400 leading-relaxed">
              This review was interrupted before this clause was reviewed.
            </p>
            <Button variant="ghost" onClick={() => onRetry(clause.id)} className="w-full text-xs">
              <RotateCcw className="w-3 h-3" /> Retry
            </Button>
          </>
        )}
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
        {interrupted && (
          <div className="px-4 pb-4 space-y-2">
            <p className="text-xs text-gray-400 leading-relaxed">
              This review was interrupted before this clause finished — it will never complete on its own.
            </p>
            <Button variant="ghost" onClick={() => onRetry(clause.id)} className="w-full text-xs">
              <RotateCcw className="w-3 h-3" /> Retry
            </Button>
          </div>
        )}
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
        <div className="flex items-center gap-2">
          <RiskChip level={finding?.riskLevel} />
          {finding && <StateChip verification={finding.verification} />}
          {/* A `Verification` only ever exists on a `done` finding (it's the
             only status `VerificationControls` renders for), and the spec's
             single most important rule in this sub-project — "re-running a
             clause resets its verification to unchecked" (spec section 5,
             definition-of-done #3) — needs a way to re-run a `done` finding
             to mean anything. Without this, that reset is unreachable dead
             code: nowhere in the UI could ever produce the case it guards. */}
          <button
            type="button"
            onClick={() => onRetry(clause.id)}
            title="Re-run this clause"
            className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="sr-only">Retry</span>
          </button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {finding?.truncated && (
          <div className="flex items-start gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-[11px] text-yellow-300">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {/* Named, whenever the finding recorded names. A finding derived
                from a whole collection used to show the singular sentence
                below, which cannot tell a reviewer whether the amendment
                they grouped the collection to ask about is the document the
                model did not finish reading. Spec section 6: "the deed of
                variation was cut short" is actionable; "the text was
                truncated" is not. The singular wording stays for a
                single-document finding, where it is accurate. */}
            {finding.truncatedDocuments && finding.truncatedDocuments.length > 0 ? (
              <span>
                {finding.truncatedDocuments.length === 1 ? 'This document exceeds' : 'These documents exceed'} the
                selected model&apos;s context budget, so only part of {finding.truncatedDocuments.length === 1 ? 'it' : 'each'} was
                reviewed for this clause: {finding.truncatedDocuments.join(', ')}.
              </span>
            ) : (
              <span>
                This document exceeds the selected model&apos;s context budget — only part of it was reviewed for
                this clause.
              </span>
            )}
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

        {/* Above the evidence, deliberately: the reader meets the position
           and its confirmation state before the quotes that argue for it. */}
        <NetPositionPanel
          netPosition={finding?.netPosition}
          busy={netPositionBusy}
          onConfirm={onConfirmNetPosition}
          onAmend={onAmendNetPosition}
          onOpenTrail={() => setTrailOpen(true)}
        />

        {finding && (
          <EvidenceList
            citations={finding.citations}
            documentNames={documentNames ?? {}}
            onCiteClick={onCiteClick}
          />
        )}

        {/* `isVerifiable` (shared with `ResultsView`'s keyboard-shortcut gate
           — see its own doc comment in `findingOutcome.ts`) is the same
           `status === 'done'` rule this branch already reaches only by
           elimination; naming it here, rather than leaving it implicit in
           the switch above, is what keeps the two sites from being able to
           drift apart the way they did before (Critical 2). */}
        {isVerifiable(finding) && onVerify && (
          <VerificationControls
            verification={finding.verification}
            busy={verifyBusy}
            onChange={onVerify}
          />
        )}

        {finding && onAddNote && (
          <NotesPanel
            notes={finding.notes}
            authorInitials={authorInitials ?? 'ME'}
            busy={noteBusy}
            onAddNote={onAddNote}
          />
        )}
      </div>

      {finding?.netPosition && (
        <VariationTrailModal
          open={trailOpen}
          onClose={() => setTrailOpen(false)}
          netPosition={finding.netPosition}
          documents={documentInfo ?? {}}
          busy={netPositionBusy}
          onConfirm={onConfirmNetPosition}
          onAmend={onAmendNetPosition}
        />
      )}
    </div>
  );
}
