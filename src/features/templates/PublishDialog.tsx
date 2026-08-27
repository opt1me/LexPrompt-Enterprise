import React, { useState } from 'react';
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

  const summaryRequired = nextVersion > 1;

  const handlePublish = async () => {
    if (busy) return;
    if (summaryRequired && changeSummary.trim() === '') {
      setRefusal(`Say what changed in v${nextVersion} before publishing it — a version history that does not is a list of dates.`);
      return;
    }
    setRefusal(null);
    await onPublish(changeSummary.trim());
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
      <p className="text-xs text-gray-400 leading-relaxed">
        Publishing freezes these clauses and prompts as v{nextVersion}. It cannot be edited
        afterwards — later edits become v{nextVersion + 1} — and every review from now on records
        that it ran against v{nextVersion}.
      </p>
      <div>
        <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">
          Change summary {summaryRequired ? '(required)' : '(optional for v1)'}
        </label>
        <AutoResizeTextarea
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
          aria-label="Change summary"
          placeholder="e.g. Tightened the break-notice position and added a rent-review clause."
          className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 min-h-[80px]"
        />
      </div>
      {refusal && (
        <p role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          {refusal}
        </p>
      )}
    </Modal>
  );
}
