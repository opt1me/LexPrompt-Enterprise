import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { listDocuments, getDocument, addDocument, deleteDocument, setDocumentRole } from './documents';
import { getDocumentBlob } from './blobs';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { DocumentRecord } from '../../types';

// jsdom's `Blob` (the global `Blob` in this test environment) does not
// survive fake-indexeddb's structured clone: fake-indexeddb clones values
// with Node's native `structuredClone`, which only recognises Node's own
// Blob implementation. A jsdom Blob clones down to `{}` — silently, with
// no thrown error — losing size, type and content. That's a gap between
// this test environment's two separate Blob shims, not a real-browser bug:
// a real browser's IndexedDB structured-clones its own native Blob (the
// same object `File`/`Blob` already are there) correctly. `node:buffer`'s
// Blob is what this environment's structuredClone actually round-trips, so
// tests use it to exercise the DB layer meaningfully.
function makeBlob(parts: string[], type: string): Blob {
  return new NodeBlob(parts, { type }) as unknown as Blob;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: uid(),
    matterId: 'matter-1',
    name: 'contract.pdf',
    kind: 'pdf',
    text: 'Some extracted text.',
    byteSize: 11,
    addedAt: Date.now(),
    addedByUserId: 'owner-1',
    role: 'standalone',
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await getDb();
  await Promise.all([db.clear(STORES.documents), db.clear(STORES.blobs)]);
});

afterEach(() => closeDb());

describe('addDocument / getDocument / listDocuments', () => {
  it('starts empty for an unknown matter', async () => {
    expect(await listDocuments('nope')).toEqual([]);
  });

  it('returns null for an unknown document id', async () => {
    expect(await getDocument('nope')).toBeNull();
  });

  it('writes and reads back a document record', async () => {
    const rec = makeRecord({ name: 'nda.pdf' });
    await addDocument(rec, makeBlob(['hello world'], 'application/pdf'));
    const found = await getDocument(rec.id);
    expect(found).toEqual(rec);
  });

  it('round-trips the blob: same size, type and content as written', async () => {
    const rec = makeRecord();
    const bytes = makeBlob(['hello world'], 'application/pdf');
    await addDocument(rec, bytes);

    const back = await getDocumentBlob(rec.id);
    expect(back).not.toBeNull();
    expect(back!.size).toBe(bytes.size);
    expect(back!.type).toBe('application/pdf');
    expect(await back!.text()).toBe('hello world');
  });

  it('lists only documents for the requested matter', async () => {
    const a = makeRecord({ matterId: 'matter-a', name: 'a.pdf' });
    const b = makeRecord({ matterId: 'matter-b', name: 'b.pdf' });
    await addDocument(a, makeBlob(['a'], 'application/pdf'));
    await addDocument(b, makeBlob(['b'], 'application/pdf'));

    expect((await listDocuments('matter-a')).map(d => d.name)).toEqual(['a.pdf']);
    expect((await listDocuments('matter-b')).map(d => d.name)).toEqual(['b.pdf']);
  });

  it('lists oldest-added first', async () => {
    const older = makeRecord({ matterId: 'm', name: 'older.pdf', addedAt: 1 });
    const newer = makeRecord({ matterId: 'm', name: 'newer.pdf', addedAt: 2 });
    // Add out of order to prove the list is sorted, not just insertion order.
    await addDocument(newer, makeBlob(['n'], 'application/pdf'));
    await addDocument(older, makeBlob(['o'], 'application/pdf'));

    expect((await listDocuments('m')).map(d => d.name)).toEqual(['older.pdf', 'newer.pdf']);
  });

  it('addDocument writes the record and the blob in exactly one transaction', async () => {
    // Guards the transaction-auto-close trap: if the record write and the
    // blob write ever moved to two separately-opened transactions (or an
    // await of something non-IDB slipped between them), this would observe
    // db.transaction() called more than once, or called for only one store.
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await addDocument(makeRecord(), makeBlob(['x'], 'text/plain'));
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.documents, STORES.blobs], 'readwrite');
    txSpy.mockRestore();
  });

  it("addDocument's rejection is not swallowed when the blob write fails", async () => {
    // Stubs db.transaction so the blobs-store put rejects (as a genuine
    // failed IDB request would) and confirms addDocument's own promise
    // rejects rather than resolving — a caller must not be able to observe
    // a partially-failed addDocument as a success.
    const db = await getDb();
    const rec = makeRecord();
    const failingTx = {
      objectStore: (name: string) => ({
        put:
          name === STORES.blobs
            ? () => Promise.reject(new DOMException('boom', 'UnknownError'))
            : () => Promise.resolve(),
      }),
      done: Promise.resolve(),
    };
    const spy = vi.spyOn(db, 'transaction').mockReturnValue(failingTx as unknown as ReturnType<typeof db.transaction>);
    try {
      await expect(addDocument(rec, makeBlob(['x'], 'text/plain'))).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await getDocument(rec.id)).toBeNull();
  });
});

