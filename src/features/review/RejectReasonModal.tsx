import React, { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface RejectReasonModalProps {
  open: boolean;
  initialReason?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * A rejection is the one verification state that cannot be set silently.
 * `applyVerification` throws without a reason, and this is where the reason
 * is collected — so the throw is a backstop, never the user's experience of
 * the rule.
 *
 * Confirm stays disabled until there is non-whitespace text. The rule is
 * enforced here as well as in the state machine because a disabled button
 * explains itself and a thrown error does not.
 */
export function RejectReasonModal({ open, initialReason = '', onCancel, onConfirm }: RejectReasonModalProps) {
  const [reason, setReason] = useState(initialReason);

  // Reopening the dialog for a different finding must not inherit the last
  // one's text — a reason attached to the wrong rejection is worse than a
  // blank box.
  useEffect(() => {
    if (open) setReason(initialReason);
  }, [open, initialReason]);

  const trimmed = reason.trim();

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      title="Reject this finding"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(trimmed)} disabled={trimmed === ''}>
            Confirm rejection
          </Button>
        </>
      }
    >
      <p className="font-ui text-ui-sm text-ink-3 leading-relaxed">
        A rejected finding is still exported, with this reason attached. Say what is wrong with it
        so whoever reads the report knows why it was not relied on.
      </p>
      <AutoResizeTextarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Cites the indemnity, not the liability cap"
        className="w-full p-2"
      />
    </Modal>
  );
}
