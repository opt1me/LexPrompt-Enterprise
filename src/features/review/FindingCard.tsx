import React, { useEffect, useState } from 'react';
import { Loader, ShieldAlert, AlertTriangle, RotateCcw, Wand2, CircleSlash, TriangleAlert } from 'lucide-react';
import type { PlaybookClause, Finding, RiskLevel } from '../../types';
import type { AssignmentView, DispositionWithHistory, VerificationChange } from '@lexprompt/core';
import { RiskChip } from '../../components/RiskChip';
import { StateChip } from '../../components/StateChip';
import { PositionChip } from '../../components/PositionChip';
import { Button } from '../../components/Button';
import { EvidenceList } from './EvidenceList';
import { VerificationControls } from './VerificationControls';
import { NotesPanel } from './NotesPanel';
import { NetPositionPanel } from './NetPositionPanel';
import { PositionComparison } from './PositionComparison';
import { VariationTrailModal, type TrailDocumentInfo } from './VariationTrailModal';
import { DispositionHistory } from './DispositionHistory';
import { AssignPanel } from '../assignments/AssignPanel';
import { ConflictNotice, type VerificationConflict } from './ConflictNotice';
import { mayApplyNow, sameCell, sameDisposition } from './pendingUpdate';
import { verificationFromDisposition } from '../../lib/api/findings';
import {
  dispositionLabel, heldUpdateLine, isVerifiable, type DispositionAudience,
} from '../../lib/findingOutcome';
import { formatInstant } from '../../lib/instant';

export interface FindingCardProps {
  clause: PlaybookClause;
  finding: Finding | undefined;
  onCiteClick: (quotes: string[], documentId?: string) => void;
  onRetry: (clauseId: string) => void;
  /** Optional: wired in Task 18. Renders "Suggest Fix" on High/Medium risk
   *  findings only. Omitted entirely (e.g. in the tabular cell detail panel)
   *  when the caller has no revision flow to hand it off to. */
  onSuggestFix?: (clause: PlaybookClause, finding: Finding) => void;
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
  onVerify?: (change: VerificationChange, atVersion?: number) => void;
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
  /** The local profile's id, so a note can be attributed to "you" only when
   *  the record says the local profile wrote it. Defaults to '' when
   *  omitted, which attributes nothing — the safe direction (R-GP5). */
  localUserId?: string;
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
  /**
   * WHO SET THE STATE THIS CARD IS SHOWING, AND WHEN (§6.3, Stage 4).
   *
   * The `finding_disposition` row the server last reported for this cell,
   * with the event that produced it —
   * `src/lib/api/findings.ts`'s `dispositionFor`.
   *
   * OPTIONAL, and `undefined` is NOT "nobody has checked this": it means
   * this browser has not read a disposition for the clause, which
   * `dispositionLabel` renders as exactly that rather than as "Not checked".
   * A finding nobody has touched arrives as a real disposition with
   * `changedCount: 0`.
   *
   * The card renders an actor because THIS says so, never because a name
   * happened to be resolvable — `audience` below can only turn an id into a
   * name, and cannot conjure the id.
   */
  disposition?: DispositionWithHistory;
  /** How to turn a user id into a name and an instant into a time. Optional:
   *  a card rendered with none falls back to `NO_DIRECTORY`, which names
   *  nobody — a true sentence rather than an invented name. */
  audience?: DispositionAudience;
  /**
   * A CHANGE THIS PERSON MADE THAT THE STORE REFUSED, because somebody else
   * moved the disposition first (§6.3, Stage 4).
   *
   * Rendered beside the card rather than as a toast, because it carries a
   * control — the change, offered again against the row that won — and a
   * notice that disappears on a timer is not somewhere to put a decision.
   * The card's own state does not move: `handleVerify` applies nothing on
   * the failure path.
   *
   * The caller passes it only to the card it is ABOUT; a card with no
   * conflict renders nothing here.
   */
  conflict?: VerificationConflict;
  /** Offers the refused change again. A person's click, never anything
   *  else (P25). */
  onReapplyConflict?: () => void;
  onDismissConflict?: () => void;
  /**
   * True while a control that composes a disposition for THIS finding is
   * open somewhere the card cannot see (P36).
   *
   * `ResultsView` mounts a second `RejectReasonModal` for the keyboard path
   * (`r` on the focused clause), which is not this card's own dialog and
   * which this card would otherwise have no way to know about. The card's
   * own reject dialog reports itself through `VerificationControls`; this is
   * the other half, and both feed one gate.
   */
  rejectModalOpen?: boolean;
  /**
   * The client cannot vouch for what is on screen (section 3's fourth load
   * state, Task 20).
   *
   * Passed straight through to every control that composes a HUMAN-AUTHORED
   * write — the disposition, a note, a net-position confirmation. The
   * findings themselves stay on screen: blanking them is the OTHER failure,
   * a reviewer who loses their place because the wifi blinked. The rule is
   * "never show disconnected data AS THOUGH IT WERE CURRENT", not "show
   * nothing".
   */
  stale?: boolean;
  /**
   * WHAT HAS BEEN ASKED ABOUT THIS CLAUSE, open (§6.3, S17, Task 25).
   *
   * Both directions: a request addressed to you reads *"A. Trainee asked you
   * to look at this"* with what they said; one you made reads *"You asked R.
   * Okafor to look at this"*. A bare marker would make the assignee open
   * every clause to find out what was wanted.
   *
   * NOT A DISPOSITION, and nothing here renders as one. An assignment
   * changes no state on this card: the chip above says what somebody
   * DECIDED, and this says what somebody ASKED.
   */
  assignments?: AssignmentView[];
  /**
   * Where an assignment this card creates belongs. Optional, and its absence
   * is what removes the assign action — the same rule `onVerify` follows: a
   * card with no way to persist offers no control that goes nowhere.
   */
  assignTarget?: { reviewId: string; findingsKey: string };
  /** The request the store actually took. Await-then-apply, like every other
   *  human-authored write. */
  onAssigned?: (assignment: AssignmentView) => void;
  /** Closes one — the assignee having looked, or the assigner withdrawing.
   *  The server refuses anybody else. */
  onResolveAssignment?: (id: string) => void;
}

