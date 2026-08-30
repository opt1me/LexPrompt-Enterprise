import React, { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Note } from '../../types';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { STALE_CONTROL_NOTICE } from '../../lib/loadError';

export interface NotesPanelProps {
  notes: Note[];
  /** The local profile's initials, shown against a note the user is about to
   *  write. Attribution is real but local — there is one user (ruling R1). */
  authorInitials: string;
  /** The local profile's id. A note whose `byUserId` is this one reads
   *  "You"; any other note reads with no actor at all — never the local
   *  profile's name or initials borrowed for someone else's record. The
   *  same comparison `matterActivity` makes (`note.byUserId ===
   *  localUserId`), stated once per component but never differently: this
   *  panel used to assert "You ·" beside the local initials for every note
   *  it was handed, without consulting the field that records who wrote
   *  it, while the activity list two components away read the same data
   *  correctly. */
  localUserId: string;
  busy?: boolean;
  /** §3 lists a NOTE among the human-authored writes a stale client must not
   *  offer -- "not for a disposition change, a note, a net-position
   *  confirmation, or an assignment". One flag, one sentence, all four. */
  stale?: boolean;
  onAddNote: (text: string) => void;
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * Free-text notes against one finding. A verification state says *whether* a
 * reviewer accepted a finding; a note says *what they thought* — the caveat,
 * the cross-reference, the thing to ask the client. Both persist with the
 * review, so a reviewer returning to a matter reads their own reasoning
 * rather than reconstructing it.
 *
 * Ordered oldest-first, deliberately: notes read as a thread, and a thread
 * that starts at the end is unreadable.
 */
export function NotesPanel({
  notes, authorInitials, localUserId, busy = false, stale = false, onAddNote,
}: NotesPanelProps) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();

  const ordered = [...notes].sort((a, b) => a.at - b.at);

  return (
    <div className="space-y-2 pt-2 bg-card border border-rule rounded-card p-2.5">
      {ordered.length > 0 && (
        <ul className="space-y-1.5">
          {ordered.map(note => {
            // R-GP5: this app has no store of any name but the local
            // profile's, so a note this profile wrote shows its initials
            // and reads "You". A note it did not write shows neither — no
            // avatar, no actor, just when it was written. The alternative
            // is what this component used to do: print the CURRENT
            // profile's initials and "You ·" against a record that says
            // someone else wrote it, which is exactly the invented
            // attribution R-GP5 forbids, in the one part of a review a
            // reader takes for the human's own words.
            const byYou = note.byUserId === localUserId;
            return (
              <li key={note.id} className="flex items-start gap-2 bg-chip-fill rounded-inset p-2 border border-rule">
                {byYou && (
                  <span
                    className="shrink-0 w-[22px] h-[22px] rounded-meter bg-accent text-page font-ui text-meta flex items-center justify-center"
                    aria-hidden="true"
                  >
                    {authorInitials}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p data-testid="note-text" className="font-ui text-ui text-ink-2 leading-relaxed whitespace-pre-wrap">
                    {note.text}
                  </p>
                  <span data-testid="note-meta" className="mt-1 block font-mono text-pin text-ink-4">
                    {byYou ? `You · ${formatWhen(note.at)}` : formatWhen(note.at)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <AutoResizeTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note as ${authorInitials}`}
          className="flex-1 bg-card border border-rule-strong rounded-control p-2 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
        />
        <Button
          variant="ghost"
          disabled={busy || stale || trimmed === ''}
          onClick={() => { onAddNote(trimmed); setDraft(''); }}
          className="text-[10px] shrink-0"
        >
          <MessageSquarePlus className="w-3 h-3" aria-hidden="true" /> Add note
        </Button>
      </div>
      {stale && (
        <p className="font-ui text-ui-sm text-risk-med leading-relaxed">
          {STALE_CONTROL_NOTICE}
        </p>
      )}
    </div>
  );
}
