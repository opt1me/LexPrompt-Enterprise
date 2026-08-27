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
    <div className="space-y-2 pt-2 border-t border-white/5">
      {ordered.length > 0 && (
        <ul className="space-y-1.5">
          {ordered.map(note => (
            <li key={note.id} className="bg-white/[0.03] rounded-lg p-2 border border-white/5">
              <p data-testid="note-text" className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap">
                {note.text}
              </p>
              <span data-testid="note-meta" className="mt-1 block text-[10px] text-gray-600">
                {formatWhen(note.at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <AutoResizeTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note as ${authorInitials}`}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg p-2 text-[11px] text-white outline-none"
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
