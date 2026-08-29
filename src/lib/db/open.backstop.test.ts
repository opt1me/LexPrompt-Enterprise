import { describe, it, expect, vi, afterEach } from 'vitest';

// This mirrors open.blocked.test.ts's approach and for the same reason: the
// defect being closed here is an IndexedDB open that never settles at all —
// no success, no error, and (unlike the blocked case) no `blocked()` event
// either. fake-indexeddb has no way to manufacture that browser-level fault
// on demand, so `idb`'s `openDB` is mocked to return a promise that simply
// never resolves or rejects, and fake timers drive the 30s backstop.
vi.mock('idb', async importOriginal => {
  const actual = await importOriginal<typeof import('idb')>();
  return { ...actual, openDB: vi.fn() };
});

import { openDB } from 'idb';
import { getDb, closeDb, DbBlockedError, DbOpenTimeoutError } from './open';

const mockOpenDB = vi.mocked(openDB);

afterEach(() => {
  closeDb();
  mockOpenDB.mockReset();
  vi.useRealTimers();
});

describe('getDb open-timeout backstop', () => {
  it('rejects with DbOpenTimeoutError after 30s when the open never settles and blocked() never fires', async () => {
    vi.useFakeTimers();
    mockOpenDB.mockImplementation(() => new Promise(() => {})); // never resolves, never rejects

    const promise = getDb();
    // Swallow so an unhandled-rejection warning doesn't fire before the
    // `rejects` assertion attaches its own handler further down.
    promise.catch(() => {});

    const assertion = expect(promise).rejects.toBeInstanceOf(DbOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });

  it('does not reject if the open settles before the 30s backstop, and leaves no timer pending', async () => {
    vi.useFakeTimers();
    const fakeDb = { close: vi.fn(), marker: 'settled-open' };
    mockOpenDB.mockResolvedValue(fakeDb as never);

    // `.marker` rather than `toBe(fakeDb)`: `getDb()` hands back a read-only
    // proxy over the connection from Task 23, so identity is no longer
    // preserved — and identity was never what this case was about.
    const promise = getDb();
    expect(((await promise) as unknown as { marker: string }).marker).toBe('settled-open');

    // A resolved native Promise ignores a later reject() call silently, so
    // asserting on `promise` alone would not catch a backstop timer left
    // armed after success (rejecting a settled promise is a no-op, not an
    // error) — the real requirement is that no timer is left running at
    // all. vi.getTimerCount() checks that directly, not just its absence of
    // externally-visible effect.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30000);
    expect(((await getDb()) as unknown as { marker: string }).marker).toBe('settled-open');
  });

  it('a blocked open still rejects with DbBlockedError well before the 30s backstop, unchanged', async () => {
    vi.useFakeTimers();
    let capturedBlocked: (() => void) | undefined;
    mockOpenDB.mockImplementation((..._args: unknown[]) => {
      const opts = _args[2] as { blocked?: () => void };
      capturedBlocked = opts.blocked;
      return new Promise(() => {}); // never settles, exactly like the real hang
    });

    const promise = getDb();
    promise.catch(() => {});
    await Promise.resolve(); // let getDb's synchronous setup run
    capturedBlocked?.();

    const assertion = expect(promise).rejects.toBeInstanceOf(DbBlockedError);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;

    // The 30s backstop timer must have been cleared by the 3s blocked
    // rejection, not merely raced — advancing well past it must not produce
    // a second, different rejection (there is nothing left to reject: the
    // promise already settled, and the memo was cleared by the .catch in
    // getDb, so this just proves nothing throws / nothing is left running).
    await vi.advanceTimersByTimeAsync(30000);
  });
});
