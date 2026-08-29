import { apiGet, apiGetOrNull } from '../api/client';
import { migrateVersionRecord } from './playbookMigration';
import type { PlaybookVersion } from '../../types';

/**
 * Published playbook versions — a read-only HTTP client since Stage 2.
 *
 * ## What is gone from here, and why that is a finding
 *
 * `publishVersion` and `publishVersionIn` are no longer in this module.
 * Publishing is one route (`POST /v1/playbooks/:id/versions`) running one
 * Postgres transaction over both tables, so a browser-side "publish a
 * version" that did not also point the playbook at it would be the orphan
 * `publishAndPoint` exists to prevent, rebuilt across a network.
 *
 * `publishVersionIn` is the ONE export in this batch whose TYPE could not
 * survive: it took an `IDBPObjectStore` — a type from the storage layer this
 * stage removes — so no HTTP shape for it exists at all. Verified before
 * relying on it: nothing outside `src/lib/db/` imports it, so R3's seam held
 * for every CALLER and did not hold one level in, on an internal helper.
 * That distinction is the finding, and it is worth stating rather than
 * glossing: a seam that holds at the boundary can still be broken inside it.
 *
 * It has ONE remaining caller — `migrate.ts`'s startup conversion of pre-D
 * playbooks, which is IndexedDB-to-IndexedDB and stays so until Task 23
 * decides the migration's fate. So the function MOVED there rather than
 * being deleted: leaving it exported here would have meant this module
 * importing both `idb` and the HTTP client, and copying it into `migrate.ts`
 * would have been the sibling drift this project's own history is about.
 *
 * `getVersion` and `listVersions` keep their names, parameters and return
 * types exactly.
 */

/**
 * Repair-on-read, applied HERE too (Part 2A m8).
 *
 * `playbooks.ts` states "repair-on-read is KEPT" as a property of this
 * stage, and it was true of `getPlaybookContent` and of nothing in this
 * module — so the SAME stored version was migrated when read as a
 * playbook's current content and handed back raw when read through the
 * version list or by id. A pre-D record reaching a reader unmigrated is a
 * playbook rendered by the shape it had before the field it is being read
 * for existed; the two paths disagreeing about it is worse than either
 * answer, because which one a reader gets depends on which screen they came
 * from. Pre-existing (the IndexedDB module behaved the same way), and named
 * rather than left as a property that holds in one of two modules.
 */
const repaired = (v: PlaybookVersion): PlaybookVersion => migrateVersionRecord(v);

/** `null` for "there is no such version", and ONLY for that. A 500 rejects
 *  — a version read that answered `null` over a broken server would render
 *  a review's history as though the version it ran against had been
 *  deleted. */
export async function getVersion(id: string): Promise<PlaybookVersion | null> {
  const version = await apiGetOrNull<PlaybookVersion>(`/v1/versions/${encodeURIComponent(id)}`);
  return version ? repaired(version) : null;
}

/** Newest first. The order is the server's (`order by version_number desc`)
 *  and is not re-derived here. */
export async function listVersions(playbookId: string): Promise<PlaybookVersion[]> {
  const versions = await apiGet<PlaybookVersion[]>(
    `/v1/playbooks/${encodeURIComponent(playbookId)}/versions`);
  return versions.map(repaired);
}
