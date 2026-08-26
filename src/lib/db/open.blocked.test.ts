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
    const fakeDb = { close: vi.fn() };
    mockOpenDB.mockImplementation(() => Promise.resolve(fakeDb as never));
    const second = await getDb();
    expect(second).toBe(fakeDb);
  });

  it('never fires DbBlockedError if the open settles before the timeout', async () => {
    vi.useFakeTimers();
    const fakeDb = { close: vi.fn() };
    mockOpenDB.mockResolvedValue(fakeDb as never);

    const promise = getDb();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe(fakeDb);
  });
});
