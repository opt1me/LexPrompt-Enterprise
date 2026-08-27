import { getDb } from './open';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import type { Matter } from '../../types';
import { uid } from '../uid';

/** A matter record as it actually sits in IndexedDB: the public `Matter`
 *  shape plus a write sequence number. `_seq` exists to break ties when two
 *  saves land in the same millisecond (`Date.now()` resolution) — mirrors
 *  `playbooks.ts`'s `StoredPlaybook`. Never appears on a `Matter` returned
 *  to callers. */
interface StoredMatter extends Matter {
  _seq: number;
}

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

/** Most recently updated first; tiebreak on write sequence descending so the
 *  matter saved most recently wins a same-millisecond collision. */
export async function listMatters(): Promise<Matter[]> {
  const db = await getDb();
  const raw = (await db.getAll(STORES.matters)) as StoredMatter[];
  const entries = raw.map(r => ({ matter: stripSeq(r), seq: seqOf(r) }));
  entries.sort((a, b) => {
    const diff = b.matter.updatedAt - a.matter.updatedAt;
    return diff !== 0 ? diff : b.seq - a.seq;
  });
  return entries.map(e => e.matter);
}

function stripSeq(record: StoredMatter): Matter {
  const { _seq, ...matter } = record;
  void _seq;
  return matter;
}

export async function getMatter(id: string): Promise<Matter | null> {
  const db = await getDb();
  const found = (await db.get(STORES.matters, id)) as StoredMatter | undefined;
  return found ? stripSeq(found) : null;
}

export async function saveMatter(m: Matter): Promise<Matter> {
  const db = await getDb();
  const saved: Matter = { ...m, updatedAt: Date.now() };
  // The read (current max _seq) and the write share ONE readwrite
  // transaction, so two concurrent saveMatter calls can never both read the
  // same max before either has written theirs — the race that would let
  // concurrent saves mis-order a same-millisecond tie. Nothing non-IDB is
  // awaited between the getAll and the put, which is what keeps IndexedDB
  // from auto-committing the transaction early. Mirrors playbooks.ts's
  // savePlaybook exactly.
  const tx = db.transaction(STORES.matters, 'readwrite');
  const seq = await nextSeq(tx.store);
  const record: StoredMatter = { ...saved, _seq: seq };
  await tx.store.put(record);
  await tx.done;
  return saved;
}

/** Deletes a matter and cascades to its documents, their blobs, its
 *  reviews, and its collections, all inside one readwrite transaction so a
 *  failure part-way cannot leave orphans behind (an orphaned blob makes the
 *  app's privacy claim — "deleting a matter deletes its documents" — false).
 *
 *  Everything this needs from the store must be resolved *before* any
 *  delete request is issued, and every awaited step below must itself be an
 *  IDB request (never a bare Promise.resolve/setTimeout/etc.) — awaiting
 *  anything else inside an IDB transaction lets it auto-close early. */
export async function deleteMatter(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    [STORES.matters, STORES.documents, STORES.blobs, STORES.reviews, STORES.collections],
    'readwrite',
  );

  const documentsStore = tx.objectStore(STORES.documents);
  const reviewsStore = tx.objectStore(STORES.reviews);
  const blobsStore = tx.objectStore(STORES.blobs);
  const mattersStore = tx.objectStore(STORES.matters);
  const collectionsStore = tx.objectStore(STORES.collections);

  const [docs, reviews, collections] = await Promise.all([
    documentsStore.index('byMatter').getAll(id),
    reviewsStore.index('byMatter').getAll(id),
    collectionsStore.index('byMatter').getAll(id),
  ]);

  await Promise.all([
    mattersStore.delete(id),
    ...docs.map(d => documentsStore.delete(d.id)),
    ...docs.map(d => blobsStore.delete(d.id)),
    ...reviews.map(r => reviewsStore.delete(r.id)),
    ...collections.map(c => collectionsStore.delete(c.id)),
  ]);

  await tx.done;
}
