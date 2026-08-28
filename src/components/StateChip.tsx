import React from 'react';
import { CircleDashed, CheckCircle2, Flag, XCircle } from 'lucide-react';
import type { Verification, VerificationState } from '../types';

const CHIP: Record<VerificationState, { label: string; classes: string; Icon: typeof CircleDashed }> = {
  // "Unverified" rather than "Unchecked": the chip is read by someone
  // deciding whether to rely on the finding, and "unverified AI output" is
  // the phrase the export uses. The two must say the same thing.
  unchecked: { label: 'Unverified', classes: 'bg-chip-fill text-state-unchecked border-rule', Icon: CircleDashed },
  verified: { label: 'Verified', classes: 'bg-accent-tint text-state-verified border-accent-edge', Icon: CheckCircle2 },
  flagged: { label: 'Flagged', classes: 'bg-risk-med-tint text-state-flagged border-risk-med-edge', Icon: Flag },
  rejected: { label: 'Rejected', classes: 'bg-risk-high-tint text-state-rejected border-risk-high-edge', Icon: XCircle },
};

/**
 * What a *human* concluded about this finding. Always rendered — there is no
 * "no chip" state, because an absent chip would read as "fine", and the
 * whole point of this sub-project is that an unchecked finding says so.
 *
 * Its counterpart is `RiskChip`, which shows the model's risk level. They
 * are separate components on purpose (spec Scope item 5).
 */
export function StateChip({ verification }: { verification: Verification }) {
  const { label, classes, Icon } = CHIP[verification.state] ?? CHIP.unchecked;
  const title = verification.state === 'rejected' && verification.reason
    ? `Rejected: ${verification.reason}`
    : label;

  return (
    <span
      role="status"
      title={title}
      className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border inline-flex items-center gap-1 ${classes}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
  );
}
