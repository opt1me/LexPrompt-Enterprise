import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, textbox, type } from '../../test/mount';
import { VerificationControls } from './VerificationControls';

const unchecked = { state: 'unchecked' as const };

describe('VerificationControls', () => {
  it('offers verify, flag and reject', () => {
    const c = mount(<VerificationControls verification={unchecked} onChange={() => {}} />);
    expect(buttonNamed(c, /verify/i)).toBeTruthy();
    expect(buttonNamed(c, /flag/i)).toBeTruthy();
    expect(buttonNamed(c, /reject/i)).toBeTruthy();
  });

  it('reports a verify with no reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
    click(buttonNamed(c, /verify/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'verified' });
  });

  it('reports a flag with no reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
    click(buttonNamed(c, /flag/i));
    expect(onChange).toHaveBeenCalledWith({ state: 'flagged' });
  });

  it('does not reject immediately — it asks for a reason first', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    expect(onChange).not.toHaveBeenCalled();
    expect(c.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('refuses to confirm a rejection with an empty reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    click(buttonNamed(c, /confirm/i));
    expect(onChange).not.toHaveBeenCalled();
    expect(c.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('refuses a whitespace-only reason', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
    click(buttonNamed(c, /reject/i));
    type(textbox(c), '   ');
    click(buttonNamed(c, /confirm/i));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the rejection once a reason is given', () => {
    const onChange = vi.fn();
    const c = mount(<VerificationControls verification={unchecked} onChange={onChange} />);
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
    const c = mount(<VerificationControls verification={unchecked} busy onChange={() => {}} />);
    for (const name of [/verify/i, /flag/i, /reject/i]) {
      expect(buttonNamed(c, name)?.hasAttribute('disabled')).toBe(true);
    }
  });
});
