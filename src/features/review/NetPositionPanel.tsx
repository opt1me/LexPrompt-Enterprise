import React, { useEffect, useState } from 'react';
import { CheckCircle2, PencilLine, History, ShieldQuestion } from 'lucide-react';
import type { NetPosition } from '../../types';
import { positionText } from '../../lib/netPosition';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface NetPositionPanelProps {
  /** Absent for a standalone-document finding, or a collection finding that
   *  hasn't produced one yet. Rendered as nothing at all — see the doc
   *  comment on the component below. */
  netPosition: NetPosition | undefined;
  /** True while a write for this net position is in flight. Every action is
   *  disabled, exactly as `VerificationControls` does for a verification. */
  busy?: boolean;
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
}

function formatWhen(at: number | undefined): string {
  return typeof at === 'number' ? new Date(at).toLocaleString() : 'an unknown time';
}

const BADGE = 'text-[10px] px-2 py-0.5 rounded-full uppercase font-bold border inline-flex items-center gap-1 shrink-0';

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
      <span role="status" className={`${BADGE} bg-amber-500/15 text-amber-300 border-amber-500/20`}>
        <ShieldQuestion className="w-3 h-3" aria-hidden="true" /> Unconfirmed
      </span>
    );
  }
  if (netPosition.amended) {
    return (
      <span role="status" className={`${BADGE} bg-violet-500/20 text-violet-200 border-violet-500/30`}>
        <PencilLine className="w-3 h-3" aria-hidden="true" /> Amended
      </span>
    );
  }
  return (
    <span role="status" className={`${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/20`}>
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
      <p className="text-xs text-gray-400 leading-relaxed">
        Rewrite what the documents, read together, actually say. This replaces the model&apos;s
        proposal as the position shown here, and is recorded as written by a person — a stronger
        claim than simply confirming the model&apos;s text.
      </p>
      <AutoResizeTextarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What the documents say, read in order"
        className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-sm text-white outline-none"
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
export function NetPositionPanel({ netPosition, busy = false, onConfirm, onAmend, onOpenTrail }: NetPositionPanelProps) {
  const [amendOpen, setAmendOpen] = useState(false);

  if (!netPosition) return null;

  const text = positionText(netPosition);
  const hasTrail = netPosition.trail.length > 0;

  return (
    <div className="space-y-2 p-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold text-violet-300 uppercase tracking-wide">Net position</span>
        <PositionBadge netPosition={netPosition} />
      </div>

      <p className="text-xs text-gray-200 leading-relaxed whitespace-pre-wrap">{text}</p>

      {netPosition.state === 'confirmed' && (
        <p className="text-[10px] text-gray-500">
          {netPosition.amended ? 'Amended' : 'Confirmed'} by {netPosition.byUserId ?? 'an unknown user'} on{' '}
          {formatWhen(netPosition.at)}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        {netPosition.state === 'unconfirmed' && onConfirm && (
          <Button variant="ghost" disabled={busy} onClick={onConfirm} className="text-[11px] py-1 px-2.5">
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Confirm
          </Button>
        )}
        {onAmend && (
          <Button variant="ghost" disabled={busy} onClick={() => setAmendOpen(true)} className="text-[11px] py-1 px-2.5">
            <PencilLine className="w-3 h-3" aria-hidden="true" /> Amend
          </Button>
        )}
        {onOpenTrail && hasTrail && (
          <Button variant="ghost" disabled={busy} onClick={onOpenTrail} className="text-[11px] py-1 px-2.5">
            <History className="w-3 h-3" aria-hidden="true" /> See the variation trail
          </Button>
        )}
      </div>

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
