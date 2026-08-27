import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { VersionHistory } from './VersionHistory';
import { SCHEMA_VERSION, type PlaybookVersion } from '../../types';

function version(n: number, changeSummary: string): PlaybookVersion {
  return {
    id: `v${n}`,
    playbookId: 'pb1',
    version: n,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 's',
    formatPrompt: 'f',
    clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'p' }],
    changeSummary,
    publishedAt: 1_700_000_000_000 + n,
    publishedByUserId: 'u1',
    schemaVersion: SCHEMA_VERSION,
  };
}

const v1 = version(1, '');
const v2 = version(2, 'Added a break-notice position');
const noop = () => {};

describe('VersionHistory', () => {
  it('lists every version with its number and change summary', () => {
    const out = mount(<VersionHistory versions={[v2, v1]} onClose={noop} />).textContent!;
    expect(out).toContain('v2');
    expect(out).toContain('Added a break-notice position');
    expect(out).toContain('v1');
  });

  // v1 has nothing it could have changed from, so its summary is
  // legitimately empty — and a blank line reads as a rendering failure
  // where a sentence reads as the fact it is.
  it('says in words why the first version has no change summary', () => {
    const out = mount(<VersionHistory versions={[v1]} onClose={noop} />).textContent!;
    expect(out).toMatch(/no change summary/i);
  });

  // A published version is immutable (spec §2): editing produces a NEW
  // version, because a review that says "ran against v4" must be able to
  // prove what v4 was.
  it('offers no way to edit a published version', () => {
    const el = mount(<VersionHistory versions={[v1, v2]} onClose={noop} />);
    expect(el.innerHTML).not.toMatch(/edit this version/i);
    expect(buttonNamed(el, /^edit/i)).toBeUndefined();
  });

  // CLAUDE.md: every screen that loads from IndexedDB distinguishes "empty"
  // from "broken", renders the error branch INSTEAD of the content, and
  // offers a retry.
  it('renders an error branch instead of the list when loading failed', () => {
    const onRetry = vi.fn();
    const el = mount(
      <VersionHistory versions={[]} error="Versions could not be read." onRetry={onRetry} onClose={noop} />,
    );
    expect(el.textContent).not.toMatch(/nothing published yet/i);
    expect(el.textContent).toMatch(/could not be read/i);
    click(buttonNamed(el, /retry/i));
    expect(onRetry).toHaveBeenCalled();
  });

  // The guard used to be `error && onRetry`, so a caller with a failure and
  // no retry handler fell through to the empty state and told the reader
  // "nothing published yet" about a playbook with two published versions.
  // A dead end that says what went wrong beats a lie that reads as a fact.
  it('still says the load failed when the caller offers no retry', () => {
    const el = mount(<VersionHistory versions={[]} error="Versions could not be read." onClose={noop} />);
    expect(el.textContent).toMatch(/could not be read/i);
    expect(el.textContent).not.toMatch(/nothing published yet/i);
    expect(buttonNamed(el, /retry/i)).toBeUndefined();
  });

  it('says plainly when a playbook has no published version yet', () => {
    const out = mount(<VersionHistory versions={[]} onClose={noop} />).textContent!;
    expect(out).toMatch(/nothing published yet/i);
  });

  it('closes through the caller', () => {
    const onClose = vi.fn();
    const el = mount(<VersionHistory versions={[v1]} onClose={onClose} />);
    click(buttonNamed(el, /close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
