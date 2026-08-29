import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';

/**
 * The profile repository, now the signed-in `app_user` — the one Stage 2
 * change to a repository that is not merely a transport swap. `getProfile()`
 * used to mint a default person on first call so nothing was ever blocked on
 * a user naming themselves; it must never do that again, because there is a
 * real person behind a real token from this stage on, and a browser that
 * invents one while a server knows one is the exact drift this stage exists
 * to end (Task 9's `ownerId`, one layer down, for the same reason).
 */

const apiGet = vi.fn();
const apiSend = vi.fn();

vi.mock('../api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiSend: (...args: unknown[]) => apiSend(...args),
}));

const { getProfile, saveProfile, forgetProfile, getCachedRole } = await import('./profile');

const ME = {
  id: 'uuid-1', issuer: 'iss', subject: 'sub', displayName: 'Ada Lovelace',
  initials: 'AL', role: 'partner' as const, workspaceId: 'ws-1',
};

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
  forgetProfile();
});

describe('getProfile', () => {
  it('returns the signed-in user, with the app_user id', async () => {
    apiGet.mockResolvedValue(ME);
    expect(await getProfile()).toEqual({ id: 'uuid-1', name: 'Ada Lovelace', initials: 'AL' });
    expect(apiGet).toHaveBeenCalledWith('/v1/me');
  });

  it('NEVER invents a profile when the request fails', async () => {
    // The old behaviour minted one, deliberately, so nothing was blocked on a
    // user naming themselves. Inventing one now would invent an
    // ATTRIBUTION: `ownerId`, `addedByUserId`, `Verification.byUserId` all
    // come from here, and a made-up id in any of them is a record claiming a
    // person who does not exist.
    const boom = new ModelError('LexPrompt could not reach your firm\'s service.', 'network', 0);
    apiGet.mockRejectedValue(boom);
    await expect(getProfile()).rejects.toBe(boom);
  });

  it('makes one request for concurrent callers, and one more after a failure', async () => {
    let resolveFirst!: (v: typeof ME) => void;
    apiGet.mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }));
    const p1 = getProfile();
    const p2 = getProfile();
    resolveFirst(ME);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('does not poison every later call after one rejection', async () => {
    // The `creating`/`inFlight` promise is cleared on failure — the same
    // rule `open.ts`'s `getDb` follows — so a single network blip does not
    // make the app believe forever that nobody is signed in.
    apiGet.mockRejectedValueOnce(new ModelError('boom', 'network', 0));
    await expect(getProfile()).rejects.toThrow('boom');
    apiGet.mockResolvedValueOnce(ME);
    expect(await getProfile()).toEqual({ id: 'uuid-1', name: 'Ada Lovelace', initials: 'AL' });
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('caches the resolved profile: a second call makes no second request', async () => {
    apiGet.mockResolvedValue(ME);
    await getProfile();
    await getProfile();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('refreshes after saveProfile, so the header shows the new name without a reload', async () => {
    apiGet.mockResolvedValue(ME);
    await getProfile();
    apiSend.mockResolvedValue({ ...ME, displayName: 'Ada L', initials: 'AL' });
    await saveProfile({ id: ME.id, name: 'Ada L', initials: 'AL' });
    expect(await getProfile()).toEqual({ id: 'uuid-1', name: 'Ada L', initials: 'AL' });
    // Still one GET — the save itself supplied the fresh record, so a third
    // repeat round trip would be exactly the cost the cache exists to avoid.
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe('saveProfile', () => {
  it('sends only the display name', async () => {
    apiSend.mockResolvedValue(ME);
    await saveProfile({ id: 'uuid-1', name: 'Ada L', initials: 'AL' });
    expect(apiSend).toHaveBeenCalledWith('PUT', '/v1/me', { displayName: 'Ada L' });
    // Not `{ id, name, initials }`: a route that accepted an id would accept
    // a request to become somebody else, and one that accepted initials
    // would let the two disagree.
  });

  it('propagates a failed save rather than reporting it as written', async () => {
    const boom = new ModelError('A display name cannot be empty.', 'conflict', 400);
    apiSend.mockRejectedValue(boom);
    await expect(saveProfile({ id: 'uuid-1', name: '', initials: 'AL' })).rejects.toBe(boom);
  });
});

describe('forgetProfile', () => {
  it('clears the cache and the cached role', async () => {
    apiGet.mockResolvedValue(ME);
    await getProfile();
    expect(getCachedRole()).toBe('partner');
    forgetProfile();
    expect(getCachedRole()).toBeUndefined();
    apiGet.mockResolvedValue({ ...ME, displayName: 'Someone Else' });
    await getProfile();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
