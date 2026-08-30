import { ModelError, uid } from '@lexprompt/core';
import { apiDelete, apiGet, apiGetOrNull, apiSend } from '../api/client';
import type { Collection } from '../../types';

/**
 * The collections repository — an HTTP client over `apps/api` since Stage 2.
 *
 * Same file, same exports, same signatures (R3). What moved OUT is the
 * `_seq` tiebreak and the sort: they are `collection.seq` and an
 * `order by created_at desc, seq desc` in `apps/api/src/routes/collections.ts`,
 * where a real database can do the ordering and `collections.pg.test.ts` can
 * prove it. `StoredCollection`/`stripSeq` are gone with them — `_seq` was
 * only ever the shape a record took inside IndexedDB.
 *
 * What stays here is the transport and the rule it must not get wrong:
 * **a failure is a failure, never an empty result.** `getCollection` answers
 * `null` for a 404 and for nothing else.
 *
 * `variesDocumentIds` is sent and read back in the order it is given, and
 * nothing in this file sorts it. `orderedMembers` is the only place
 * collection reading order is decided and `documentDate` never governs it
 * (R-C3) — a second sort here would be exactly the sibling drift that rule
 * exists to prevent.
 */

export function newCollection(
  matterId: string,
  name: string,
  baseDocumentId: string,
  userId: string,
): Collection {
  return {
    id: uid(),
    matterId,
    name,
    baseDocumentId,
    variesDocumentIds: [],
    createdAt: Date.now(),
    createdByUserId: userId,
  };
}

/** A matter's collections, most recently created first; tiebreak on write
 *  sequence descending, so the collection saved most recently wins a
 *  same-millisecond collision. The order is the server's and is not
 *  re-derived here.
 *
 *  Rejects (rather than resolving to `[]`) on any failure: a caller must be
 *  able to tell "no collections yet" apart from "the server failed". */
export async function listCollections(matterId: string): Promise<Collection[]> {
  return apiGet<Collection[]>(`/v1/matters/${encodeURIComponent(matterId)}/collections`);
}

/** `null` for "there is no such collection", and ONLY for that. */
export async function getCollection(id: string): Promise<Collection | null> {
  return apiGetOrNull<Collection>(`/v1/collections/${encodeURIComponent(id)}`);
}

/**
 * Still returns the SAVED record, and the caller still renders from it and
 * from nothing else (await-then-apply). What changed is which store
 * confirmed the write — and that the returned record carries the `version`
 * the next save must state, so a save made against a collection somebody
 * else has since changed is REFUSED with a `conflict` `ModelError` rather
 * than applied over their work.
 */
export async function saveCollection(c: Collection): Promise<Collection> {
  return apiSend<Collection>('PUT', `/v1/collections/${encodeURIComponent(c.id)}`, c);
}

/** Deletes only the collection record. Member documents are untouched —
 *  clearing their `role`/`collectionId` is a matter-level operation over
 *  documents (the ungroup path), not something this record-scoped delete
 *  does on their behalf. Unchanged by the move: the route deletes one row
 *  and `document.collection_id` deliberately carries no foreign key, so
 *  nothing cascades from here.
 *
 *  A 404 RESOLVES — the caller asked for the collection to be gone and it is
 *  gone, which is what `db.delete` on a missing key always did. Every other
 *  failure rejects. */
export async function deleteCollection(id: string): Promise<void> {
  try {
    await apiDelete(`/v1/collections/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}
