import React, { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface PublishDialogProps {
  /** Shown in the header ("Publish v2") and used for the summary rule: a
   *  change summary is required for every version after the first. */
  nextVersion: number;
  onPublish: (changeSummary: string) => Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * Publishing freezes the draft into an immutable version. The change summary
 * is required from v2 onwards because a version history whose entries do not
 * say what changed is a list of dates — the store enforces the same rule
 * (`publishVersionIn` throws on it), and this is where the author is asked
 * for it rather than being sent to a toast after the fact.
 *
 * The refusal is stated, never silent: a Publish button that declines and
 * says nothing is indistinguishable from one that is broken.
 */
export function PublishDialog({ nextVersion, onPublish, onCancel, busy }: PublishDialogProps) {
  const [changeSummary, setChangeSummary] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A REF, not state: two clicks in one tick both read the same render's
   *  state, so only something written synchronously can refuse the second.
   *  `busy` cannot do this job — it is a prop, so it is still false for the
   *  whole tick in which both clicks land, and `Button` already refuses a
   *  click once it has arrived. A guard on `busy` here therefore covered
   *  nothing, which is why it is gone. */
  const inFlight = useRef(false);

  const summaryRequired = nextVersion > 1;

  const handlePublish = async () => {
    if (inFlight.current) return;
    if (summaryRequired && changeSummary.trim() === '') {
      setRefusal(`Say what changed in v${nextVersion} before publishing it — a version history that does not is a list of dates.`);
      return;
    }
    setRefusal(null);
    inFlight.current = true;
    try {
      await onPublish(changeSummary.trim());
    } catch (e) {
      // Today's caller reports its own failures and never rejects, so this
      // is latent — but a caller that does reject would otherwise leave an
      // unhandled rejection and a dialog stuck in flight with no way to try
      // again. Stated in the dialog rather than swallowed: a publish that
      // failed silently is indistinguishable from one that worked.
      setRefusal(e instanceof Error ? e.message : 'The publish failed. Try again.');
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Modal
      isOpen
      title={`Publish v${nextVersion}`}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={handlePublish} loading={busy}>
            {!busy && <UploadCloud className="h-4 w-4" aria-hidden="true" />} Publish v{nextVersion}
          </Button>
        </>
      }
    >
      <p className="font-ui text-ui text-ink-3 leading-relaxed">
        Publishing freezes these clauses and prompts as v{nextVersion}. It cannot be edited
        afterwards — later edits become v{nextVersion + 1} — and every review from now on records
        that it ran against v{nextVersion}.
      </p>
      <div>
        <label className="block font-mono text-chip uppercase text-ink-4 mb-1">
          Change summary {summaryRequired ? '(required)' : '(optional for v1)'}
        </label>
        <AutoResizeTextarea
          value={changeSummary}
          onChange={(e) => {
            setChangeSummary(e.target.value);
            // The refusal describes an empty box. Leaving it up beside a
            // filled one reports a problem the author has already fixed.
            if (refusal) setRefusal(null);
          }}
          aria-label="Change summary"
          placeholder="e.g. Tightened the break-notice position and added a rent-review clause."
          className="w-full bg-card border border-rule-strong rounded-control p-3 text-ink-prose font-prose text-field outline-none focus:border-accent min-h-[80px]"
        />
      </div>
      {refusal && (
        <p role="alert" className="font-ui text-ui text-risk-high bg-risk-high-tint border border-risk-high-edge rounded-card p-3">
          {refusal}
        </p>
      )}
    </Modal>
  );
}
