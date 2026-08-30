import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { mount, mountOnce, click, flushUntil } from '../../test/mount';
import { ConflictNotice } from './ConflictNotice';
import type { DispositionAudience } from '../../lib/findingOutcome';
import type { DispositionWithHistory } from '@lexprompt/core';

/**
 * §6.3's own sentence, and the absence beside it.
 *
 * Two properties, and the second is the one that will be under pressure for
 * as long as this feature exists: the notice NAMES whoever won, and NOTHING
 * re-submits the refused change on its own. The click is mildly annoying and
 * an automatic re-apply is one `useEffect` away — which is exactly why the
 * absence is asserted rather than assumed. An auto-retry would be
 * last-write-wins with a history row claiming a person decided it.
 */

const OKAFOR = '00000000-0000-0000-0000-0000000000a2';

const AUDIENCE: DispositionAudience = {
  nameOf: id => (id === OKAFOR ? 'R. Okafor' : undefined),
  timeOf: () => '14:22',
};

const rejectedByOkafor: DispositionWithHistory = {
  disposition: {
    reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
    state: 'rejected', reason: 'Cap is uncapped', byUserId: OKAFOR,
    at: 1_756_000_000_000, changedCount: 2, version: 3,
  },
};

const props = {
  current: rejectedByOkafor,
  attempted: { state: 'verified' as const },
  audience: AUDIENCE,
  onReapply: () => {},
  onDismiss: () => {},
};

describe('a refused change says whose won', () => {
  it('names the person and the time, and does not fall back to a generic sentence', () => {
    const container = mount(<ConflictNotice {...props} />);
    expect(container.textContent).toContain('R. Okafor changed this to Rejected at 14:22');
    expect(container.textContent).toContain('after you loaded it');
    expect(container.textContent).toContain('Your change was not applied');
    // The mutation this exists for: make `nameOf` return undefined for every
    // id (or delete the actor from `dispositionConflictLine`) and watch this
    // go red rather than quietly rendering "someone changed this".
    expect(container.textContent).not.toContain('This finding changed while you were looking');
  });

  it('never prints a raw id when the directory cannot name the winner', () => {
    const container = mount(
      <ConflictNotice {...props} audience={{ nameOf: () => undefined, timeOf: () => '14:22' }} />);
    expect(container.textContent).not.toContain(OKAFOR);
    expect(container.textContent).toContain('someone this workspace does not name');
    expect(container.textContent).toContain('Your change was not applied');
  });

  it('offers exactly the change that was refused, by name, and never a merge', () => {
    const container = mount(<ConflictNotice {...props} />);
    expect(container.querySelector('[data-action="reapply"]')!.textContent)
      .toContain('Set it to Verified anyway');
    // There is nothing to merge — a disposition is one of four words — and
    // "keep mine" IS the re-apply. A third control here would be a third
    // outcome nobody has decided the meaning of.
    expect(container.textContent).not.toMatch(/merge/i);
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('says "Clear it anyway" when the refused change was a clear', () => {
    const container = mount(<ConflictNotice {...props} attempted={{ state: 'unchecked' }} />);
    expect(container.querySelector('[data-action="reapply"]')!.textContent)
      .toContain('Clear it anyway');
  });
});

describe('a refused change is offered again by a person, and by nothing else', () => {
  it('does not resubmit anything on its own, and asserts that absence', async () => {
    const onReapply = vi.fn();
    const { container, unmount } = mountOnce(<ConflictNotice {...props} onReapply={onReapply} />);
    // P25 and P35: a human-authored write NEVER auto-retries. Mutation: call
    // `onReapply()` from a `useEffect` in ConflictNotice and watch this fail.
    await flushUntil(() => true, 'the notice to settle');
    expect(onReapply, 'the notice re-applied a refused change with nobody clicking it')
      .not.toHaveBeenCalled();

    click(container.querySelector('[data-action="reapply"]'));
    expect(onReapply).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('lets a reader accept the other person s judgement and leave', () => {
    const onDismiss = vi.fn();
    const onReapply = vi.fn();
    const container = mount(
      <ConflictNotice {...props} onDismiss={onDismiss} onReapply={onReapply} />);
    click(container.querySelector('[data-action="dismiss-conflict"]'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReapply).not.toHaveBeenCalled();
  });

  it('offers no control at all while the re-apply it started is in flight', () => {
    const container = mount(<ConflictNotice {...props} busy />);
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.disabled).toBe(true);
    }
  });
});
