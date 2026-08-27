import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, mountOnce, buttonNamed, click } from '../../test/mount';
import { useUnsavedDraftGuard } from './useUnsavedDraftGuard';

const MESSAGE = 'This draft has not been saved. Leave anyway?';

/** A minimal host for the hook: a "Leave" button that only reports having
 *  left when the guard lets it through. That is the shape of every real
 *  caller (`requestView`, `useRoute`'s `canLeaveCurrentView`), so a guard
 *  that returns the wrong answer shows up here as the wrong text on screen
 *  rather than as an assertion about an internal. */
function Host({ dirty }: { dirty: boolean }) {
  const confirmLeave = useUnsavedDraftGuard(dirty, MESSAGE);
  const [left, setLeft] = React.useState(false);
  return (
    <div>
      <button onClick={() => { if (confirmLeave()) setLeft(true); }}>Leave</button>
      <span>{left ? 'gone' : 'still here'}</span>
    </div>
  );
}

/** Dispatches a cancelable `beforeunload` and reports whether anything
 *  cancelled it. `defaultPrevented` is the only observable a browser acts
 *  on, so it is the only thing worth asserting — spying on
 *  `addEventListener` would pass for a handler that did nothing. */
function beforeUnloadWasCancelled(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('useUnsavedDraftGuard', () => {
  describe('the in-app half (R-E4) — the one `beforeunload` cannot cover', () => {
    it('lets an in-app exit through without asking when there is nothing to lose', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const el = mount(<Host dirty={false} />);
      click(buttonNamed(el, /leave/i));
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(el.textContent).toContain('gone');
    });

    it('asks before an in-app exit while a draft is live, and blocks it on "cancel"', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const el = mount(<Host dirty />);
      click(buttonNamed(el, /leave/i));
      expect(confirmSpy).toHaveBeenCalledWith(MESSAGE);
      expect(el.textContent).toContain('still here');
    });

    it('lets the exit through when the person confirms they meant it', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const el = mount(<Host dirty />);
      click(buttonNamed(el, /leave/i));
      expect(el.textContent).toContain('gone');
    });
  });

  describe('the beforeunload half — a reload or a tab close', () => {
    it('cancels beforeunload while a draft is live', () => {
      mount(<Host dirty />);
      expect(beforeUnloadWasCancelled()).toBe(true);
    });

    it('leaves beforeunload alone when there is no draft', () => {
      mount(<Host dirty={false} />);
      expect(beforeUnloadWasCancelled()).toBe(false);
    });

    // A listener that outlives its component would warn about a draft that
    // no longer exists — a warning nobody can act on is its own kind of
    // lie, and `mountOnce` is how CLAUDE.md says to prove a teardown
    // without leaving two live trees fighting over one window listener.
    it('stops warning once the screen holding the draft is gone', () => {
      const { unmount } = mountOnce(<Host dirty />);
      expect(beforeUnloadWasCancelled()).toBe(true);
      unmount();
      expect(beforeUnloadWasCancelled()).toBe(false);
    });
  });
});
