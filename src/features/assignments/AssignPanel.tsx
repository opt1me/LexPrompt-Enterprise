import React, { useState } from 'react';
import type { AssignmentView } from '@lexprompt/core';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { createAssignment } from '../../lib/api/assignments';
import { directoryLoaded, workspaceUsers } from '../../lib/api/users';

export interface AssignPanelProps {
  open: boolean;
  reviewId: string;
  findingsKey: string;
  clauseId: string;
  /** The clause's own title, so the dialog says which clause is being handed
   *  over rather than making the reader remember. */
  clauseTitle: string;
  /** This browser's own user id, left out of the list of people to ask. */
  meId?: string;
  onClose: () => void;
  /** The request that was actually written, as the server returned it. */
  onAssigned: (assignment: AssignmentView) => void;
  /** The client cannot vouch for what is on screen (§3's fourth load state).
   *  An assignment is a human-authored write and §3 names it explicitly, so
   *  it goes dead here exactly as a disposition does. */
  stale?: boolean;
}

/**
 * *"WOULD YOU LOOK AT THIS?"* (§6.3, S17, Task 25).
 *
 * The owner's own sentence: *"a trainee may verify one clause and be happy,
 * then flag another for a Partner's view."*
 *
 * ## Flagging and assigning are TWO ACTS, deliberately two clicks
 *
 * Flagging records a judgement about the answer; assigning asks a person to
 * look. Doing both in one click would write a disposition the person may not
 * have meant, and §6.3 keeps the acts apart on purpose. They are reachable
 * from the same place, because they are one intention — and recorded as two
 * facts, because they are two.
 *
 * ## It never assigns without an assignee, and says which field is missing
 *
 * The submit button is disabled with no assignee AND the panel says why —
 * a greyed-out control with no sentence is a dead end a person has to guess
 * their way out of. The server refuses the same thing with the same field
 * name, because a gate whose only enforcement is a disabled attribute is a
 * suggestion.
 *
 * ## The message is optional, and encouraged
 *
 * A bare marker makes the assignee open every clause to find out what was
 * wanted. The placeholder is the ask, not a label.
 */
export function AssignPanel({
  open, reviewId, findingsKey, clauseId, clauseTitle, meId, onClose, onAssigned, stale = false,
}: AssignPanelProps) {
  const [assignee, setAssignee] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NEVER YOURSELF. Asking yourself to look at something is a note, and the
  // app already has notes.
  const candidates = workspaceUsers().filter(u => u.id !== meId && u.status !== 'disabled');

  const submit = async () => {
    if (!assignee) {
      setError('Choose the person you want to look at this clause.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const written = await createAssignment(
        reviewId, findingsKey, clauseId, assignee,
        message.trim() === '' ? undefined : message.trim());
      // AWAIT-THEN-APPLY, like every other human-authored write in this app:
      // the caller is handed the row the store actually took, never the one
      // this panel composed.
      onAssigned(written);
      setAssignee('');
      setMessage('');
      onClose();
    } catch (e) {
      // SAID, not swallowed. A request that silently failed is a colleague
      // who is never asked and an assigner who believes they did ask.
      setError(e instanceof Error
        ? `That request was not sent: ${e.message}`
        : 'That request was not sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      title="Ask a colleague to look at this"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => { void submit(); }}
            loading={busy}
            disabled={busy || stale || assignee === ''}
          >
            Send the request
          </Button>
        </>
      )}
    >
      <p className="font-ui text-ui-sm text-ink-3">
        {`This asks somebody to look at "${clauseTitle}". It records no judgement about the `}
        clause and changes nothing on the card — deciding it is still theirs, or yours.
      </p>

      {stale && (
        <p className="font-ui text-ui-sm text-risk-high" role="status">
          LexPrompt cannot reach the server, so it cannot send this request. Nothing was sent.
        </p>
      )}

      <label className="block">
        <span className="block font-mono text-chip uppercase text-ink-4 mb-1">Who</span>
        {directoryLoaded() ? (
          <select
            value={assignee}
            onChange={e => { setAssignee(e.target.value); setError(null); }}
            disabled={busy || stale}
            aria-label="Who should look at this"
            className="w-full bg-card border border-rule-strong rounded-control px-2 py-1.5 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Choose somebody…</option>
            {candidates.map(u => (
              <option key={u.id} value={u.id}>{u.displayName}</option>
            ))}
          </select>
        ) : (
          // "The directory did not load" and "this firm has one person" are
          // different facts, and only the first is a failure. A picker with
          // an empty menu says neither.
          <span className="font-ui text-ui-sm text-risk-high">
            LexPrompt could not read the list of people in your workspace, so it cannot offer
            anybody to ask. Reload the review and try again.
          </span>
        )}
      </label>

      <label className="block">
        <span className="block font-mono text-chip uppercase text-ink-4 mb-1">
          What you want them to look at
        </span>
        <AutoResizeTextarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          disabled={busy || stale}
          aria-label="What you want them to look at"
          placeholder="Not sure the cap survives 14.2."
          className="w-full bg-card border border-rule-strong rounded-control px-2 py-1.5 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
        />
      </label>

      {error && (
        <p className="font-ui text-ui-sm text-risk-high" role="alert">{error}</p>
      )}
    </Modal>
  );
}
