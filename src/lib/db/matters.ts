import { ModelError } from '@lexprompt/core';
import { apiDelete, apiGet, apiGetOrNull, apiSend } from '../api/client';
import type { Matter } from '../../types';
import { uid } from '../uid';

/**
 * The matters repository — an HTTP client over `apps/api` since Stage 2.
 *
 * The file is still `src/lib/db/matters.ts` and every export still has the
 * name, the parameters and the return type it had when this read IndexedDB.
 * That is not inertia: the nine repositories were made Promise-returning in
 * sub-project A precisely so a storage swap would not touch a caller (R3),
 * and keeping the path and the signatures is what makes "no caller changed"
 * a claim a reader can check against one diff rather than take on trust.
 *
 * What moved OUT of this file is everything the browser no longer owns —
 * the `_seq` tiebreak, the sort, and the delete cascade. They did not
 * disappear; they are `matter.seq`, an `order by`, and `on delete cascade`
 * in `002_records.sql`, where a real database can enforce them and
 * `matters.pg.test.ts` can prove it. What stays here is the transport, and
 * the one rule the transport must not get wrong: **a failure is a failure,
 * never an empty result.** `getMatter` returns `null` for a 404 and for
 * nothing else; a 500, a 401 or an unreachable server rejects, so App.tsx's
 * load path renders `describeLoadError`'s message instead of "no matters
 * yet" (CLAUDE.md's founding rule, at its new failure surface).
 *
 * `encodeURIComponent` on every id segment, without exception. `uid()` is
 * base36 so nothing it mints needs escaping today, but an id that reached a
 * path unescaped is a defect nobody should have to think about twice.
 */

export function newMatter(name: string, ownerId: string): Matter {
  const now = Date.now();
  return {
    id: uid(),
    name,
    ownerId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Most recently updated first; tiebreak on write sequence descending, so
 *  the matter saved most recently wins a same-millisecond collision. The
 *  order is the server's (`order by updated_at desc, seq desc`) and is not
 *  re-derived here — two sorts that must agree is this project's most
 *  repeated defect. */
export async function listMatters(): Promise<Matter[]> {
  return apiGet<Matter[]>('/v1/matters');
}

/** `null` for "there is no such matter", and ONLY for that. Every other
 *  failure rejects. */
export async function getMatter(id: string): Promise<Matter | null> {
  return apiGetOrNull<Matter>(`/v1/matters/${encodeURIComponent(id)}`);
}

/**
 * Still returns the SAVED record, and the caller still renders from it and
 * from nothing else (await-then-apply). What changed is which store
 * confirmed the write — and that a stale write is now REFUSED rather than
 * applied: the returned record carries the `version` the next save must
 * state, and a save whose version no longer matches rejects with a
 * `conflict` `ModelError` saying so.
 */
export async function saveMatter(m: Matter): Promise<Matter> {
  return apiSend<Matter>('PUT', `/v1/matters/${encodeURIComponent(m.id)}`, m);
}

/**
 * Deletes a matter and cascades to its documents, their blobs, its reviews
 * and its collections — server-side now, in one transaction, so a failure
 * part-way cannot leave orphans behind.
 *
 * A 404 RESOLVES, and that is the seam holding rather than a swallowed
 * error. The route answers 404 because a DELETE that deleted nothing must
 * not claim it deleted something; this repository's published contract, from
 * the day it was IndexedDB, is that deleting a matter that is not there is
 * not a failure — the caller asked for it to be gone and it is gone. Both
 * statements are true at once, and each belongs at its own layer.
 *
 * Every OTHER failure rejects. A 403, a 500 or an unreachable server must
 * never reach App.tsx as a successful delete, because the next thing it does
 * is navigate away from the matter.
 */
export async function deleteMatter(id: string): Promise<void> {
  try {
    await apiDelete(`/v1/matters/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}
