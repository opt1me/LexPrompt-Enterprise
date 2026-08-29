import { getDb } from '../lib/db/open';
import { STORES } from '../lib/db/schema';
import { migratePlaybookRecord, migrateVersionRecord } from '../lib/db/playbookMigration';
import type { Playbook, PlaybookVersion } from '../types';

/**
 * IndexedDB-backed stand-ins for the four playbook READS, for the two suites
 * that test the startup migration.
 *
 * ## Why this exists, and the finding underneath it
 *
 * `migrateIfNeeded`'s pre-D conversion writes to IndexedDB — that is what it
 * is for, and Stage 2 has not changed it. But Stage 2 Task 13 made
 * `listPlaybooks`/`getPlaybook`/`getPlaybookContent`/`listVersions` HTTP
 * clients, so those two things now read and write DIFFERENT STORES. The
 * migration converts records the app no longer looks at.
 *
 * That is a real gap and it is **Task 23's** (the migration story: what
 * happens to a browser that already holds v1 templates when the app starts
 * reading from a server). Nothing here fixes it. What this module does is
 * stop the migration's own tests from silently changing what they assert:
 * pointing them at the server's repositories would have made them fail for a
 * reason that has nothing to do with the migration, and mocking those
 * repositories to return canned values would have made them pass while
 * proving nothing about what the migration wrote.
 *
 * So the assertions stay exactly as they were and read the store the
 * migration actually writes. Repair-on-read is applied here for the same
 * reason `playbooks.ts` applied it — the migration's whole subject is
 * records that need repairing.
 *
 * Extracted rather than copied into both suites: two copies of a store read
 * is where this project's sibling drift starts, and the rule is "extract at
 * the second, not after the third".
 */
export function idbPlaybookReadsModule(): Record<string, unknown> {
  return {
    async listPlaybooks(): Promise<Playbook[]> {
      const db = await getDb();
      const raw = await db.getAll(STORES.playbooks);
      const entries = raw.map(r => migratePlaybookRecord(r).playbook);
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getPlaybook(id: string): Promise<Playbook | null> {
      const db = await getDb();
      const raw = await db.get(STORES.playbooks, id);
      return raw ? migratePlaybookRecord(raw).playbook : null;
    },
    async getPlaybookContent(id: string): Promise<PlaybookVersion | null> {
      const db = await getDb();
      const raw = await db.get(STORES.playbooks, id);
      if (!raw) return null;
      const { playbook } = migratePlaybookRecord(raw);
      if (!playbook.currentVersionId) return null;
      const version = await db.get(STORES.playbookVersions, playbook.currentVersionId);
      return version ? migrateVersionRecord(version) : null;
    },
  };
}

/** The `playbookVersions` half. Newest first, as the route returns them. */
export function idbVersionReadsModule(): Record<string, unknown> {
  return {
    async getVersion(id: string): Promise<PlaybookVersion | null> {
      const db = await getDb();
      return (await db.get(STORES.playbookVersions, id)) ?? null;
    },
    async listVersions(playbookId: string): Promise<PlaybookVersion[]> {
      const db = await getDb();
      const all = await db.getAllFromIndex(STORES.playbookVersions, 'byPlaybook', playbookId);
      return all.sort((a, b) => b.version - a.version);
    },
  };
}
