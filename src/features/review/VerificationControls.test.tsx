import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, buttons, click, textbox, type } from '../../test/mount';
import { unchecked } from '@lexprompt/core';
import { VerificationControls } from './VerificationControls';

// The real one, not a hand-rolled twin: `unchecked()` is what every
// finding actually starts as, and a local copy is free to drift from it.
const unverified = unchecked();

describe('VerificationControls', () => {
  it('offers verify, flag and reject', () => {
    const c = mount(<VerificationControls verification={unverified} onChange={() => {}} />);
    expect(buttonNamed(c, /verify/i)).toBeTruthy();
    expect(buttonNamed(c, /flag/i)).toBeTruthy();
    expect(buttonNamed(c, /reject/i)).toBeTruthy();
  });

  it('reports a verify with no reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /verify/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'verified' });
  });

  it('reports a flag with no reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /flag/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'flagged' });
  });

  it('does not reject immediately — it asks for a reason first', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    expect(onChange).not.toHaveBeenCalled();
    expect(c.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('refuses to confirm a rejection with an empty reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    click(buttonNamed(c, /confirm/i));
    expect(onChange).not.toHaveBeenCalled();
    expect(c.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('refuses a whitespace-only reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    type(textbox(c), '   ');
    click(buttonNamed(c, /confirm/i));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the rejection once a reason is given', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    type(textbox(c), 'Cites the wrong clause');
    click(buttonNamed(c, /confirm/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'rejected', reason: 'Cites the wrong clause' });
  });

  it('lets a set state be cleared back to unchecked', () => {
    const onChange = vi.fn();
    const c = mount(
      <VerificationControls verification={{ state: 'verified', byUserId: 'u', at: 1 }} onChange={onChange} />,
    );
    click(buttonNamed(c, /clear/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'unchecked' });
  });

  it('disables every action while a write is in flight', () => {
    const c = mount(<VerificationControls verification={unverified} busy onChange={() => {}} />);
    for (const name of [/verify/i, /flag/i, /reject/i]) {
      expect(buttonNamed(c, name)?.hasAttribute('disabled')).toBe(true);
    }
  });
});

/**
 * §3's fourth load state, at the control that records a judgement (Task 20).
 *
 * `busy` and `stale` are two attributes and two sentences, deliberately.
 * `busy` means YOUR write is in flight and will land; `stale` means the app
 * cannot vouch for what is on screen, and a change submitted against a
 * version that may be minutes old would be refused anyway. Rendering them
 * identically would tell a reviewer to wait for something that is not coming.
 */
describe('VerificationControls while the client cannot vouch for the screen', () => {
  it('disables every disposition control while stale, and says why', () => {
    const c = mount(
      <VerificationControls verification={unverified} stale onChange={() => {}} />);
    const all = buttons(c);
    expect(all.length).toBeGreaterThan(0);          // the sanity check
    for (const b of all) expect(b.disabled).toBe(true);
    expect(c.textContent).toContain('LexPrompt has lost touch with this review');
    expect(c.textContent).toContain('Your judgement would not be saved');
  });

  it('disables the Clear control too, on a finding that has a state to clear', () => {
    // `Clear` is a disposition write like any other — it moves the row back
    // to `unchecked`, with a history event and an actor on it.
    const c = mount(
      <VerificationControls
        verification={{ state: 'verified' }} stale onChange={() => {}} />);
    const clear = buttonNamed(c, /clear/i);
    expect(clear, 'the Clear control was not rendered').toBeTruthy();
    expect(clear!.disabled).toBe(true);
  });

  it('DISABLES rather than hides, so the reader can see what is unavailable', () => {
    // A hidden control is indistinguishable from a finding that cannot be
    // verified — the `isVerifiable` case, which already hides them.
    const c = mount(
      <VerificationControls verification={unverified} stale onChange={() => {}} />);
    expect(buttonNamed(c, /verify/i)).toBeTruthy();
    expect(buttonNamed(c, /flag/i)).toBeTruthy();
    expect(buttonNamed(c, /reject/i)).toBeTruthy();
  });

  it('distinguishes stale from busy, in the WORDS as well as the attribute', () => {
    const busy = mount(
      <VerificationControls verification={unverified} busy onChange={() => {}} />);
    for (const b of buttons(busy)) expect(b.disabled).toBe(true);
    // Same attribute, different sentence — and `busy` says nothing at all,
    // because a write in flight needs no explanation beyond the wait.
    expect(busy.textContent).not.toContain('lost touch');
  });

  it('does not refuse a click when it is neither busy nor stale', () => {
    // The sanity check for both cases above: the controls are live by
    // default, which is what makes the two disabled states mean something.
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unverified} onChange={onChange} />);
    click(buttonNamed(c, /verify/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'verified' });
    expect(c.textContent).not.toContain('lost touch');
  });
});
