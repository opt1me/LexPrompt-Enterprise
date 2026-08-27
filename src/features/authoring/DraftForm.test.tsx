import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, type } from '../../test/mount';
import { DraftForm } from './DraftForm';

describe('DraftForm', () => {
  it('says plainly in the form footer that nothing is saved yet', () => {
    const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}} />);
    expect(c.textContent).toMatch(/nothing is saved/i);
  });

  it('keeps everything typed when generation fails', () => {
    const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
      error="The model could not be reached."
      initialValues={{ contractType: 'Lease', context: 'Acting for the tenant.' }} />);
    expect(c.textContent).toContain('The model could not be reached.');
    // Losing a filled-in form to a 500 is the small betrayal that stops people
    // using a feature (spec §7).
    expect(c.innerHTML).toContain('Acting for the tenant.');
  });

  it('routes an auth failure to Settings instead of showing it in the form', () => {
    const onAuthError = vi.fn();
    mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
      error="Your API key was rejected." authFailed onAuthError={onAuthError} />);
    expect(onAuthError).toHaveBeenCalled();
  });

  it('does NOT route an ordinary failure to Settings', () => {
    // Without this, every 502 sends the user to fix a key that is fine — the
    // same class of wrong advice as telling someone to reload when reloading
    // cannot help.
    const onAuthError = vi.fn();
    mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
      error="502 Bad Gateway" onAuthError={onAuthError} />);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('does not show the raw error text in the form when it was an auth failure', () => {
    // The error is routed to Settings instead — showing it here too would be
    // a second, contradictory story about the same failure.
    const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={() => {}}
      error="Your API key was rejected." authFailed onAuthError={() => {}} />);
    expect(c.textContent).not.toContain('Your API key was rejected.');
  });

  it('submits the typed form values and the selected few-shot sources together', () => {
    const onSubmit = vi.fn();
    const c = mount(<DraftForm playbooks={[{ id: 'p1', name: 'NDA v2' }]} matters={[]}
      onSubmit={onSubmit} onCancel={() => {}} />);

    const contractType = [...c.querySelectorAll('input')]
      .find(el => /contract type/i.test(el.placeholder ?? el.getAttribute('aria-label') ?? ''))
      ?? c.querySelector('input');
    type(contractType as HTMLInputElement, 'Commercial Lease');

    const sourceBox = c.querySelector('input[type="checkbox"]') as HTMLInputElement;
    click(sourceBox);

    click(buttonNamed(c, /draft the playbook/i));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [form, sources] = onSubmit.mock.calls[0];
    expect(form.contractType).toBe('Commercial Lease');
    expect(sources).toEqual([{ kind: 'playbook', id: 'p1', name: 'NDA v2' }]);
  });

  it('does not submit while the contract type is blank', () => {
    const onSubmit = vi.fn();
    const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={onSubmit} onCancel={() => {}} />);
    const submit = buttonNamed(c, /draft the playbook/i);
    expect(submit?.disabled).toBe(true);
    if (submit && !submit.disabled) click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables submission while busy', () => {
    const c = mount(<DraftForm playbooks={[]} matters={[]} busy onSubmit={() => {}} onCancel={() => {}}
      initialValues={{ contractType: 'Lease' }} />);
    const submit = buttonNamed(c, /draft/i);
    expect(submit?.disabled).toBe(true);
  });

  it('calls onCancel from the cancel control', () => {
    const onCancel = vi.fn();
    const c = mount(<DraftForm playbooks={[]} matters={[]} onSubmit={() => {}} onCancel={onCancel} />);
    click(buttonNamed(c, /cancel/i));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
