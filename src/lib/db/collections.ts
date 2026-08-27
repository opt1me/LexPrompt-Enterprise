import { getDb } from './open';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import type { Collection } from '../../types';
import { uid } from '../uid';

/** A collection record as it actually sits in IndexedDB: the public
 *  `Collection` shape plus a write sequence number. `_seq` exists to break
 *  ties when two saves land in the same millisecond (`Date.now()`
 *  resolution) — mirrors `matters.ts`'s `StoredMatter` /
 *  `playbooks.ts`'s `StoredPlaybook`. Never appears on a `Collection`
 *  returned to callers. */
interface StoredCollection extends Collection {
  _seq: number;
}

function stripSeq(record: StoredCollection): Collection {
  const { _seq, ...collection } = record;
  void _seq;
  return collection;
}

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
 *  sequence descending so the collection saved most recently wins a
 *  same-millisecond collision — same reasoning as `listMatters`.
 *
 *  Rejects (rather than resolving to `[]`) on a genuine database failure: a
 *  caller must be able to tell "no collections yet" apart from "the database
 *  failed". Nothing here catches errors from `getDb()`/`getAllFromIndex`, so
 *  they propagate as-is. */
export async function listCollections(matterId: string): Promise<Collection[]> {
  const db = await getDb();
  const raw = (await db.getAllFromIndex(STORES.collections, 'byMatter', matterId)) as StoredCollection[];
  const entries = raw.map(r => ({ collection: stripSeq(r), seq: seqOf(r) }));
  entries.sort((a, b) => {
    const diff = b.collection.createdAt - a.collection.createdAt;
    return diff !== 0 ? diff : b.seq - a.seq;
  });
  return entries.map(e => e.collection);
}

export async function getCollection(id: string): Promise<Collection | null> {
  const db = await getDb();
  const found = (await db.get(STORES.collections, id)) as StoredCollection | undefined;
  return found ? stripSeq(found) : null;
}

export async function saveCollection(c: Collection): Promise<Collection> {
  const db = await getDb();
  // The read (current max _seq) and the write share ONE readwrite
  // transaction, so two concurrent saveCollection calls can never both read
  // the same max before either has written theirs — the race that would let
  // concurrent saves mis-order a same-millisecond tie. Nothing non-IDB is
  // awaited between the getAll and the put, which is what keeps IndexedDB
  // from auto-committing the transaction early. Mirrors
  // matters.ts/playbooks.ts's save functions exactly.
  const tx = db.transaction(STORES.collections, 'readwrite');
  const seq = await nextSeq(tx.store);
  const record: StoredCollection = { ...c, _seq: seq };
  await tx.store.put(record);
  await tx.done;
  return c;
}

/** Deletes only the collection record. Member documents are untouched —
 *  clearing their `role`/`collectionId` is a matter-level operation over
 *  documents (Task 7's ungroup), not something this store-scoped delete
 *  does on their behalf. */
export async function deleteCollection(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORES.collections, id);
}
