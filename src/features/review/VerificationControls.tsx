import React, { useState } from 'react';
import { CheckCircle2, Flag, XCircle, RotateCcw } from 'lucide-react';
import type { Verification } from '../../types';
import type { VerificationChange } from '@lexprompt/core';
import { RejectReasonModal } from './RejectReasonModal';
import { STALE_CONTROL_NOTICE } from '../../lib/loadError';

export interface VerificationControlsProps {
  verification: Verification;
  /** True while a verification write for this finding is in flight. Every
   *  action is disabled: the UI must not offer a second state change before
   *  the first is known to have persisted (spec section 9). */
  busy?: boolean;
  /**
   * The client cannot vouch for what is on screen (§3's fourth load state,
   * Task 20).
   *
   * SEPARATE FROM `busy`, and the two say different sentences. `busy` means
   * YOUR write is in flight and will land; `stale` means a change submitted
   * against a version that may be minutes old WOULD BE REFUSED ANYWAY (§8).
   * Rendering them identically would tell a reviewer to wait for something
   * that is not coming.
   *
   * DISABLED, never hidden: a hidden control is indistinguishable from a
   * finding that cannot be verified, which is the `isVerifiable` case and
   * already hides them. Disabled-with-a-reason is the only rendering that
   * says "you may do this, but not right now, and here is why."
   */
  stale?: boolean;
  onChange: (change: VerificationChange) => void;
  /**
   * Reports whether the reject-reason dialog this owns is open (P36).
   *
   * The dialog's state stays HERE — it is this component's own control and
   * lifting it would put a modal's open flag three levels up from the button
   * that opens it. What the card above needs is not the state but the FACT,
   * because a disposition arriving from somebody else must not be applied
   * under an open dialogue, and the card is what renders the disposition.
   *
   * Optional: a caller with no interest in the fact passes nothing and
   * behaves exactly as before.
   */
  onRejectOpenChange?: (open: boolean) => void;
}

const ACTION = 'font-ui text-ui-sm px-2.5 py-1 rounded-control border transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1';

/**
 * The human's four moves on a finding: verify, flag, reject-with-reason, and
 * clear back to unchecked.
 *
 * Purely presentational — it reports intent and never builds a
 * `Verification` or writes anything. Persisting is Task 10's job in
 * `App.tsx`, because that is where a failed write can be surfaced, and a
 * verification that displays without persisting is the single worst failure
 * this feature can have.
 */
export function VerificationControls({
  verification, busy = false, stale = false, onChange, onRejectOpenChange,
}: VerificationControlsProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const active = verification.state;

  // Reported on the way through rather than from an effect: an effect would
  // fire a frame after the dialog opened, and the frame in between is
  // exactly when an incoming change would be applied under it.
  const setReject = (open: boolean): void => {
    setRejectOpen(open);
    onRejectOpenChange?.(open);
  };

  return (
    <>
      <div className="bg-card border-t border-rule pt-3 space-y-1.5">
        <div className="font-mono text-label uppercase text-ink-4">Disposition</div>
        {/* No `role="status"` here (R-GP2 — that role is StateChip's alone);
           the busy signal is the disabled buttons plus this data hook. */}
        <div className="flex flex-wrap gap-1.5" data-busy={busy || undefined} aria-live="polite">
          <button
            type="button"
            disabled={busy || stale}
            onClick={() => onChange({ state: 'verified' })}
            className={`${ACTION} ${active === 'verified' ? 'bg-accent text-page border-accent' : 'border-accent-edge text-accent hover:bg-accent-tint'}`}
          >
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Verify
          </button>
          <button
            type="button"
            disabled={busy || stale}
            onClick={() => onChange({ state: 'flagged' })}
            className={`${ACTION} ${active === 'flagged' ? 'bg-risk-med text-page border-risk-med' : 'border-risk-med-edge text-risk-med hover:bg-risk-med-tint'}`}
          >
            <Flag className="w-3 h-3" aria-hidden="true" /> Flag
          </button>
          <button
            type="button"
            disabled={busy || stale}
            onClick={() => setReject(true)}
            className={`${ACTION} ${active === 'rejected' ? 'bg-risk-high text-page border-risk-high' : 'border-risk-high-edge text-risk-high hover:bg-risk-high-tint'}`}
          >
            <XCircle className="w-3 h-3" aria-hidden="true" /> Reject
          </button>
          {active !== 'unchecked' && (
            <button
              type="button"
              disabled={busy || stale}
              onClick={() => onChange({ state: 'unchecked' })}
              className={`${ACTION} bg-transparent text-ink-4 border-transparent hover:text-ink-2`}
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" /> Clear
            </button>
          )}
        </div>
        {stale && (
          /* The REASON, beside the dead controls. A greyed-out button with no
             sentence is a control a reviewer presses twice and then reports
             as broken — and the sentence has to say what is wrong with the
             SAVE, not with the connection, or it reads as "try again in a
             moment", which is the one instruction that is not true here. */
          <p className="font-ui text-ui-sm text-risk-med leading-relaxed">
            {STALE_CONTROL_NOTICE}
          </p>
        )}
      </div>

      <RejectReasonModal
        open={rejectOpen}
        initialReason={verification.state === 'rejected' ? verification.reason ?? '' : ''}
        onCancel={() => setReject(false)}
        onConfirm={(reason) => {
          setReject(false);
          onChange({ state: 'rejected', reason });
        }}
      />
    </>
  );
}
