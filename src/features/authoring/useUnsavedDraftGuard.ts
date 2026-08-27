import { useEffect } from 'react';

/**
 * R-E4 — warn before losing a session-only draft, by BOTH routes out of it.
 *
 * `beforeunload` covers a tab close, a reload, and a navigation to another
 * origin. It does **not** fire on an in-app route change — clicking
 * "Matters" in the header — which is the far likelier way someone loses a
 * draft that only ever existed in React state. So this hook does two
 * things, and both halves are load-bearing:
 *
 * - it registers a `beforeunload` handler for as long as `dirty` holds, and
 * - it returns `confirmLeave()`, which every in-app exit must consult
 *   before it changes the view.
 *
 * Wiring only the first looks like a working guard right up until someone
 * clicks a link — the "correct mechanism with no path to it" shape this
 * project keeps rediscovering. The in-app test in
 * `useUnsavedDraftGuard.test.tsx` (and `App.authoring.test.tsx`'s nav-click
 * test) is what fails if the second half is ever dropped.
 *
 * `confirmLeave` is deliberately a fresh closure over the current `dirty`
 * on every render rather than a memoised callback. Both consumers in
 * `App.tsx` — `requestView`, itself rebuilt each render, and `useRoute`'s
 * `canLeaveCurrentView`, which re-reads its guard on every render by
 * design — always hold the closure from the latest render, so memoising
 * here would add nothing but a way for the guard to go stale and wave a
 * live draft through.
 */
export function useUnsavedDraftGuard(dirty: boolean, message: string): () => boolean {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Browsers substitute their own wording and ignore ours; the only
      // thing that has any effect is cancelling the event.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return () => (dirty ? window.confirm(message) : true);
}
