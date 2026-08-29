import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';

/**
 * The matters repository, now a TRANSPORT.
 *
 * What this file used to assert — the sort, the `_seq` tiebreak, the delete
 * cascade — is not gone; it moved to `apps/api/test/matters.pg.test.ts`,
 * where a real Postgres can prove it rather than a fake IndexedDB. Twelve
 * assertions across eight cases moved; the `newMatter` case below is kept
 * VERBATIM, because a pure-client function has no business changing when its
 * neighbours' storage does, and its needing no edit is itself the evidence
 * that R3's seam held for it.
 *
 * What stays here is what the browser still owns: which request each export
 * makes, and — the one that matters — that a failure stays a failure. A
 * `getMatter` that returned `null` on a 500 would render "no such matter"
 * over a broken server, which is CLAUDE.md's founding defect at the new
 * transport.
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

const { listMatters, getMatter, saveMatter, newMatter, deleteMatter } = await import('./matters');

const MATTER = {
  id: 'm1', name: 'Acme Merger', ownerId: 'u1',
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, version: 3,
};

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue([]);
  apiGetOrNull.mockReset().mockResolvedValue(null);
  apiSend.mockReset().mockResolvedValue(MATTER);
  apiDelete.mockReset().mockResolvedValue(undefined);
});

describe('newMatter', () => {
  // KEPT VERBATIM from the IndexedDB version of this file. It is still pure,
  // still client-side, and still mints a `uid()`.
  it('creates a matter with the given owner', () => {
    const m = newMatter('Acme Merger', 'owner-1');
    expect(m.name).toBe('Acme Merger');
    expect(m.ownerId).toBe('owner-1');
    expect(m.id).toBeTruthy();
    expect(m.createdAt).toBeGreaterThan(0);
    expect(m.updatedAt).toBeGreaterThan(0);
  });

  it('mints no version, because a new matter has none to state', () => {
    // The absence is the claim "I believe this is a create" — a create that
    // carried a version would be a stale write dressed as a new record.
    expect('version' in newMatter('M', 'owner-1')).toBe(false);
  });
});

describe('the requests each export makes', () => {
  it('lists from /v1/matters and returns the server order untouched', async () => {
    const list = [{ ...MATTER, id: 'b' }, { ...MATTER, id: 'a' }];
    apiGet.mockResolvedValue(list);
    expect((await listMatters()).map(m => m.id)).toEqual(['b', 'a']);
    expect(apiGet).toHaveBeenCalledWith('/v1/matters');
  });

  it('reads one from /v1/matters/:id', async () => {
    apiGetOrNull.mockResolvedValue(MATTER);
    expect(await getMatter('m1')).toEqual(MATTER);
    expect(apiGetOrNull).toHaveBeenCalledWith('/v1/matters/m1');
  });

  it('PUTs the WHOLE record to /v1/matters/:id and returns what the server saved', async () => {
    const saved = { ...MATTER, name: 'Renamed', version: 4 };
    apiSend.mockResolvedValue(saved);
    expect(await saveMatter({ ...MATTER, name: 'Renamed' })).toEqual(saved);
    expect(apiSend).toHaveBeenCalledWith(
      'PUT', '/v1/matters/m1', { ...MATTER, name: 'Renamed' },
    );
  });

  it('sends the version it read, so a stale write can be refused', async () => {
    await saveMatter(MATTER);
    expect((apiSend.mock.calls[0][2] as { version?: number }).version).toBe(3);
  });

  it('DELETEs /v1/matters/:id', async () => {
    await deleteMatter('m1');
    expect(apiDelete).toHaveBeenCalledWith('/v1/matters/m1');
  });

  it('escapes an id in every path segment it builds', async () => {
    const id = 'a/b c?d';
    await getMatter(id);
    await saveMatter({ ...MATTER, id });
    await deleteMatter(id);
    for (const call of [apiGetOrNull.mock.calls[0], apiSend.mock.calls[0].slice(1), apiDelete.mock.calls[0]]) {
      expect(call[0]).toBe('/v1/matters/a%2Fb%20c%3Fd');
    }
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a matter the server does not have', async () => {
    apiGetOrNull.mockResolvedValue(null);
    expect(await getMatter('nope')).toBeNull();
  });

  it('propagates a ModelError from a read rather than swallowing it into null', async () => {
    // THE ONE THAT MATTERS. `getMatter` answering `null` over a 500 would
    // render "no such matter" for a server that is simply broken, and the
    // reader would act on it.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    apiGetOrNull.mockRejectedValue(boom);
    await expect(getMatter('m1')).rejects.toBe(boom);
  });

  it('propagates a ModelError from the list rather than answering with no matters', async () => {
    const denied = new ModelError('This needs a LexPrompt role.', 'not_permitted', 403);
    apiGet.mockRejectedValue(denied);
    await expect(listMatters()).rejects.toBe(denied);
  });

  it('propagates a conflict from a save rather than reporting it as written', async () => {
    const stale = new ModelError('This was changed since you opened it.', 'conflict', 409);
    apiSend.mockRejectedValue(stale);
    await expect(saveMatter(MATTER)).rejects.toBe(stale);
  });

  it('resolves quietly when the matter does not exist', async () => {
    // KEPT from the IndexedDB version, and still true: the caller asked for
    // the matter to be gone, and it is gone. The ROUTE still answers 404,
    // because a delete that deleted nothing must not claim otherwise; the
    // two statements live at different layers on purpose.
    apiDelete.mockRejectedValue(new ModelError('There is no such matter.', 'not_found', 404));
    await expect(deleteMatter('does-not-exist')).resolves.toBeUndefined();
  });

  it('propagates any other delete failure, so the UI never navigates away from a live matter', async () => {
    const denied = new ModelError('This needs a LexPrompt role.', 'not_permitted', 403);
    apiDelete.mockRejectedValue(denied);
    await expect(deleteMatter('m1')).rejects.toBe(denied);
  });
});
