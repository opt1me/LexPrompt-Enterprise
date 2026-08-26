import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProfile, saveProfile } from './profile';
import { getDb, closeDb } from './open';
import { PROFILE_KEY, STORES } from './schema';

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.profile);
});

afterEach(() => closeDb());

describe('profile', () => {
  it('creates and persists a default profile on first call', async () => {
    const p = await getProfile();
    expect(p.id).toBeTruthy();
    expect(p.name).toBeTruthy();
    expect(p.initials).toBeTruthy();

    const db = await getDb();
    const stored = await db.get(STORES.profile, PROFILE_KEY);
    expect(stored).toEqual(p);
  });

  it('returns the same profile on subsequent calls rather than recreating it', async () => {
    const first = await getProfile();
    const second = await getProfile();
    expect(second).toEqual(first);
  });

  it('saves and reads back edits', async () => {
    const p = await getProfile();
    await saveProfile({ ...p, name: 'Alex Gray', initials: 'AG' });
    const reloaded = await getProfile();
    expect(reloaded.name).toBe('Alex Gray');
    expect(reloaded.initials).toBe('AG');
    expect(reloaded.id).toBe(p.id);
  });

  it('two concurrent first calls resolve to the same profile, and only one is persisted', async () => {
    const [a, b] = await Promise.all([getProfile(), getProfile()]);
    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);

    const db = await getDb();
    const stored = await db.get(STORES.profile, PROFILE_KEY);
    expect(stored).toEqual(a);
  });
});
