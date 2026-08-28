import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, mountOnce, buttonNamed, click, keyDown, type } from '../../test/mount';
import { DraftReview } from './DraftReview';
import type { AuthoringDraft, ClauseDisposition, DraftClause } from '../../lib/authoringDraft';

function clause(id: string, title: string, disposition: ClauseDisposition, overrides: Partial<DraftClause> = {}): DraftClause {
  return {
    id,
    title,
    extractPrompt: `Extract the ${title.toLowerCase()} terms.`,
    disposition,
    edited: false,
    suggestions: [],
    ...overrides,
  };
}

function draftOf(clauses: DraftClause[]): AuthoringDraft {
  return {
    contractType: 'Commercial Lease',
    learnedFrom: [],
    modelId: 'test-model',
    clauses,
  };
}

/** The brief's harness has no `activeClauseTitle` — DraftReview exposes the
 *  active clause via `data-active-clause` on its heading so a test can name
 *  what it asserts on, rather than guessing at DOM shape. */
function activeClauseTitle(container: ParentNode): string | null {
  return container.querySelector('[data-active-clause]')?.textContent ?? null;
}

/** The brief's harness has no `fieldMatching` either — this finds a
 *  textarea/input by its accessible name (`aria-label`), the same lookup
 *  `buttonNamed` does for buttons. */
function fieldMatching(container: ParentNode, name: RegExp): HTMLTextAreaElement | HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll('textarea, input')).find((el) =>
    name.test(el.getAttribute('aria-label') ?? ''),
  ) as HTMLTextAreaElement | HTMLInputElement | undefined;
}

const twoUnreviewed = draftOf([
  clause('a', 'Clause a', 'unreviewed'),
  clause('b', 'Clause b', 'unreviewed'),
]);

const allKept = draftOf([
  clause('a', 'Clause a', 'kept'),
  clause('b', 'Clause b', 'kept'),
]);

const firstKeptSecondCutThirdUnreviewed = draftOf([
  clause('a', 'Clause a', 'kept'),
  clause('b', 'Clause b', 'cut'),
  clause('c', 'Clause c', 'unreviewed'),
]);

const onlyLastUnreviewed = draftOf([
  clause('a', 'Clause a', 'kept'),
  clause('b', 'Clause b', 'kept'),
  clause('c', 'Clause c', 'unreviewed'),
]);

const withAiPosition = draftOf([
  clause('a', 'Clause a', 'unreviewed', {
    standardPosition: { text: 'We ask for 30 days notice.', origin: 'ai-drafted', reviewedByHuman: false },
  }),
]);

const oneUnreviewed = draftOf([
  clause('a', 'Clause a', 'unreviewed', { extractPrompt: 'Original instruction.' }),
]);

function noop() {}

afterEach(() => { vi.restoreAllMocks(); });