/**
 * The audience a card falls back to when its caller hands it none.
 *
 * It names NOBODY. That is honest rather than helpful, and it is the right
 * direction: `dispositionLabel` turns an unresolvable id into *"someone this
 * workspace does not name"*, which is true of every actor when nothing has
 * been given a directory, and is never a name somebody did not have. Every
 * screen that has a directory passes its own.
 */
const NO_DIRECTORY: DispositionAudience = {
  nameOf: () => undefined,
  timeOf: formatInstant,
};

// Written fresh, not ported: the corresponding classes in the deleted
// components/ResultsView.tsx (lines ~184, 206, 250) were mangled by a
// formatter into things like `flex - 1 py - 3 text - sm`, with stray spaces
// inside the Tailwind class names, so those elements render unstyled in the
// old app. Nothing here is copied from that file.
const CARD_SHELL = 'bg-card rounded-card border';

// The card's left accent, by the MODEL's risk rating — a third, glance-able
// signal alongside RiskChip, distinct from the human StateChip's border. No
// accent at all for Info: an informational finding is not a risk. Applied
// only to the `done` shell, the only branch a riskLevel is ever known on.
const RISK_ACCENT: Record<RiskLevel, string> = {
  High: 'border-l-2 border-l-risk-high',
  Medium: 'border-l-2 border-l-risk-med',
  Low: 'border-l-2 border-l-risk-low',
  Info: '',
};
function riskAccent(level: RiskLevel | undefined): string {
  return level ? RISK_ACCENT[level] : '';
}

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
  onVerify, verifyBusy, onAddNote, noteBusy, authorInitials, localUserId,
  onConfirmNetPosition, onAmendNetPosition, netPositionBusy, documentInfo,
  disposition, audience = NO_DIRECTORY, conflict, onReapplyConflict, onDismissConflict,
  rejectModalOpen = false, stale = false,
  assignments, assignTarget, onAssigned, onResolveAssignment,
}: FindingCardProps) {
  const status = finding?.status ?? 'pending';
  const [trailOpen, setTrailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ownRejectOpen, setOwnRejectOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  /**
   * THE DISPOSITION THIS CARD IS SHOWING, which is not always the one it was
   * last handed (P36).
   *
   * A change from somebody else is applied the moment it arrives — that is
   * the default and it must stay the default, or the app feels broken. What
   * `mayApplyNow` holds back is exactly two cases: a write of this finding's
   * own disposition is in flight, or a control composing one for this
   * finding is open. In those two the incoming row is HELD and ANNOUNCED,
   * never swapped in under the person's hand.
   *
   * `heldIncoming` is DERIVED rather than stored: "something is being held"
   * is precisely "the prop and what is on screen disagree", and a second
   * piece of state saying the same thing is a second thing to get out of
   * step. `sameDisposition` compares VERSIONS, not object identity — every
   * poll hands this a structurally identical but referentially new object,
   * and an identity comparison would announce a change nobody made every few
   * seconds at anyone who happened to be typing.
   */
  // This card's own identifier, and the only one it needs: every question
  // `mayApplyNow` asks here is "is something open or in flight FOR ME". The
  // three-key shape is what the poll and socket paths need, where the busy
  // cell and the incoming cell are genuinely different findings.
  const cellKey = clause.id;
  const gateOpen = mayApplyNow({
    busyKey: verifyBusy ? cellKey : null,
    openModalKey: (ownRejectOpen || rejectModalOpen) ? cellKey : null,
    findingKey: cellKey,
  });
  const [shownDisposition, setShownDisposition] = useState(disposition);
  useEffect(() => {
    // A disposition for a DIFFERENT cell is not a change to this one — the
    // grid's detail panel re-renders this component for another clause
    // without remounting it — so it is taken immediately whatever is open.
    if (sameDisposition(disposition, shownDisposition)) return;
    if (gateOpen || !sameCell(disposition, shownDisposition)) setShownDisposition(disposition);
  }, [disposition, shownDisposition, gateOpen]);
  const heldIncoming = !sameDisposition(disposition, shownDisposition)
    && sameCell(disposition, shownDisposition) ? disposition : undefined;

  /**
   * THE STATE THIS CARD IS SHOWING — and P36 was only half-implemented
   * without it.
   *
   * `shownDisposition` held the ATTRIBUTION LINE back while a decision was
   * in progress, and everything else on the card kept rendering from
   * `finding.verification`: the `StateChip` at the top, and the highlighted
   * button inside `VerificationControls`. So a change from somebody else
   * landing while the reject-reason dialog was open left the line saying
   * one thing and the chip already saying the other — the state swapped in
   * under the person's hand, which is the exact failure the hold exists to
   * prevent, on the two elements a reviewer actually looks at.
   *
   * It was reachable before the socket: `refreshFindings` replaces the
   * whole findings map on every poll, so a poll landing mid-dialog did it
   * too. Stage 4 makes it constant rather than introducing it.
   *
   * `verificationFromDisposition` is the ONE mapping (`api/findings.ts`) —
   * `App.tsx`'s write handler and Stage 4's push handler read the same
   * one, because "which keys survive when a disposition is unchecked" is
   * not a question to answer three times.
   */
  const shownVerification = heldIncoming && shownDisposition
    ? verificationFromDisposition(shownDisposition.disposition)
    : finding?.verification;

  if (status === 'pending') {
    return (
      <div className={`${CARD_SHELL} border-rule border-dashed p-4 ${interrupted ? '' : 'opacity-60'} space-y-3`}>
        <span className="font-prose text-clause font-medium text-ink-1">{clause.title}</span>
        {interrupted && (
          <>
            <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
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
      <div className={`${CARD_SHELL} border-rule`}>
        <div
          className="p-3 border-b border-rule flex justify-between items-center bg-chip-fill rounded-t-card"
          data-busy="true"
          aria-live="polite"
        >
          <span className="font-prose text-clause font-medium text-ink-1">{clause.title}</span>
          {/* R-G20: a busy state whose only signal is an animation is
              invisible to a reader who turned animation off, and a stalled
              cell that looks blank rather than busy is the "cell spinning
              forever, unfinishable" defect in a different disguise. The word
              is the part that survives `prefers-reduced-motion`. */}
          <span className="font-mono text-pin text-ink-4 flex items-center gap-1.5">
            <Loader className="w-3.5 h-3.5 text-accent animate-spin" aria-hidden="true" />
            Extracting…
          </span>
        </div>
        {/* One class carries the loop (`.lex-pulse`), so
            `prefers-reduced-motion` collapses all three bars to static
            tinted bars in one place rather than three (R-G20). */}
        <div className="p-4 space-y-2">
          <div className="h-2.5 bg-chip-fill rounded-inset w-full lex-pulse" />
          <div className="h-2.5 bg-chip-fill rounded-inset w-5/6 lex-pulse" />
          <div className="h-2.5 bg-chip-fill rounded-inset w-2/3 lex-pulse" />
        </div>
        {interrupted && (
          <div className="px-4 pb-4 space-y-2">
            <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
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
    // Errored, not rejected: the model never answered, so there is no
    // summary, no evidence, and no StateChip to carry — only this message
    // and a Retry. A rejected-by-human finding is the `done` branch below
    // instead, carrying the model's answer plus a StateChip; the two must
    // never be visually interchangeable (spec §8.5).
    return (
      <div className={`${CARD_SHELL} bg-risk-high-tint border-risk-high-edge`}>
        <div className="p-3 border-b border-risk-high-edge flex justify-between items-center rounded-t-card">
          <span className="font-prose text-clause font-medium text-ink-1">{clause.title}</span>
          <AlertTriangle className="w-3.5 h-3.5 text-risk-high" aria-hidden="true" />
        </div>
        <div className="p-4 space-y-3">
          <p className="font-ui text-ui-sm text-risk-high leading-relaxed">{finding?.error || 'Something went wrong.'}</p>
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
      <div className={`${CARD_SHELL} bg-chip-fill border-rule`}>
        <div className="p-3 border-b border-rule flex justify-between items-center rounded-t-card">
          <span className="font-prose text-clause font-medium text-ink-1">{clause.title}</span>
          <CircleSlash className="w-3.5 h-3.5 text-ink-4" aria-hidden="true" />
        </div>
        <div className="p-4 space-y-3">
          <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">Cancelled before this clause was reviewed.</p>
          <Button variant="ghost" onClick={() => onRetry(clause.id)} className="w-full text-xs">
            <RotateCcw className="w-3 h-3" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  // done
  return (
    <div className={`${CARD_SHELL} border-rule ${riskAccent(finding?.riskLevel)}`}>
      <div className="p-3 border-b border-rule flex justify-between items-center rounded-t-card">
        <span className="font-prose text-clause font-medium text-ink-1">{clause.title}</span>
        <div className="flex items-center gap-2">
          <RiskChip level={finding?.riskLevel} />
          <PositionChip outcome={finding?.positionOutcome} />
          {finding && shownVerification && <StateChip verification={shownVerification} />}
          {/* A `Verification` only ever exists on a `done` finding (it's the
             only status `VerificationControls` renders for), and the spec's
             single most important rule in this sub-project — "re-running a
             clause resets its verification to unchecked" (spec section 5,
             definition-of-done #3) — needs a way to re-run a `done` finding
             to mean anything. Without this, that reset is unreachable dead
             code: nowhere in the UI could ever produce the case it guards. */}
          {/* `relative`: this button is the sr-only label's containing
             block. Without a positioned ancestor, an absolutely-positioned
             `sr-only` span's static position is computed against the
             document root, not this button — which is exactly how one
             instance of this same pattern extended the review screen's
             scrolled finding column to 14,570px and produced a whole-window
             scrollbar over blank space (final behaviour review). Do not
             remove this without checking every ancestor up to the nearest
             positioned one still clips it. */}
          <button
            type="button"
            onClick={() => onRetry(clause.id)}
            title="Re-run this clause"
            className="relative p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="sr-only">Retry</span>
          </button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {finding?.truncated && (
          <div className="flex items-start gap-2 p-2 bg-risk-med-tint border border-risk-med-edge rounded-inset font-ui text-ui-sm text-risk-med">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
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
        {/* Above the summary and the evidence, deliberately: the reader
           meets the comparison against the firm's own position before the
           model's free-text summary and the quotes that argue for it —
           mirrors where `NetPositionPanel` sits for the same reason. */}
        {clause.standardPosition && finding && (
          <PositionComparison position={clause.standardPosition} finding={finding} />
        )}

        <p className="font-prose text-finding text-ink-prose [text-wrap:pretty]">{finding?.summary}</p>

        {finding?.riskAnalysis && (
          <div className="bg-risk-high-tint p-2 rounded-inset border border-risk-high-edge">
            <div className="font-mono text-label uppercase text-risk-high mb-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" aria-hidden="true" /> Risk analysis
            </div>
            <p className="font-ui text-ui-sm text-ink-2">{finding.riskAnalysis}</p>
            {onSuggestFix && (finding.riskLevel === 'High' || finding.riskLevel === 'Medium') && (
              <Button
                variant="ghost"
                onClick={() => onSuggestFix(clause, finding)}
                loading={suggestFixLoading}
                className="mt-2 w-full py-1 text-[10px] text-risk-high border-risk-high-edge hover:bg-risk-high-tint"
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
          stale={stale}
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
        {/* WHO SET THE STATE THE CHIP ABOVE IS SHOWING, AND WHEN (§6.3).
           Rendered whether or not this card can CHANGE a disposition:
           attribution is information a reader is entitled to, not a control
           — a preview with no `onVerify` still has to be honest about who
           checked the clause.

           ONE ink for the whole line rather than a colour per state, and
           deliberately: the `StateChip` two rows up already carries the
           state's colour, and a second coloured rendering of the same fact
           is a second place for the two to disagree. It also means no class
           name here is ever built from a variable — Tailwind's compiler
           finds classes by scanning for complete literal strings, so a
           template-built name is silently no styling at all, with no error
           and no failing test. */}
        {isVerifiable(finding) && (
          <p data-disposition-label className="font-ui text-ui-sm text-ink-4">
            {dispositionLabel(shownDisposition, audience)}
            {/* §6.3: "the card shows that fact inline and makes the history
               reachable in one action". ONE action, from the line that
               states the fact.

               Offered only where there is a history to open — a disposition
               nobody has moved has no events, and a button that opened an
               empty panel would be an affordance for nothing. The ids come
               off the disposition the SERVER stated, so the panel cannot be
               opened against a cell this card only thinks it is showing. */}
            {shownDisposition && shownDisposition.disposition.changedCount > 0 && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  className="underline underline-offset-2 hover:text-ink-1 transition-colors"
                >
                  See what changed
                </button>
              </>
            )}
          </p>
        )}

        {/* HELD, AND SAID (P36). Applying an update under an open dialogue
           is worse than showing a state the store did not take: the person
           then submits a judgement about text that has moved, with no error
           and no flicker anyone would name. Concealing it would be the same
           defect one step later, so the hold is announced. */}
        {isVerifiable(finding) && heldIncoming && (
          <p data-held-update className="font-ui text-ui-sm text-ink-4" role="status">
            {heldUpdateLine(heldIncoming, audience)}
          </p>
        )}

        {/* Directly above the controls that produced it, deliberately: the
           refusal is about the button the reader just pressed, and a notice
           anywhere else on the card would have to name the clause to be
           understood. */}
        {isVerifiable(finding) && conflict && onReapplyConflict && onDismissConflict && (
          <ConflictNotice
            current={conflict.current}
            attempted={conflict.attempted}
            audience={audience}
            onReapply={onReapplyConflict}
            onDismiss={onDismissConflict}
            busy={verifyBusy}
          />
        )}

        {isVerifiable(finding) && onVerify && (
          <VerificationControls
            verification={shownVerification ?? finding.verification}
            busy={verifyBusy}
            stale={stale}
            // THE VERSION THIS CARD WAS SHOWING, not the one the module
            // cache last heard (P36). A change held off the screen still
            // moved that cache, so a judgement submitted from here would
            // otherwise land on a state its author never read. Stating what
            // was on screen means the store REFUSES it, and the refusal
            // names who replaced it.
            onChange={(change) => onVerify(change, shownDisposition?.disposition.version)}
            onRejectOpenChange={setOwnRejectOpen}
          />
        )}

        {/* WHAT HAS BEEN ASKED, and by whom. Above the notes and below the
           controls, because it is neither: a note is a remark on the record
           and a disposition is a judgement, and this is a request one person
           made of another (§6.3). */}
        {isVerifiable(finding) && (assignments ?? []).length > 0 && (
          <div data-assignments className="space-y-2 border-l-2 border-l-draft pl-3">
            {(assignments ?? []).map(a => {
              const mine = a.assigneeUserId === localUserId;
              const asker = audience.nameOf(a.assignedByUserId)
                ?? 'Someone this workspace does not name';
              const asked = audience.nameOf(a.assigneeUserId)
                ?? 'someone this workspace does not name';
              return (
                <div key={a.id} className="space-y-1">
                  <p data-assignment={a.id} className="font-ui text-ui-sm text-ink-2">
                    {mine ? `${asker} asked you to look at this` : `You asked ${asked} to look at this`}
                  </p>
                  {/* THE MESSAGE, not just a badge. Without it the assignee
                      opens the clause to work out what was wanted. */}
                  {a.message && (
                    <p className="font-prose text-field text-ink-prose">{a.message}</p>
                  )}
                  {onResolveAssignment && (
                    <button
                      type="button"
                      onClick={() => onResolveAssignment(a.id)}
                      disabled={stale}
                      className="font-ui text-ui-sm text-accent underline underline-offset-2 hover:text-accent-strong disabled:opacity-50 disabled:no-underline transition-colors"
                    >
                      {mine ? 'I have looked at this' : 'Withdraw the request'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* TWO ACTS, TWO CLICKS, one place. Flagging records a judgement
           about the answer; assigning asks a person to look. Doing both in
           one click would write a disposition the person may not have meant
           (§6.3), so they sit beside each other and stay separate. */}
        {isVerifiable(finding) && assignTarget && onAssigned && (
          <div>
            <button
              type="button"
              onClick={() => setAssignOpen(true)}
              disabled={stale}
              className="font-ui text-ui-sm text-ink-3 underline underline-offset-2 hover:text-ink-1 disabled:opacity-50 disabled:no-underline transition-colors"
            >
              Ask a colleague to look at this
            </button>
          </div>
        )}

        {finding && onAddNote && (
          <NotesPanel
            notes={finding.notes}
            authorInitials={authorInitials ?? 'ME'}
            localUserId={localUserId ?? ''}
            busy={noteBusy}
            stale={stale}
            onAddNote={onAddNote}
          />
        )}
      </div>

      {assignTarget && onAssigned && (
        <AssignPanel
          open={assignOpen}
          reviewId={assignTarget.reviewId}
          findingsKey={assignTarget.findingsKey}
          clauseId={clause.id}
          clauseTitle={clause.title}
          meId={localUserId}
          stale={stale}
          onClose={() => setAssignOpen(false)}
          onAssigned={onAssigned}
        />
      )}

      {historyOpen && shownDisposition && (
        <DispositionHistory
          reviewId={shownDisposition.disposition.reviewId}
          findingsKey={shownDisposition.disposition.findingsKey}
          clauseId={shownDisposition.disposition.clauseId}
          audience={audience}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {finding?.netPosition && (
        <VariationTrailModal
          open={trailOpen}
          onClose={() => setTrailOpen(false)}
          netPosition={finding.netPosition}
          documents={documentInfo ?? {}}
          busy={netPositionBusy}
          stale={stale}
          onConfirm={onConfirmNetPosition}
          onAmend={onAmendNetPosition}
        />
      )}
    </div>
  );
}
