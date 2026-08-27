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

const ACTION = 'text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1';

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
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ state: 'verified' })}
          className={`${ACTION} ${active === 'verified' ? 'bg-emerald-500/25 text-emerald-200 border-emerald-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-emerald-300'}`}
        >
          <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Verify
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ state: 'flagged' })}
          className={`${ACTION} ${active === 'flagged' ? 'bg-amber-500/25 text-amber-200 border-amber-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-amber-300'}`}
        >
          <Flag className="w-3 h-3" aria-hidden="true" /> Flag
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRejectOpen(true)}
          className={`${ACTION} ${active === 'rejected' ? 'bg-red-500/25 text-red-200 border-red-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-red-300'}`}
        >
          <XCircle className="w-3 h-3" aria-hidden="true" /> Reject
        </button>
        {active !== 'unchecked' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onChange({ state: 'unchecked' })}
            className={`${ACTION} bg-transparent text-gray-500 border-transparent hover:text-gray-300`}
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Clear
          </button>
        )}
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
