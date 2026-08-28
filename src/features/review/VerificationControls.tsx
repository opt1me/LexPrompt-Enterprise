import React, { useState } from 'react';
import { CheckCircle2, Flag, XCircle, RotateCcw } from 'lucide-react';
import type { Verification } from '../../types';
import type { VerificationChange } from '../../lib/verification';
import { RejectReasonModal } from './RejectReasonModal';

export interface VerificationControlsProps {
  verification: Verification;
  /** True while a verification write for this finding is in flight. Every
   *  action is disabled: the UI must not offer a second state change before
   *  the first is known to have persisted (spec section 9). */
  busy?: boolean;
  onChange: (change: VerificationChange) => void;
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
export function VerificationControls({ verification, busy = false, onChange }: VerificationControlsProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const active = verification.state;

  return (
    <>
      <div className="bg-card border-t border-rule pt-3 space-y-1.5">
        <div className="font-mono text-label uppercase text-ink-4">Disposition</div>
        {/* No `role="status"` here (R-GP2 — that role is StateChip's alone);
           the busy signal is the disabled buttons plus this data hook. */}
        <div className="flex flex-wrap gap-1.5" data-busy={busy || undefined} aria-live="polite">
          <button
            type="button"
            disabled={busy}
            onClick={() => onChange({ state: 'verified' })}
            className={`${ACTION} ${active === 'verified' ? 'bg-accent text-page border-accent' : 'border-accent-edge text-accent hover:bg-accent-tint'}`}
          >
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Verify
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onChange({ state: 'flagged' })}
            className={`${ACTION} ${active === 'flagged' ? 'bg-risk-med text-page border-risk-med' : 'border-risk-med-edge text-risk-med hover:bg-risk-med-tint'}`}
          >
            <Flag className="w-3 h-3" aria-hidden="true" /> Flag
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRejectOpen(true)}
            className={`${ACTION} ${active === 'rejected' ? 'bg-risk-high text-page border-risk-high' : 'border-risk-high-edge text-risk-high hover:bg-risk-high-tint'}`}
          >
            <XCircle className="w-3 h-3" aria-hidden="true" /> Reject
          </button>
          {active !== 'unchecked' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChange({ state: 'unchecked' })}
              className={`${ACTION} bg-transparent text-ink-4 border-transparent hover:text-ink-2`}
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </div>

      <RejectReasonModal
        open={rejectOpen}
        initialReason={verification.state === 'rejected' ? verification.reason ?? '' : ''}
        onCancel={() => setRejectOpen(false)}
        onConfirm={(reason) => {
          setRejectOpen(false);
          onChange({ state: 'rejected', reason });
        }}
      />
    </>
  );
}
