import React, { useEffect, useState } from 'react';
import { CheckCircle2, PencilLine, History, ShieldQuestion } from 'lucide-react';
import type { NetPosition } from '../../types';
import { positionText } from '@lexprompt/core';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { STALE_CONTROL_NOTICE } from '../../lib/loadError';
import { actorPhrase, type DispositionAudience } from '../../lib/findingOutcome';

export interface NetPositionPanelProps {
  /** Absent for a standalone-document finding, or a collection finding that
   *  hasn't produced one yet. Rendered as nothing at all — see the doc
   *  comment on the component below. */
  netPosition: NetPosition | undefined;
  /** True while a write for this net position is in flight. Every action is
   *  disabled, exactly as `VerificationControls` does for a verification. */
  busy?: boolean;
  /** §3's fourth load state. A net-position confirmation is the most
   *  dangerous human write in the app -- it accepts synthesised text no
   *  document contains -- so it goes dead with the rest. */
  stale?: boolean;
  /** Reports the human's intent to accept the model's synthesis as written.
   *  Optional, same reasoning as `FindingCard`'s `onVerify`: a panel with no
   *  way to persist (a preview) shows the position and its state but no
   *  controls, rather than a button that goes nowhere. */
  onConfirm?: () => void;
  /** Reports the human's rewritten text. */
  onAmend?: (text: string) => void;
  /** Opens the full derivation trail. Omitted when this panel is itself
   *  being rendered as the terminal card INSIDE that trail (see
   *  `VariationTrailModal`) — otherwise its own "see trail" button would
   *  try to reopen the trail it is already inside. */
  onOpenTrail?: () => void;
  /**
   * How this panel turns `netPosition.byUserId` into a name — M1.
   *
   * Optional on the same terms as every other audience prop in this app
   * (`AssigneeChip`, `PresenceRoster`, `AskedOfYou`): a caller with no
   * directory in hand gets a sentence saying no name is available, never an
   * invented one and never a raw uuid.
   */
  audience?: DispositionAudience;
}

function formatWhen(at: number | undefined): string {
  return typeof at === 'number' ? new Date(at).toLocaleString() : 'an unknown time';
}

const BADGE = 'font-mono text-chip px-2 py-0.5 rounded-chip uppercase border inline-flex items-center gap-1 shrink-0';

/**
 * The state badge, always rendered — there is no "no chip" state, for the
 * same reason `StateChip` has none: an absent badge would read as settled,
 * and an unconfirmed net position must say so with no interaction required.
 *
 * An amendment is a STRONGER claim than a confirmation, not a weaker one — a
 * person rewrote the text — so it gets its own, more emphatic badge rather
 * than reusing "Confirmed".
 */
function PositionBadge({ netPosition }: { netPosition: NetPosition }) {
  if (netPosition.state !== 'confirmed') {
    return (
      <span role="status" className={`${BADGE} bg-risk-med-tint text-risk-med border-risk-med-edge`}>
        <ShieldQuestion className="w-3 h-3" aria-hidden="true" /> Unconfirmed
      </span>
    );
  }
  if (netPosition.amended) {
    return (
      <span role="status" className={`${BADGE} bg-accent-tint text-accent border-accent-edge`}>
        <PencilLine className="w-3 h-3" aria-hidden="true" /> Amended
      </span>
    );
  }
  return (
    <span role="status" className={`${BADGE} bg-accent-tint text-accent border-accent-edge`}>
      <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Confirmed
    </span>
  );
}

/**
 * The dialog for rewriting a net position outright, mirroring
 * `RejectReasonModal`'s shape exactly rather than inventing a second dialog
 * idiom: a `Modal` wrapping one textarea, Confirm disabled until there is
 * non-whitespace text. The rule is enforced here as well as in
 * `amendPosition` (which throws on an empty amendment) because a disabled
 * button explains itself and a thrown error does not.
 */
function AmendPositionModal({ open, initialText, onCancel, onConfirm }: {
  open: boolean;
  initialText: string;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState(initialText);

  // Reopening for a different finding — or reopening this one after the
  // proposal changed — must not inherit stale text.
  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);

  const trimmed = text.trim();

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      title="Amend this position"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onConfirm(trimmed)} disabled={trimmed === ''}>
            Confirm amendment
          </Button>
        </>
      }
    >
      <p className="font-ui text-ui-sm text-ink-3 leading-relaxed">
        Rewrite what the documents, read together, actually say. This replaces the model&apos;s
        proposal as the position shown here, and is recorded as written by a person — a stronger
        claim than simply confirming the model&apos;s text.
      </p>
      <AutoResizeTextarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What the documents say, read in order"
        className="w-full p-2"
      />
    </Modal>
  );
}