describe('DraftReview', () => {
  it('says UNSAVED DRAFT the whole time', () => {
    const el = mount(<DraftReview draft={twoUnreviewed} onChange={noop} onSave={noop} onDiscard={noop} />);
    expect(el.textContent).toMatch(/unsaved draft/i);
  });

  it('disables save while a clause is unreviewed, and says how many remain', () => {
    const el = mount(<DraftReview draft={twoUnreviewed} onChange={noop} onSave={noop} onDiscard={noop} />);
    const save = buttonNamed(el, /left to review|save as v1/i);
    expect(save?.hasAttribute('disabled')).toBe(true);
    expect(save?.textContent).toMatch(/2 clauses left to review/);
  });

  it('enables save once every clause is decided', () => {
    const el = mount(<DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop} />);
    const save = buttonNamed(el, /save as v1/i);
    expect(save?.hasAttribute('disabled')).toBe(false);
  });

  it('J moves to the next UNREVIEWED clause, skipping decided ones', () => {
    const el = mount(
      <DraftReview draft={firstKeptSecondCutThirdUnreviewed} onChange={noop} onSave={noop} onDiscard={noop} />,
    );
    keyDown({ key: 'j' });
    expect(activeClauseTitle(el)).toBe('Clause c');
  });

  it('J at the last unreviewed clause stays put rather than wrapping', () => {
    // Wrapping would make a reviewer believe they had already seen a clause
    // they had not. Two live mount()s in one test leave two competing
    // `window` keydown listeners (CLAUDE.md) — mountOnce plus an explicit
    // unmount avoids that trap even though this test only asserts once.
    const el = mountOnce(
      <DraftReview draft={onlyLastUnreviewed} onChange={noop} onSave={noop} onDiscard={noop} />,
    );
    keyDown({ key: 'j' });
    keyDown({ key: 'j' });
    expect(activeClauseTitle(el.container)).toBe('Clause c');
    el.unmount();
  });

  it('shows an AI-proposed position as not yet reviewed', () => {
    const el = mount(<DraftReview draft={withAiPosition} onChange={noop} onSave={noop} onDiscard={noop} />);
    expect(el.textContent).toMatch(/drafted by AI/i);
    expect(el.textContent).not.toMatch(/reviewed by you/i);
  });

  it('marks a clause edited when a field was changed before keeping', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={oneUnreviewed} onChange={onChange} onSave={noop} onDiscard={noop} />);
    type(fieldMatching(el, /extraction/i) ?? null, 'A different instruction.');
    click(buttonNamed(el, /^keep$/i));
    expect(onChange.mock.calls.at(-1)![0].clauses[0].edited).toBe(true);
  });

  // R-E5's negative case: without this, `edited` could be hardcoded `true`
  // and the positive test above would still pass. `edited` feeds the
  // provenance shown on every saved position, so a false positive here is
  // the app claiming a human engaged with a clause they only clicked past.
  it('does NOT mark a clause edited when kept without changing anything', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={oneUnreviewed} onChange={onChange} onSave={noop} onDiscard={noop} />);
    click(buttonNamed(el, /^keep$/i));
    expect(onChange.mock.calls.at(-1)![0].clauses[0].edited).toBe(false);
  });

  it('cutting a clause invokes onChange with it disposed as cut', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={oneUnreviewed} onChange={onChange} onSave={noop} onDiscard={noop} />);
    click(buttonNamed(el, /^cut$/i));
    expect(onChange.mock.calls.at(-1)![0].clauses[0].disposition).toBe('cut');
  });

  it('calls onDiscard from the discard control once the confirm is accepted', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onDiscard = vi.fn();
    const el = mount(<DraftReview draft={twoUnreviewed} onChange={noop} onSave={noop} onDiscard={onDiscard} />);
    click(buttonNamed(el, /discard/i));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  // Spec §7: "Discard confirms first — it destroys work the user has partly
  // reviewed." The confirm lives HERE rather than in the caller because the
  // button is here: a gate one screen away from the control it guards is
  // the shape that lets a second caller wire the control up without it.
  // CLAUDE.md notes `window.confirm` cannot be driven by browser
  // automation but mocks cleanly in jsdom, which is why this is a jsdom
  // test and why the same behaviour is re-checked by hand in a browser.
  it('confirms before discarding, and discards nothing when the confirm is refused', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onDiscard = vi.fn();
    const el = mount(<DraftReview draft={twoUnreviewed} onChange={noop} onSave={noop} onDiscard={onDiscard} />);
    click(buttonNamed(el, /discard/i));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  // Minor 1 (final honesty review, sub-projects D/E): blanking the position
  // textarea must DROP the position, not save `{ text: '' }` into an
  // immutable version — the same rule `StandardPositionField` (D's own
  // editor) already enforces for exactly this reason.
  it('drops the standard position entirely when its text is blanked before Keep', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={withAiPosition} onChange={onChange} onSave={noop} onDiscard={noop} />);
    type(fieldMatching(el, /standard position/i) ?? null, '');
    click(buttonNamed(el, /^keep$/i));
    const kept = onChange.mock.calls.at(-1)![0].clauses[0];
    expect('standardPosition' in kept).toBe(false);
  });

  it('keeps the position, reviewed, when its text is left non-empty', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={withAiPosition} onChange={onChange} onSave={noop} onDiscard={noop} />);
    click(buttonNamed(el, /^keep$/i));
    const kept = onChange.mock.calls.at(-1)![0].clauses[0];
    expect(kept.standardPosition).toEqual({
      text: 'We ask for 30 days notice.', origin: 'ai-drafted', reviewedByHuman: false,
    });
  });

  it('calls onSave from the save control once the gate is clear', () => {
    const onSave = vi.fn();
    const el = mount(<DraftReview draft={allKept} onChange={noop} onSave={onSave} onDiscard={noop} />);
    click(buttonNamed(el, /save as v1/i));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
