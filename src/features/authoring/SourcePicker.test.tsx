import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click, buttonNamed } from '../../test/mount';
import { SourcePicker } from './SourcePicker';
import type { FewShotSource } from './fewShot';

function checkboxNamed(c: HTMLElement, name: RegExp): HTMLInputElement | undefined {
  return [...c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find((el) => name.test(el.closest('label')?.textContent ?? ''));
}

describe('SourcePicker', () => {
  it('discloses that selecting a matter sends its content to the model (R-E2)', () => {
    // Everything else in this app sends only the document under review. This
    // sends OTHER matters' text. Spec §10 requires saying so at the point of
    // selection, not in a settings note.
    const c = mount(<SourcePicker playbooks={[]} matters={[{ id: 'm1', name: 'Acme' }]}
      selected={[]} onChange={() => {}} />);
    expect(c.textContent).toMatch(/sent to the model|leaves your browser|other matters/i);
  });

  it('does not disclose anything when there are no matters to pick from', () => {
    // The disclosure is specifically about matter content; a playbook's
    // clause titles carry no client text, so nothing to warn about there.
    const c = mount(<SourcePicker playbooks={[{ id: 'p1', name: 'NDA v2' }]} matters={[]}
      selected={[]} onChange={() => {}} />);
    expect(c.textContent).not.toMatch(/sent to the model|leaves your browser/i);
  });

  it('reflects a selected source as checked', () => {
    const selected: FewShotSource[] = [{ kind: 'matter', id: 'm1', name: 'Acme' }];
    const c = mount(<SourcePicker playbooks={[]} matters={[{ id: 'm1', name: 'Acme' }]}
      selected={selected} onChange={() => {}} />);
    const box = checkboxNamed(c, /acme/i);
    expect(box?.checked).toBe(true);
  });

  it('adds a source on check', () => {
    const onChange = vi.fn();
    const c = mount(<SourcePicker playbooks={[{ id: 'p1', name: 'NDA v2' }]} matters={[]}
      selected={[]} onChange={onChange} />);
    const box = checkboxNamed(c, /nda v2/i)!;
    click(box);
    expect(onChange).toHaveBeenCalledWith([{ kind: 'playbook', id: 'p1', name: 'NDA v2' }]);
  });

  it('removes a source on uncheck, leaving other selections untouched', () => {
    const onChange = vi.fn();
    const selected: FewShotSource[] = [
      { kind: 'playbook', id: 'p1', name: 'NDA v2' },
      { kind: 'matter', id: 'm1', name: 'Acme' },
    ];
    const c = mount(<SourcePicker playbooks={[{ id: 'p1', name: 'NDA v2' }]}
      matters={[{ id: 'm1', name: 'Acme' }]} selected={selected} onChange={onChange} />);
    const box = checkboxNamed(c, /nda v2/i)!;
    click(box);
    expect(onChange).toHaveBeenCalledWith([{ kind: 'matter', id: 'm1', name: 'Acme' }]);
  });

  // M1 (final honesty review, sub-projects D/E): a matters-load failure must
  // read as "we could not read your matters", never as "you have none" —
  // CLAUDE.md's empty-vs-broken rule, one screen over from where
  // `TemplateEditor`'s `healthError` already closes it.
  it('shows a load error instead of the matter checkboxes when matters failed to load', () => {
    const c = mount(<SourcePicker playbooks={[]} matters={[]} selected={[]} onChange={() => {}}
      mattersError="The matters list could not be loaded. Try again." />);
    expect(c.textContent).toContain('The matters list could not be loaded. Try again.');
    // Not silently mistaken for "no matters yet": no checkbox is rendered,
    // but the error message stands in its place rather than nothing at all.
    expect(c.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('offers a working retry from the matters load error', () => {
    const onRetryMatters = vi.fn();
    const c = mount(<SourcePicker playbooks={[]} matters={[]} selected={[]} onChange={() => {}}
      mattersError="boom" onRetryMatters={onRetryMatters} />);
    click(buttonNamed(c, /retry/i)!);
    expect(onRetryMatters).toHaveBeenCalledTimes(1);
  });

  it('renders the error INSTEAD OF the list even if matters somehow arrived non-empty alongside it', () => {
    // Guards the "instead of" half of the fix: if matters somehow arrived
    // non-empty alongside an error (should not happen upstream, but this
    // component must not compound the mistake), the error still wins.
    const c = mount(<SourcePicker playbooks={[]} matters={[{ id: 'm1', name: 'Acme' }]} selected={[]}
      onChange={() => {}} mattersError="boom" />);
    expect(c.textContent).not.toContain('Acme');
    expect(c.textContent).toContain('boom');
  });

  // m6: the heading must not claim a filter ("completed") that is not
  // applied — App.tsx hands this component every matter regardless of state.
  it('does not claim the matters offered are "completed"', () => {
    const c = mount(<SourcePicker playbooks={[]} matters={[{ id: 'm1', name: 'Acme' }]} selected={[]}
      onChange={() => {}} />);
    expect(c.textContent).not.toMatch(/completed matter/i);
    expect(c.textContent).toMatch(/learn from a matter/i);
  });
});
