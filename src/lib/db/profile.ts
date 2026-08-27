import { getDb } from './open';
import { PROFILE_KEY, STORES } from './schema';
import type { UserProfile } from '../../types';
import { uid } from '../uid';

function defaultProfile(): UserProfile {
  return {
    id: uid(),
    name: 'Me',
    initials: 'ME',
  };
}

// Two concurrent first-callers can both see the store empty and both mint a
// distinct default profile; without deduping, the last `put` wins the store
// but the loser is left holding an in-memory profile whose id was never
// persisted — a silent divergence that later shows up as an `ownerId` value
// nothing references. Memoising the in-flight creation so every concurrent
// caller awaits the same one closes that window. Cleared once the attempt
// settles (success or failure) — on failure so one rejection doesn't poison
// every future call (the same rule `open.ts`'s `getDb` follows), and on
// success too so a later call (e.g. after a test clears the store) does the
// real read instead of replaying a stale in-memory result.
let creating: Promise<UserProfile> | null = null;

/** Returns the one local profile, creating and persisting a sensible
 *  default on first call. Nothing in the app is ever blocked on the user
 *  naming themselves first. */
export async function getProfile(): Promise<UserProfile> {
  const db = await getDb();
  const existing = await db.get(STORES.profile, PROFILE_KEY);
  if (existing) return existing;

  if (!creating) {
    creating = (async () => {
      const created = defaultProfile();
      await db.put(STORES.profile, created, PROFILE_KEY);
      return created;
    })().finally(() => {
      creating = null;
    });
  }
  return creating;
}

export async function saveProfile(p: UserProfile): Promise<void> {
  const db = await getDb();
  await db.put(STORES.profile, p, PROFILE_KEY);
}
