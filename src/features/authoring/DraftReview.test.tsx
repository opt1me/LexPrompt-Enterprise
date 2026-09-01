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
    positionEdited: false,
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

  // The owner singled this pairing out by name: "Risky When" and "Our
  // Standard Position" are the two judgement fields and must read together
  // for whichever clause is active, not be split across a tab or a scroll
  // that could show one without the other.
  it('renders Risky when and Our standard position together for the active clause', () => {
    const el = mount(<DraftReview draft={withAiPosition} onChange={noop} onSave={noop} onDiscard={noop} />);
    const riskyWhen = fieldMatching(el, /^risky when$/i);
    const standardPosition = fieldMatching(el, /^our standard position$/i);
    expect(riskyWhen).toBeTruthy();
    expect(standardPosition).toBeTruthy();
    // Both present in the same document at once — no navigation between them.
    expect(el.contains(riskyWhen!)).toBe(true);
    expect(el.contains(standardPosition!)).toBe(true);
  });

  it('shows an AI-proposed position as not yet reviewed', () => {
    const el = mount(<DraftReview draft={withAiPosition} onChange={noop} onSave={noop} onDiscard={noop} />);
    expect(el.textContent).toMatch(/drafted by AI/i);
    expect(el.textContent).not.toMatch(/reviewed by you/i);
  });

  it('marks a clause edited when a field was changed before keeping', () => {
    const onChange = vi.fn();
    const el = mount(<DraftReview draft={oneUnreviewed} onChange={onChange} onSave={noop} onDiscard={noop} />);
    type(fieldMatching(el, /^extract$/i) ?? null, 'A different instruction.');
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

  // Integrity review (D/E), Major 6. The clause editor's fields are local
  // state remounted on every clause switch (deliberately — see the docstring
  // on ClauseEditor), which made them a write-only buffer that only `Keep`
  // ever drained. Moving via the rail threw away what had been typed, and a
  // clause already marked `Kept` went on saying so over the FIRST wording.
  // A silent loss under a status that is affirmatively wrong is the worst
  // shape in this codebase, so these assert the DATA, not the control.
  describe('typed edits survive leaving the clause (Major 6)', () => {
    const twoKept = draftOf([
      clause('a', 'Clause a', 'kept', { extractPrompt: 'The first wording.' }),
      clause('b', 'Clause b', 'kept'),
    ]);

    it('carries a typed edit into the draft when the rail moves to another clause', () => {
      const onChange = vi.fn();
      const el = mount(<DraftReview draft={twoKept} onChange={onChange} onSave={noop} onDiscard={noop} />);
      type(fieldMatching(el, /^extract$/i) ?? null, 'The corrected wording.');
      click(buttonNamed(el, /Clause b/));

      const next = onChange.mock.calls.at(-1)![0];
      expect(next.clauses[0].extractPrompt).toBe('The corrected wording.');
      // Still kept — switching clause is not a re-decision — but now the
      // badge and the content agree.
      expect(next.clauses[0].disposition).toBe('kept');
      expect(next.clauses[0].edited).toBe(true);
    });

    it('carries a typed edit into the draft when J moves to the next clause', () => {
      const withUnreviewed = draftOf([
        clause('a', 'Clause a', 'kept', { extractPrompt: 'The first wording.' }),
        clause('b', 'Clause b', 'unreviewed'),
      ]);
      const onChange = vi.fn();
      const el = mount(
        <DraftReview draft={withUnreviewed} onChange={onChange} onSave={noop} onDiscard={noop} />,
      );
      type(fieldMatching(el, /^extract$/i) ?? null, 'The corrected wording.');
      keyDown({ key: 'j' });
      expect(onChange.mock.calls.at(-1)![0].clauses[0].extractPrompt).toBe('The corrected wording.');
    });

    it('carries a typed edit into what Save as v1 is given', () => {
      const onChange = vi.fn();
      const onSave = vi.fn();
      const el = mount(<DraftReview draft={twoKept} onChange={onChange} onSave={onSave} onDiscard={noop} />);
      type(fieldMatching(el, /^extract$/i) ?? null, 'The corrected wording.');
      click(buttonNamed(el, /save as v1/i));

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls.at(-1)![0].clauses[0].extractPrompt).toBe('The corrected wording.');
    });

    // R-E5 still holds through the new path: leaving a clause alone and
    // moving on must not record engagement that did not happen.
    it('records nothing when the clause was only looked at', () => {
      const onChange = vi.fn();
      const el = mount(<DraftReview draft={twoKept} onChange={onChange} onSave={noop} onDiscard={noop} />);
      click(buttonNamed(el, /Clause b/));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('calls onSave from the save control once the gate is clear', () => {
    const onSave = vi.fn();
    const el = mount(<DraftReview draft={allKept} onChange={noop} onSave={onSave} onDiscard={noop} />);
    click(buttonNamed(el, /save as v1/i));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

/*
 * THE ROLE GATE, AND THE REFUSAL THAT GETS PAST IT.
 *
 * Found by driving the real app as a trainee: a reviewer drafted a
 * playbook, reviewed all six clauses, was offered an enabled `Save as v1`,
 * and clicking it issued `POST /v1/playbooks/:id/versions` — `partner` in
 * `ROUTE_POLICY` — which answered 403. Nothing on the screen changed. The
 * button was an affordance the app cannot deliver, and the refusal was
 * invisible.
 *
 * Both halves are asserted here, and both are asserted with their opposite
 * beside them: a guard that only ever checks the refused case cannot tell
 * "the control is correctly hidden" from "the control never renders".
 */
describe('DraftReview — publishing is the partner\'s, and a refusal is said out loud', () => {
  const noop = () => {};

  it('offers a partner the save control, exactly as before', () => {
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'partner' }} />);
    expect(buttonNamed(el, /save as v1/i)).toBeTruthy();
    expect(el.querySelector('[data-role-gate]')).toBeNull();
  });

  it('offers a reviewer NO save control at all, rather than one that will 403', () => {
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'reviewer' }} />);
    // Not "disabled" — absent. `SettingsPanel` names the constraint and
    // offers a non-admin nothing to click, and this screen does the same.
    expect(buttonNamed(el, /save as v1/i)).toBeUndefined();
    // …and the reviewer can still leave, so the screen is not a trap.
    expect(buttonNamed(el, /^discard$/i)).toBeTruthy();
  });

  it('names the partner role and the reviewer\'s own, instead of a bare refusal', () => {
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'reviewer' }} />);
    const gate = el.querySelector('[data-role-gate]');
    expect(gate).toBeTruthy();
    expect(gate!.textContent).toMatch(/partner role/i);
    expect(gate!.textContent).toMatch(/your lexprompt role is reviewer/i);
  });

  it('says what a refused reviewer can actually do, and does not promise a handover it cannot make', () => {
    /*
     * The draft is session-only (R-E1). "Ask a colleague to publish this" —
     * the sentence the playbook editor and the changeset review share — is
     * false here: there is no stored "this" for a partner to open. So the
     * screen has to say that the draft cannot leave this tab, and name the
     * two things that genuinely remain.
     */
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'reviewer' }} />);
    const gate = el.querySelector('[data-role-gate]')!;
    expect(gate.textContent).toMatch(/this tab only/i);
    expect(gate.textContent).toMatch(/lost if you reload/i);
    expect(gate.textContent).toMatch(/ask a partner to save it from this screen/i);
    expect(gate.textContent).toMatch(/ask an administrator to change your role/i);
  });

  it('shows no control and no refusal while the role has not been read yet', () => {
    // A permission that has not loaded is not a permission that has been
    // refused — the same "empty is not broken" rule this project applies to
    // every list, applied to a role.
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'unknown' }} />);
    expect(buttonNamed(el, /save as v1/i)).toBeUndefined();
    expect(el.querySelector('[data-role-gate]')).toBeNull();
  });

  it('still offers the save control when the role check itself failed', () => {
    // Permissive, deliberately: this gate is a courtesy and `requireRole.ts`
    // is the control, so a blip on `GET /v1/me` must not strand a partner.
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'failed', error: new Error('offline') }} />);
    expect(buttonNamed(el, /save as v1/i)).toBeTruthy();
  });

  it('keeps a refused save on the screen instead of letting it vanish', () => {
    const refusal = 'This needs the partner role, and your LexPrompt role is reviewer.';
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'partner' }} saveError={refusal} />);
    const shown = el.querySelector('[data-save-error]');
    expect(shown).toBeTruthy();
    expect(shown!.textContent).toContain(refusal);
    // Sanity: the same screen with nothing refused shows no such message,
    // so this assertion is reading the prop and not a permanent fixture.
    const clean = mountOnce(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'partner' }} />);
    expect(clean.container.querySelector('[data-save-error]')).toBeNull();
    clean.unmount();
  });

  it('shows a refusal even to a role the gate would have let through — the role can change under it', () => {
    // A gate whose only enforcement is a hidden button is a suggestion
    // (CLAUDE.md says exactly this about `canSaveDraft`), so the message
    // renders alongside the gate rather than instead of it.
    const el = mount(
      <DraftReview draft={allKept} onChange={noop} onSave={noop} onDiscard={noop}
        role={{ status: 'known', role: 'reviewer' }} saveError="Refused by the server." />);
    expect(el.querySelector('[data-role-gate]')).toBeTruthy();
    expect(el.querySelector('[data-save-error]')?.textContent).toContain('Refused by the server.');
  });
});