/**
 * What the documents, read in order, say now about a clause — the most
 * dangerous output this app produces (see `netPosition.ts`), so it is never
 * shown as settled until a human has looked at it.
 *
 * Absence means the question did not arise (a standalone-document review, or
 * a collection clause the run hasn't reached yet): rendering nothing at all
 * is deliberate — an empty panel would read as "we tried and found nothing",
 * which is a different, false claim.
 */
/**
 * The audience this panel falls back to when its caller hands it none — the
 * same object `FindingCard` keeps for the same reason, and it names NOBODY.
 * Honest rather than helpful: `actorPhrase` turns an unresolvable id into
 * "someone this workspace does not name", which is true of every actor when
 * nothing has been given a directory, and is never a name somebody did not
 * have.
 */
const NO_DIRECTORY: DispositionAudience = {
  nameOf: () => undefined,
  initialsOf: () => undefined,
  timeOf: (at: number) => new Date(at).toLocaleString(),
};

export function NetPositionPanel({
  netPosition, busy = false, stale = false, onConfirm, onAmend, onOpenTrail, audience,
}: NetPositionPanelProps) {
  const [amendOpen, setAmendOpen] = useState(false);

  if (!netPosition) return null;

  const text = positionText(netPosition);
  const hasTrail = netPosition.trail.length > 0;
  // A net position must not read as settled until a human confirms it (the
  // most dangerous output this app produces — see `netPosition.ts`):
  // unconfirmed stays visibly provisional, dashed and amber-tinted, never
  // the plain card fill a confirmed one gets.
  const shellClass = netPosition.state === 'confirmed'
    ? 'bg-card border border-net-confirmed'
    : 'bg-risk-med-tint border border-dashed border-net-unconfirmed';

  return (
    <div className={`space-y-2 p-3 rounded-control ${shellClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-label uppercase text-ink-4">Net position</span>
        <PositionBadge netPosition={netPosition} />
      </div>

      <p className="font-prose text-finding text-ink-prose leading-relaxed whitespace-pre-wrap">{text}</p>

      {/* THE PERSON, NEVER "you", AND NEVER A RAW UUID.

          Both halves of that were learned the hard way and neither may be
          dropped. Driving the real app once found "Confirmed by
          vzcsj71fs7mtalycwr" at a reader, so an id is never printed. The fix
          for that was " by you" for ANY author, justified by ruling R1 — this
          app is single-user, so the one local profile that could have
          confirmed a position always is it. R1 is superseded (Stages 4 and 5,
          `rulings.md`: "R-G1 / R1 - fully discharged"): a matter is shared,
          `PUT …/net-position` stamps `req.actor!.id`, and a partner's
          confirmation carries the PARTNER's id. A trainee opening that review
          read "Confirmed by you on 27 Aug 16:04" over something they had
          never seen — a false first-person claim about the most dangerous
          output this app produces, on the surface `CLAUDE.md`'s "never shown
          without its actor and its time" rule was written for.

          `actorPhrase` is the same resolver `dispositionLabel` uses one panel
          over, so the confirmation line and the verification line beside it
          name a person the same way or say the same thing about not being
          able to. */}
      {netPosition.state === 'confirmed' && (
        <p className="font-mono text-pin text-ink-4">
          {netPosition.amended ? 'Amended' : 'Confirmed'} by{' '}
          {actorPhrase(netPosition.byUserId, audience ?? NO_DIRECTORY)} on {formatWhen(netPosition.at)}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        {netPosition.state === 'unconfirmed' && onConfirm && (
          <Button variant="ghost" disabled={busy || stale} onClick={onConfirm} className="text-button py-1 px-2.5">
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Confirm
          </Button>
        )}
        {onAmend && (
          <Button variant="ghost" disabled={busy || stale} onClick={() => setAmendOpen(true)} className="text-button py-1 px-2.5">
            <PencilLine className="w-3 h-3" aria-hidden="true" /> Amend
          </Button>
        )}
        {onOpenTrail && hasTrail && (
          // NOT disabled while stale, and that is the line worth pausing on:
          // opening the trail is a READ. §3's rule is about human-authored
          // WRITES — a disposition, a note, a net-position confirmation, an
          // assignment — and disabling a read as well would take a reader's
          // ability to understand what they are looking at away at exactly
          // the moment the screen stopped explaining itself.
          <Button variant="ghost" disabled={busy} onClick={onOpenTrail} className="text-button py-1 px-2.5">
            <History className="w-3 h-3" aria-hidden="true" /> See the variation trail
          </Button>
        )}
      </div>
      {stale && (
        <p className="font-ui text-ui-sm text-risk-med leading-relaxed">
          {STALE_CONTROL_NOTICE}
        </p>
      )}

      {onAmend && (
        <AmendPositionModal
          open={amendOpen}
          initialText={text}
          onCancel={() => setAmendOpen(false)}
          onConfirm={(newText) => { setAmendOpen(false); onAmend(newText); }}
        />
      )}
    </div>
  );
}
