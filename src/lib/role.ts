import { useEffect, useState } from 'react';
import { ROLES, type Role } from '@lexprompt/core';
import { getProfile, getCachedRole } from './db/profile';

/**
 * The signed-in user's role, read from whatever `getProfile()` has already
 * resolved — never a default. `undefined` before the first successful
 * resolution, and `undefined` again if it failed: a default role would be a
 * permission GRANTED by a loading state, and the only safe default for a
 * permission is "not yet known", never the lowest role. A partner rendered
 * as `'reviewer'` for one frame would see Publish disabled and could click
 * something else before it corrected itself — a wrong answer delivered with
 * exactly enough confidence to be believed.
 *
 * Reads a snapshot; anything that must react to the role becoming known
 * (or failing to) should use `useRole()` instead.
 */
export function currentRole(): Role | undefined {
  return getCachedRole();
}

export type RoleState =
  | { status: 'unknown' }
  | { status: 'known'; role: Role }
  | { status: 'failed'; error: unknown };

/**
 * The reactive form of `currentRole()`, with THREE states rather than two —
 * the same "loading is not empty" rule this project applies to every other
 * load path, here applied to a permission. `unknown` while `/v1/me` has not
 * yet answered (or has not yet been asked); `known` once it has; `failed`
 * when the check itself could not complete, carrying the error so a caller
 * that needs to know WHY — `App.tsx`'s access gate, chiefly — can read
 * `ModelError.code` off it rather than re-deriving a second classification.
 *
 * Calls `getProfile()` itself rather than requiring a caller to have already
 * done so: `getProfile()`'s own in-flight/cache memoisation means this never
 * costs a second request when the header effect (or another `useRole()`
 * instance elsewhere on the page) already asked.
 */
export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>(() => {
    const role = getCachedRole();
    return role ? { status: 'known', role } : { status: 'unknown' };
  });

  useEffect(() => {
    let live = true;
    getProfile()
      .then(() => {
        if (!live) return;
        const role = getCachedRole();
        setState(role ? { status: 'known', role } : { status: 'unknown' });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({ status: 'failed', error });
      });
    return () => { live = false; };
  }, []);

  return state;
}

/**
 * Whether `role` clears the bar §7 sets for publishing: the partner role, or
 * anything ranked at or above it. Derived from `ROLES`'s own order
 * (`reviewer, partner, admin`) rather than a second `Record<Role, number>` —
 * `apps/api/src/auth/roles.ts`'s `ROLE_RANK` already IS that ranking, on the
 * other side of a wire boundary the browser cannot import across, and a
 * second copy of an ordering that must agree with it is this project's most
 * repeated defect. Reading `ROLES.indexOf` instead means there is exactly
 * one ordering, shared by both sides via `@lexprompt/core`, not two that
 * happen to agree today.
 *
 * This is the courtesy half only (CLAUDE.md / §7): `requireRole.ts` on the
 * server is the actual control, and refuses the same way regardless of
 * anything this function ever returns.
 */
export function canPublish(role: Role | undefined): boolean {
  return role !== undefined && ROLES.indexOf(role) >= ROLES.indexOf('partner');
}

/** The sentence every disabled partner-only control shows. One string, so
 *  the UI gate and its wording cannot drift between the two places it is
 *  used (the playbook Publish button, the changeset Publish button). */
export const PUBLISH_NEEDS_PARTNER_TITLE =
  'Publishing needs the partner role. Ask a colleague with that role, or an administrator, to publish this.';
