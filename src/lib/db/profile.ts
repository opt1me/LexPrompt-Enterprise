import { getDb } from './open';
import { PROFILE_KEY, STORES } from './schema';
import type { UserProfile } from '../../types';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultProfile(): UserProfile {
  return {
    id: uid(),
    name: 'Me',
    initials: 'ME',
  };
}

/** Returns the one local profile, creating and persisting a sensible
 *  default on first call. Nothing in the app is ever blocked on the user
 *  naming themselves first. */
export async function getProfile(): Promise<UserProfile> {
  const db = await getDb();
  const existing = await db.get(STORES.profile, PROFILE_KEY);
  if (existing) return existing;
  const created = defaultProfile();
  await db.put(STORES.profile, created, PROFILE_KEY);
  return created;
}

export async function saveProfile(p: UserProfile): Promise<void> {
  const db = await getDb();
  await db.put(STORES.profile, p, PROFILE_KEY);
}
