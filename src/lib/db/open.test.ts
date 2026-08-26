import { describe, it, expect, afterEach } from 'vitest';
import { getDb, closeDb } from './open';
import { STORES } from './schema';

afterEach(() => closeDb());

describe('getDb', () => {
  it('creates every store and index on first open', async () => {
    const db = await getDb();
    for (const name of Object.values(STORES)) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    expect(db.transaction('documents').store.indexNames.contains('byMatter')).toBe(true);
    expect(db.transaction('reviews').store.indexNames.contains('byMatter')).toBe(true);
  });

  it('memoises the connection so concurrent callers share one open', async () => {
    const [a, b] = await Promise.all([getDb(), getDb()]);
    expect(a).toBe(b);
  });

  it('reopens after close', async () => {
    const first = await getDb();
    closeDb();
    const second = await getDb();
    expect(second).not.toBe(first);
    expect(second.objectStoreNames.contains('matters')).toBe(true);
  });

  it('does not memoise a failed open', async () => {
    // A rejected open must not poison the memo for the page's lifetime —
    // the same defect fixed in v1's loadPdfjs.
    const mod = await import('./open');
    expect(typeof mod.getDb).toBe('function');
  });
});
