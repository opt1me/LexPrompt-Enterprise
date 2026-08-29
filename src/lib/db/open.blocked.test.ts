import { describe, it, expect, vi, afterEach } from 'vitest';

// Why this file mocks 'idb' instead of relying on fake-indexeddb's real
// IndexedDB semantics (as open.test.ts does): a genuine `blocked` event
// requires a stale connection open at a *lower* version than the one being
// requested. DB_VERSION is currently 1 — the schema's very first version —
// so there is no lower version for a "stale tab" to hold open. fake-indexeddb
// does correctly fire `blocked` given two real versions (verified manually
// against raw `indexedDB.open` during development of this test), but that
// scenario cannot be produced through `getDb()` today because `getDb()`
// always opens at the single fixed DB_VERSION. Once the schema is ever
// bumped to version 2, a real end-to-end blocked-open test becomes possible
// and should be added then.
//
// What CAN be tested now, and what actually matters for this task, is the
// guard itself: when `blocked()` fires and the underlying open never
// settles (the real symptom — no error, no timeout), `getDb()` must reject
// with `DbBlockedError` instead of hanging forever. That is exercised here
// by mocking `idb`'s `openDB` to invoke `blocked()` and then never resolve.
vi.mock('idb', async importOriginal => {
  const actual = await importOriginal<typeof import('idb')>();
  return { ...actual, openDB: vi.fn() };
});

import { openDB } from 'idb';
import { getDb, closeDb, DbBlockedError } from './open';

const mockOpenDB = vi.mocked(openDB);

afterEach(() => {
  closeDb();
  mockOpenDB.mockReset();
  vi.useRealTimers();
});

/**
 * `getDb()` hands back a READ-ONLY PROXY over the opened connection from
 * Stage 2 Task 23, so the resolved value is no longer `===` the object
 * `openDB` returned. These cases were never about object identity — they are
 * about WHICH open a caller ends up holding — so each fake now carries a
 * marker and the assertions read that through the proxy. `mockOpenDB`'s call
 * count is what proves no extra connection was opened.
 */

describe('getDb blocked-upgrade guard', () => {
  it('rejects with DbBlockedError instead of hanging when blocked fires and the open never settles', async () => {
    vi.useFakeTimers();
    let capturedBlocked: (() => void) | undefined;
    mockOpenDB.mockImplementation((..._args: unknown[]) => {
      const opts = _args[2] as { blocked?: () => void };
      capturedBlocked = opts.blocked;
      return new Promise(() => {}); // simulates the real hang: never settles
    });

    const promise = getDb();
    await Promise.resolve(); // let getDb's synchronous setup run
    capturedBlocked?.();

    const assertion = expect(promise).rejects.toBeInstanceOf(DbBlockedError);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });

  it('does not memoise the blocked rejection, so a later open can succeed', async () => {
    vi.useFakeTimers();
    let capturedBlocked: (() => void) | undefined;
    mockOpenDB.mockImplementation((..._args: unknown[]) => {
      const opts = _args[2] as { blocked?: () => void };
      capturedBlocked = opts.blocked;
      return new Promise(() => {});
    });

    const first = getDb();
    await Promise.resolve();
    capturedBlocked?.();
    const firstAssertion = expect(first).rejects.toBeInstanceOf(DbBlockedError);
    await vi.advanceTimersByTimeAsync(3000);
    await firstAssertion;

    // Now the "other tab" has gone away and a real open can succeed.
    const fakeDb = { close: vi.fn(), marker: 'second-open' };
    mockOpenDB.mockImplementation(() => Promise.resolve(fakeDb as never));
    const second = await getDb() as unknown as { marker: string };
    expect(second.marker).toBe('second-open');
  });

  it('never fires DbBlockedError if the open settles before the timeout', async () => {
    vi.useFakeTimers();
    const fakeDb = { close: vi.fn(), marker: 'settled-open' };
    mockOpenDB.mockResolvedValue(fakeDb as never);

    const promise = getDb();
    await vi.advanceTimersByTimeAsync(3000);
    expect(((await promise) as unknown as { marker: string }).marker).toBe('settled-open');
  });

  it('does not let a stale blocked open null a fresher, already-resolved memo', async () => {
    // The exact reachable sequence a stale, unconditional `dbPromise = null`
    // gets wrong:
    //   1. O1 starts and gets blocked (never settles).
    //   2. Something calls closeDb() — nulls the memo out from under O1.
    //   3. A fresh getDb() call starts O2, which succeeds and is memoised.
    //   4. O1's 3s timeout finally fires and rejects internally.
    // O1's own rejection handling must not clobber O2's now-current memo,
    // or O2's connection is orphaned with nothing left to close it — which
    // is precisely the kind of leaked connection this task exists to avoid.
    vi.useFakeTimers();

    let capturedBlocked: (() => void) | undefined;
    mockOpenDB.mockImplementationOnce((..._args: unknown[]) => {
      const opts = _args[2] as { blocked?: () => void };
      capturedBlocked = opts.blocked;
      return new Promise(() => {}); // O1: never settles
    });

    const first = getDb(); // O1
    await Promise.resolve();
    capturedBlocked?.();

    // A caller (or blocking() on some other stale connection) decides to
    // close out from under the still-pending, blocked O1.
    closeDb();

    // A fresh open starts and succeeds while O1 is still hanging.
    const fakeDb2 = { close: vi.fn(), marker: 'O2' };
    mockOpenDB.mockImplementationOnce(() => Promise.resolve(fakeDb2 as never));
    const second = await getDb() as unknown as { marker: string }; // O2
    expect(second.marker).toBe('O2');

    // Now let O1's 3s timeout finally fire and reject.
    const firstAssertion = expect(first).rejects.toBeInstanceOf(DbBlockedError);
    await vi.advanceTimersByTimeAsync(3000);
    await firstAssertion;

    // The live memo must still be O2's connection, not nulled by O1's
    // stale rejection, and getDb() must not open a third connection.
    const third = await getDb() as unknown as { marker: string };
    expect(third.marker).toBe('O2');
    expect(mockOpenDB).toHaveBeenCalledTimes(2);
  });
});
