import React, { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Note } from '../../types';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface NotesPanelProps {
  notes: Note[];
  /** The local profile's initials, shown against a note the user is about to
   *  write. Attribution is real but local — there is one user (ruling R1). */
  authorInitials: string;
  busy?: boolean;
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
export function NotesPanel({ notes, authorInitials, busy = false, onAddNote }: NotesPanelProps) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();

  const ordered = [...notes].sort((a, b) => a.at - b.at);

  return (
    <div className="space-y-2 pt-2 bg-card border border-rule rounded-card p-2.5">
      {ordered.length > 0 && (
        <ul className="space-y-1.5">
          {ordered.map(note => (
            <li key={note.id} className="flex items-start gap-2 bg-chip-fill rounded-inset p-2 border border-rule">
              {/* R-GP5: this app has no store of any name but the local
                 profile's, so a note's avatar and attribution are always
                 the local profile's — never an invented one. */}
              <span
                className="shrink-0 w-[22px] h-[22px] rounded-meter bg-accent text-page font-ui text-meta flex items-center justify-center"
                aria-hidden="true"
              >
                {authorInitials}
              </span>
              <div className="min-w-0 flex-1">
                <p data-testid="note-text" className="font-ui text-ui text-ink-2 leading-relaxed whitespace-pre-wrap">
                  {note.text}
                </p>
                <span data-testid="note-meta" className="mt-1 block font-mono text-pin text-ink-4">
                  You · {formatWhen(note.at)}
                </span>
              </div>
            </li>
          ))}
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
          disabled={busy || trimmed === ''}
          onClick={() => { onAddNote(trimmed); setDraft(''); }}
          className="text-[10px] shrink-0"
        >
          <MessageSquarePlus className="w-3 h-3" aria-hidden="true" /> Add note
        </Button>
      </div>
    </div>
  );
}
