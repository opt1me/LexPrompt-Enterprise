import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, textbox, type } from '../../test/mount';
import { NotesPanel } from './NotesPanel';

const NOTES = [
  { id: 'n1', findingId: 'doc-1::clause-1', text: 'Check against the side letter.', byUserId: 'u', at: 1700000000000 },
  { id: 'n2', findingId: 'doc-1::clause-1', text: 'Counsel agreed.', byUserId: 'u', at: 1700000100000 },
];

describe('NotesPanel', () => {
  it('lists every note, oldest first', () => {
    const c = mount(<NotesPanel notes={NOTES} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    const texts = Array.from(c.querySelectorAll('[data-testid="note-text"]')).map(n => n.textContent);
    expect(texts).toEqual(['Check against the side letter.', 'Counsel agreed.']);
  });

  it('shows when each note was written', () => {
    const c = mount(<NotesPanel notes={[NOTES[0]]} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    expect(c.querySelector('[data-testid="note-meta"]')?.textContent).not.toBe('');
  });

  it('adds a note', () => {
    const onAddNote = vi.fn();
    const c = mount(<NotesPanel notes={[]} authorInitials="AG" localUserId="u" onAddNote={onAddNote} />);
    type(textbox(c), 'New note');
    click(buttonNamed(c, /add note/i));
    expect(onAddNote).toHaveBeenCalledWith('New note');
  });

  it('refuses an empty or whitespace-only note', () => {
    const onAddNote = vi.fn();
    const c = mount(<NotesPanel notes={[]} authorInitials="AG" localUserId="u" onAddNote={onAddNote} />);
    const add = buttonNamed(c, /add note/i);
    expect(add?.hasAttribute('disabled')).toBe(true);
    type(textbox(c), '   ');
    expect(add?.hasAttribute('disabled')).toBe(true);
    expect(onAddNote).not.toHaveBeenCalled();
  });

  it('clears the box after a successful add', () => {
    const c = mount(<NotesPanel notes={[]} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    const box = textbox(c) as HTMLTextAreaElement;
    type(box, 'New note');
    click(buttonNamed(c, /add note/i));
    expect(box.value).toBe('');
  });

  it('disables adding while a write is in flight', () => {
    const c = mount(<NotesPanel notes={[]} authorInitials="AG" localUserId="u" busy onAddNote={() => {}} />);
    expect(buttonNamed(c, /add note/i)?.hasAttribute('disabled')).toBe(true);
  });

  it('shows no note list when there are none, but still offers the box', () => {
    const c = mount(<NotesPanel notes={[]} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    expect(c.querySelectorAll('[data-testid="note-text"]')).toHaveLength(0);
    expect(textbox(c)).toBeTruthy();
  });

  it('attributes a note to "You" only when the record says the local profile wrote it', () => {
    // L3: the panel used to print "You ·" and the local initials against
    // every note it was handed, without ever reading `byUserId` — so a note
    // stored under a profile id that no longer exists (site data cleared and
    // restored, or a failed profile write minting a new id) read as the
    // current user's own words. `MatterActivity` makes exactly this check;
    // the two disagreeing about the same record is the drift that matters.
    const theirs = { ...NOTES[0], id: 'n9', byUserId: 'someone-else' };
    const c = mount(<NotesPanel notes={[theirs]} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    const meta = c.querySelector('[data-testid="note-meta"]')!.textContent!;
    expect(meta).not.toMatch(/You/);
    // …and it still says WHEN, so the note is not left unattributed AND undated.
    expect(meta.trim()).not.toBe('');
    // No borrowed avatar either: initials are a name, and this app never
    // shows a name for an actor it cannot identify (R-GP5).
    expect(c.querySelector('li span[aria-hidden="true"]')).toBeNull();
  });

  it('says "You" and shows the local initials for a note the local profile wrote', () => {
    const c = mount(<NotesPanel notes={[NOTES[0]]} authorInitials="AG" localUserId="u" onAddNote={() => {}} />);
    expect(c.querySelector('[data-testid="note-meta"]')!.textContent).toMatch(/^You · /);
    expect(c.querySelector('li span[aria-hidden="true"]')!.textContent).toBe('AG');
  });
});
