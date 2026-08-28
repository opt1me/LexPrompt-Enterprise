import { describe, it, expect } from 'vitest';
import { DB_NAME, DB_VERSION, STORES } from './schema';

describe('schema', () => {
  it('names every store the sub-project needs', () => {
    expect(Object.values(STORES).sort()).toEqual(
      ['blobs', 'changesets', 'collections', 'documents', 'matters', 'playbooks', 'playbookVersions', 'profile', 'reviews'].sort(),
    );
  });

  it('does not include settings — they stay in localStorage (ruling R6)', () => {
    expect(Object.values(STORES)).not.toContain('settings');
  });

  it('has a stable name and a positive integer version', () => {
    expect(DB_NAME).toBe('lexprompt');
    expect(Number.isInteger(DB_VERSION)).toBe(true);
    expect(DB_VERSION).toBeGreaterThan(0);
  });
});
