import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useToast, Toast, type ToastState } from './Toast';

// No @testing-library/react in this project; driving a real react-dom root
// directly needs this flag set for React's `act()` to recognize the
// environment (otherwise it warns on every state update, harmlessly, but
// noisily).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ToastApi {
  notify: (message: string, variant?: 'success' | 'error') => void;
  toast: ToastState | null;
}

/** Renders the hook via a real component so its timers run against real React state updates. */
function Harness({ capture }: { capture: (api: ToastApi) => void }) {
  const api = useToast();
  capture(api);
  return <Toast toast={api.toast} />;
}

describe('useToast', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
  });

  it('does not let an earlier notify\'s timer clear a later toast', () => {
    let latest!: ToastApi;
    act(() => {
      root.render(<Harness capture={(api) => { latest = api; }} />);
    });

    // t=0: first toast shown, scheduled to clear at t=3000.
    act(() => { latest.notify('first'); });
    expect(container.textContent).toContain('first');

    // t=1000: second toast shown before the first's timer fires. This must
    // cancel the pending clear-at-3000 timer, not just overwrite the state.
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { latest.notify('second'); });
    expect(container.textContent).toContain('second');

    // t=3000: this is exactly when the FIRST timer would have fired (had it
    // not been cancelled). Under the buggy implementation this clears the
    // "second" toast two seconds early.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(container.textContent).toContain('second');

    // t=4000: the second toast's own 3-second window has now elapsed.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).not.toContain('second');
    expect(latest.toast).toBeNull();
  });

  it('clears its pending timer on unmount so it cannot fire against a detached component', () => {
    let latest!: ToastApi;
    act(() => {
      root.render(<Harness capture={(api) => { latest = api; }} />);
    });
    act(() => { latest.notify('going away'); });

    act(() => { root.unmount(); });

    // Must not throw (e.g. a setState on an unmounted root) when the timer
    // would otherwise have fired.
    expect(() => {
      act(() => { vi.advanceTimersByTime(3000); });
    }).not.toThrow();
  });
});
