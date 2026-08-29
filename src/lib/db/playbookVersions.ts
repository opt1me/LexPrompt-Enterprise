import { apiGet, apiGetOrNull } from '../api/client';
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

/** `null` for "there is no such version", and ONLY for that. A 500 rejects
 *  — a version read that answered `null` over a broken server would render
 *  a review's history as though the version it ran against had been
 *  deleted. */
export async function getVersion(id: string): Promise<PlaybookVersion | null> {
  return apiGetOrNull<PlaybookVersion>(`/v1/versions/${encodeURIComponent(id)}`);
}

/** Newest first. The order is the server's (`order by version_number desc`)
 *  and is not re-derived here. */
export async function listVersions(playbookId: string): Promise<PlaybookVersion[]> {
  return apiGet<PlaybookVersion[]>(
    `/v1/playbooks/${encodeURIComponent(playbookId)}/versions`);
}
