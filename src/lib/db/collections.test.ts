import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import type { Collection } from '../../types';

/**
 * The collections repository, now a TRANSPORT.
 *
 * The sort, the `_seq` tiebreak and the member-order round trip moved to
 * `apps/api/test/collections.pg.test.ts`, where a real Postgres proves them.
 * The `newCollection` cases below are kept VERBATIM: it is pure, still
 * client-side, and its needing no edit is the evidence R3's seam held for it.
 *
 * What stays here is which request each export makes, that member order is
 * sent exactly as given, and that a failure stays a failure.
 */

const apiGet = vi.fn();
const apiGetOrNull = vi.fn();
const apiSend = vi.fn();
const apiDelete = vi.fn();

vi.mock('../api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiGetOrNull: (...args: unknown[]) => apiGetOrNull(...args),
  apiSend: (...args: unknown[]) => apiSend(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}));

const { newCollection, listCollections, getCollection, saveCollection, deleteCollection } =
  await import('./collections');

const COLLECTION: Collection = {
  id: 'c1', matterId: 'm1', name: 'Lease + two DoVs', baseDocumentId: 'd-base',
  variesDocumentIds: ['d-a', 'd-b'], createdAt: 1_700_000_000_000, createdByUserId: 'u1',
  version: 3,
};

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue([]);
  apiGetOrNull.mockReset().mockResolvedValue(null);
  apiSend.mockReset().mockResolvedValue(COLLECTION);
  apiDelete.mockReset().mockResolvedValue(undefined);
});

describe('newCollection', () => {
  // KEPT VERBATIM from the IndexedDB version of this file.
  it('creates a collection with no amendments and the given author', () => {
    const c = newCollection('m1', 'Lease', 'd-base', 'owner-1');
    expect(c.matterId).toBe('m1');
    expect(c.name).toBe('Lease');
    expect(c.baseDocumentId).toBe('d-base');
    expect(c.variesDocumentIds).toEqual([]);
    expect(c.createdByUserId).toBe('owner-1');
    expect(c.id).toBeTruthy();
    expect(c.createdAt).toBeGreaterThan(0);
  });

  it('mints no version, because a new collection has none to state', () => {
    // The absence is the claim "I believe this is a create" — a create that
    // carried a version would be a stale write dressed as a new record.
    expect('version' in newCollection('m1', 'L', 'd', 'u')).toBe(false);
  });
});

describe('the requests each export makes', () => {
  it('lists a matter s collections from /v1/matters/:id/collections, in the server s order', async () => {
    const list = [{ ...COLLECTION, id: 'b' }, { ...COLLECTION, id: 'a' }];
    apiGet.mockResolvedValue(list);
    expect((await listCollections('m1')).map(c => c.id)).toEqual(['b', 'a']);
    expect(apiGet).toHaveBeenCalledWith('/v1/matters/m1/collections');
  });

  it('reads one from /v1/collections/:id', async () => {
    apiGetOrNull.mockResolvedValue(COLLECTION);
    expect(await getCollection('c1')).toEqual(COLLECTION);
    expect(apiGetOrNull).toHaveBeenCalledWith('/v1/collections/c1');
  });

  it('PUTs the WHOLE record and returns what the server saved', async () => {
    const saved = { ...COLLECTION, name: 'Renamed', version: 4 };
    apiSend.mockResolvedValue(saved);
    expect(await saveCollection({ ...COLLECTION, name: 'Renamed' })).toEqual(saved);
    expect(apiSend).toHaveBeenCalledWith(
      'PUT', '/v1/collections/c1', { ...COLLECTION, name: 'Renamed' });
  });

  it('sends member order exactly as given, and sorts nothing', async () => {
    // `orderedMembers` is the only place collection reading order is decided
    // and `documentDate` never governs it (R-C3). A second sort here — even
    // a helpful one — is the sibling drift that rule exists to prevent.
    const shuffled = { ...COLLECTION, variesDocumentIds: ['d3', 'd1', 'd2'] };
    await saveCollection(shuffled);
    expect((apiSend.mock.calls[0][2] as Collection).variesDocumentIds)
      .toEqual(['d3', 'd1', 'd2']);
  });

  it('returns member order exactly as the server sent it', async () => {
    apiGetOrNull.mockResolvedValue({ ...COLLECTION, variesDocumentIds: ['d3', 'd1', 'd2'] });
    expect((await getCollection('c1'))!.variesDocumentIds).toEqual(['d3', 'd1', 'd2']);
  });

  it('sends the version it read, so a stale write can be refused', async () => {
    await saveCollection(COLLECTION);
    expect((apiSend.mock.calls[0][2] as Collection).version).toBe(3);
  });

  it('DELETEs /v1/collections/:id', async () => {
    await deleteCollection('c1');
    expect(apiDelete).toHaveBeenCalledWith('/v1/collections/c1');
  });

  it('escapes an id in every path segment it builds', async () => {
    const id = 'a/b c?d';
    await getCollection(id);
    await saveCollection({ ...COLLECTION, id });
    await deleteCollection(id);
    expect(apiGetOrNull.mock.calls[0][0]).toBe('/v1/collections/a%2Fb%20c%3Fd');
    expect(apiSend.mock.calls[0][1]).toBe('/v1/collections/a%2Fb%20c%3Fd');
    expect(apiDelete.mock.calls[0][0]).toBe('/v1/collections/a%2Fb%20c%3Fd');
    await listCollections(id);
    expect(apiGet.mock.calls[0][0]).toBe('/v1/matters/a%2Fb%20c%3Fd/collections');
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a collection the server does not have', async () => {
    expect(await getCollection('nope')).toBeNull();
  });

  it('propagates a 500 from a read rather than swallowing it into null', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    apiGetOrNull.mockRejectedValue(boom);
    await expect(getCollection('c1')).rejects.toBe(boom);
  });

  it('propagates a 500 from the list rather than answering with no collections', async () => {
    // "This matter has no collections" and "the server is broken" look
    // identical on screen, and the first is a fact a reader would act on.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    apiGet.mockRejectedValue(boom);
    await expect(listCollections('m1')).rejects.toBe(boom);
  });

  it('propagates a conflict from a save rather than reporting it as written', async () => {
    const stale = new ModelError('This was changed since you opened it.', 'conflict', 409);
    apiSend.mockRejectedValue(stale);
    await expect(saveCollection(COLLECTION)).rejects.toBe(stale);
  });

  it('resolves quietly when the collection to delete does not exist', async () => {
    // KEPT from the IndexedDB version: `db.delete` on a missing key always
    // resolved, and the caller asked for the collection to be gone.
    apiDelete.mockRejectedValue(new ModelError('There is no such collection.', 'not_found', 404));
    await expect(deleteCollection('gone')).resolves.toBeUndefined();
  });

  it('propagates any other delete failure', async () => {
    const denied = new ModelError('This needs a LexPrompt role.', 'not_permitted', 403);
    apiDelete.mockRejectedValue(denied);
    await expect(deleteCollection('c1')).rejects.toBe(denied);
  });
});
