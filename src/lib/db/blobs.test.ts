import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { getDocumentBlob } from './blobs';
import { getDb, closeDb } from './open';
import { STORES } from './schema';

// See documents.test.ts for why tests construct blobs via node:buffer's
// Blob rather than the jsdom global: fake-indexeddb clones values with
// Node's native structuredClone, which does not recognise jsdom's Blob
// implementation and silently clones it down to `{}`. node:buffer's Blob is
// what this test environment's structuredClone actually preserves.
function makeBlob(parts: string[], type: string): Blob {
  return new NodeBlob(parts, { type }) as unknown as Blob;
}

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.blobs);
});

afterEach(() => closeDb());

describe('getDocumentBlob', () => {
  it('returns null, not a throw, when no blob is on record', async () => {
    await expect(getDocumentBlob('nope')).resolves.toBeNull();
  });

  it('returns the stored bytes with size and type intact', async () => {
    const db = await getDb();
    const bytes = makeBlob(['hello world'], 'application/pdf');
    await db.put(STORES.blobs, { documentId: 'doc-1', bytes, mime: 'application/pdf' });

    const back = await getDocumentBlob('doc-1');
    expect(back).not.toBeNull();
    expect(back!.size).toBe(bytes.size);
    expect(back!.type).toBe('application/pdf');
    expect(await back!.text()).toBe('hello world');
  });

  it('propagates a genuine database failure rather than returning null for it', async () => {
    const db = await getDb();
    const spy = vi.spyOn(db, 'get').mockRejectedValue(new Error('db is down'));
    try {
      await expect(getDocumentBlob('doc-1')).rejects.toThrow(/db is down/);
    } finally {
      spy.mockRestore();
    }
  });
});
