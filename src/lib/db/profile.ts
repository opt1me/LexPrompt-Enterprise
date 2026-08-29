import type { MeResponse, Role } from '@lexprompt/core';
import { apiGet, apiSend } from '../api/client';
import type { UserProfile } from '../../types';

/**
 * The one local profile becomes the signed-in `app_user` (Stage 2, §6.5).
 *
 * `getProfile()` no longer MINTS a person. The old implementation created a
 * default on first call — `{ id: uid(), name: 'Me', initials: 'ME' }` — so
 * nothing was blocked on a user naming themselves before the app was
 * useful. There is a real person behind a real token now, and a browser
 * that invents one while a server knows one is exactly the drift this
 * stage exists to end (Task 9 made `ownerId` server-authoritative for the
 * same reason; this does not re-litigate that). A minted id would go
 * straight into `ownerId`, `addedByUserId` and `Verification.byUserId` as
 * an attribution to somebody who does not exist — worse than an empty
 * field, because it reads as answered.
 *
 * `getProfile()` therefore resolves `GET /v1/me` and rejects with whatever
 * `ModelError` the request failed with. It does not swallow a failure into
 * a fallback profile: the write paths in `App.tsx` await this directly, and
 * a write that cannot say who made it must not happen.
 *
 * The in-flight memoisation the old `creating` promise provided survives
 * for the reason it existed: `getProfile()` is called from roughly a dozen
 * sites in `App.tsx`, several on write paths, and a round trip per call is
 * not a design. What replaces `creating` is a cache of the resolved
 * response, since there is no longer a creation to dedupe — only a read.
 * Cleared on failure, so one rejection does not poison every later call
 * (the same rule `open.ts`'s `getDb` follows); cleared by `saveProfile`, so
 * the header shows a renamed user without a reload; and exposed via
 * `forgetProfile()` for sign-out and for tests.
 */
let inFlight: Promise<UserProfile> | null = null;
let cached: UserProfile | null = null;
let cachedRole: Role | undefined;

function fromMe(me: MeResponse): UserProfile {
  return { id: me.id, name: me.displayName, initials: me.initials };
}

export async function getProfile(): Promise<UserProfile> {
  if (cached) return cached;
  inFlight ??= apiGet<MeResponse>('/v1/me')
    .then(me => {
      cachedRole = me.role;
      cached = fromMe(me);
      return cached;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Writes only the display name. `id` and `role` are not the user's to set
 * — the signature keeps taking a whole `UserProfile` because every caller
 * already has one, but the route ignores everything except `displayName`
 * and this never sends the rest: a route that accepted an id would accept
 * a request to become somebody else, and one that accepted initials would
 * let the two disagree.
 */
export async function saveProfile(p: UserProfile): Promise<void> {
  const me = await apiSend<MeResponse>('PUT', '/v1/me', { displayName: p.name });
  cachedRole = me.role;
  cached = fromMe(me);
}

/** Clears the cache. Called on sign-out and by tests — not by anything in
 *  a write path, which must never see a stale identity replaced silently
 *  mid-render. */
export function forgetProfile(): void {
  cached = null;
  inFlight = null;
  cachedRole = undefined;
}

/** The signed-in user's role, once `getProfile()` has resolved at least
 *  once. `undefined` before that — see `src/lib/role.ts`, which is the
 *  only other reader of this cache. */
export function getCachedRole(): Role | undefined {
  return cachedRole;
}