describe('deleteDocument', () => {
  it('removes both the record and its blob', async () => {
    const rec = makeRecord();
    await addDocument(rec, makeBlob(['x'], 'application/pdf'));

    await deleteDocument(rec.id);

    expect(await getDocument(rec.id)).toBeNull();
    expect(await getDocumentBlob(rec.id)).toBeNull();
  });

  it('resolves quietly when the document does not exist', async () => {
    await expect(deleteDocument('does-not-exist')).resolves.toBeUndefined();
  });

  it('deletes the record and the blob in exactly one transaction', async () => {
    const rec = makeRecord();
    await addDocument(rec, makeBlob(['x'], 'application/pdf'));

    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await deleteDocument(rec.id);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.documents, STORES.blobs], 'readwrite');
    txSpy.mockRestore();
  });

  it("does not touch another document's record or blob", async () => {
    const keep = makeRecord({ name: 'keep.pdf' });
    const gone = makeRecord({ name: 'gone.pdf' });
    await addDocument(keep, makeBlob(['k'], 'application/pdf'));
    await addDocument(gone, makeBlob(['g'], 'application/pdf'));

    await deleteDocument(gone.id);

    expect(await getDocument(keep.id)).toEqual(keep);
    expect(await getDocumentBlob(keep.id)).not.toBeNull();
  });
});

describe('a document whose blob is missing is still readable (spec §9)', () => {
  it('getDocument returns the metadata; getDocumentBlob returns null, not a throw', async () => {
    const db = await getDb();
    const rec = makeRecord({ name: 'orphaned.pdf' });
    // Write only the record, simulating a blob lost to a partial failure or
    // a manual clear of browser storage — never actually possible through
    // this module's own addDocument, which is exactly the point of the
    // one-transaction guarantee above, but the record store does not know
    // *why* a blob might be missing and must stay readable regardless.
    await db.put(STORES.documents, rec);

    await expect(getDocument(rec.id)).resolves.toEqual(rec);
    await expect(getDocumentBlob(rec.id)).resolves.toBeNull();
  });
});

describe('setDocumentRole (Task 7: grouping/ungrouping)', () => {
  it('sets role and collectionId, leaving every other field untouched', async () => {
    const rec = makeRecord({ name: 'lease.pdf', text: 'Some extracted text.' });
    await addDocument(rec, makeBlob(['x'], 'application/pdf'));

    await setDocumentRole(rec.id, 'base', 'coll-1');

    const found = await getDocument(rec.id);
    expect(found).toEqual({ ...rec, role: 'base', collectionId: 'coll-1' });
  });

  it('clears collectionId entirely on ungroup — the key is absent, not undefined', async () => {
    const rec = makeRecord({ role: 'varies', collectionId: 'coll-1' });
    await addDocument(rec, makeBlob(['x'], 'application/pdf'));

    await setDocumentRole(rec.id, 'standalone');

    const found = await getDocument(rec.id);
    expect(found!.role).toBe('standalone');
    // toEqual would treat { collectionId: undefined } as equal to an
    // absent key (CLAUDE.md's own warning) — the real risk here is
    // structuredClone PRESERVING an undefined-valued key, so the
    // assertion that actually matters checks presence, not equality.
    expect('collectionId' in found!).toBe(false);
  });

  it('rejects rather than silently no-op-ing when the document does not exist', async () => {
    await expect(setDocumentRole('does-not-exist', 'base', 'coll-1')).rejects.toThrow();
  });

  it('does not touch another document\'s record', async () => {
    const keep = makeRecord({ name: 'keep.pdf' });
    const grouped = makeRecord({ name: 'grouped.pdf' });
    await addDocument(keep, makeBlob(['k'], 'application/pdf'));
    await addDocument(grouped, makeBlob(['g'], 'application/pdf'));

    await setDocumentRole(grouped.id, 'base', 'coll-1');

    expect(await getDocument(keep.id)).toEqual(keep);
  });
});

describe('error propagation (not swallowed into empty results)', () => {
  it('listDocuments rejects, distinguishably from an empty list, on a database failure', async () => {
    const db = await getDb();
    const spy = vi.spyOn(db, 'getAllFromIndex').mockRejectedValue(new Error('db is down'));
    try {
      await expect(listDocuments('matter-1')).rejects.toThrow(/db is down/);
    } finally {
      spy.mockRestore();
    }
  });

  it('getDocument rejects rather than resolving to null on a database failure', async () => {
    const db = await getDb();
    const spy = vi.spyOn(db, 'get').mockRejectedValue(new Error('db is down'));
    try {
      await expect(getDocument('anything')).rejects.toThrow(/db is down/);
    } finally {
      spy.mockRestore();
    }
  });
});
