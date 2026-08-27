import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount, mountOnce } from '../test/mount';
import { StateChip } from './StateChip';

// No @testing-library/react in this project — these tests were drafted
// against `render`/`screen` and are translated mechanically onto the
// shared harness: `mount`/`mountOnce` in place of `render`, and a direct
// `[role="status"]` query in place of `screen.getByRole('status')`. The
// assertions themselves are unchanged.
function status(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[role="status"]');
  if (!el) throw new Error('No [role="status"] element found — StateChip must always render one.');
  return el as HTMLElement;
}

describe('StateChip', () => {
  it('says plainly that an unchecked finding is unverified', () => {
    const container = mount(<StateChip verification={{ state: 'unchecked' }} />);
    expect(/unverified/i.test(container.textContent || '')).toBe(true);
  });

  it('renders something for every state — none is silent', () => {
    for (const state of ['unchecked', 'verified', 'flagged'] as const) {
      const { container, unmount } = mountOnce(<StateChip verification={{ state }} />);
      expect(status(container).textContent?.trim()).not.toBe('');
      unmount();
    }
    const { container, unmount } = mountOnce(<StateChip verification={{ state: 'rejected', reason: 'wrong' }} />);
    expect(status(container).textContent?.trim()).not.toBe('');
    unmount();
  });

  it('exposes the reason on a rejected chip', () => {
    const container = mount(<StateChip verification={{ state: 'rejected', reason: 'Cites the wrong clause' }} />);
    expect(status(container).getAttribute('title')).toContain('Cites the wrong clause');
  });

  it('does not render a risk level — the two must never be one badge', () => {
    const container = mount(<StateChip verification={{ state: 'verified' }} />);
    expect(/high|medium|low|info/i.test(container.textContent || '')).toBe(false);
  });
});
