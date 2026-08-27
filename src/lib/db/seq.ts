import type { IDBPObjectStore, StoreNames } from 'idb';
import type { LexPromptDB } from './schema';

/** Shared "next write-sequence number" allocator.
 *
 *  Several stores (`playbooks`, `matters`, `reviews`) sort primarily by a
 *  timestamp (`updatedAt`/`startedAt`) but need a deterministic tiebreak
 *  when two saves land in the same millisecond (`Date.now()` resolution).
 *  v1's localStorage array got that ordering for free from array position;
 *  IndexedDB's `getAll()` makes no such promise, so each record carries an
 *  explicit, persisted `_seq` counter instead, and this module is the one
 *  place that allocates it.
 *
 *  `nextSeq` MUST be called with the *store* handle of an already-open
 *  readwrite transaction (`tx.store` or `tx.objectStore(name)`), and its
 *  result MUST be used to `put()` a record back into that same transaction
 *  with nothing non-IDB awaited in between. That is what makes the
 *  read-current-max / write-new-max pair atomic: two concurrent savers can
 *  never both read the same max before either has written theirs, which is
 *  the race that would otherwise let a same-millisecond batch of saves
 *  collide on one `_seq` value. Awaiting anything else (a timer, a
 *  microtask chained off non-IDB work) between the read and the write lets
 *  IndexedDB auto-commit the transaction early and reopens exactly that
 *  race — see `savePlaybook`/`saveMatter`/`saveReview` for the callers this
 *  guards.
 *
 *  The comment above states the rule; `SeqStore` below is what actually
 *  enforces it. A widened structural type here (e.g. "anything with a
 *  zero-arg `getAll()`") would also accept a `db`-level convenience
 *  wrapper — `{ getAll: () => db.getAll(STORES.reviews) }` — which opens
 *  its *own* transaction, or a store pulled from an unrelated/'readonly'
 *  transaction. Either compiles, looks correct at the call site, and
 *  breaks the atomicity this function exists to guarantee — exactly the
 *  drift that produced two independently-wrong copies of this pattern
 *  before extraction. Pinning the parameter to the real `idb` object-store
 *  type, scoped to a single store and `'readwrite'` mode, makes passing
 *  any of those a compile error instead of a runtime race. */

/** An object store handle from an open `'readwrite'` transaction — i.e.
 *  exactly what `tx.store` / `tx.objectStore(name)` is typed as at this
 *  function's call sites. Deliberately not satisfiable by a `db`-level
 *  wrapper (missing `put`/`transaction`/etc.) or by a `'readonly'` store
 *  (wrong `Mode`), which is the whole point.
 *
 *  `TxStores` is a parameter rather than the single-store `[StoreName]` it
 *  started as because `publishAndPoint` allocates a `_seq` inside a
 *  transaction spanning BOTH `playbooks` and `playbookVersions` — the same
 *  widening `publishVersionIn` carries, and for the same reason. It
 *  defaults to `[StoreName]`, so the single-store call sites read
 *  unchanged, and it loosens nothing that matters: the mode and the
 *  "handle from an already-open transaction" shape are what enforce
 *  atomicity, not the arity of the store list. */
export type SeqStore<
  StoreName extends StoreNames<LexPromptDB> = StoreNames<LexPromptDB>,
  TxStores extends ArrayLike<StoreNames<LexPromptDB>> = [StoreName],
> = IDBPObjectStore<LexPromptDB, TxStores, StoreName, 'readwrite'>;

export function seqOf(record: { _seq?: unknown } | null | undefined): number {
  return typeof record?._seq === 'number' ? record._seq : 0;
}

export async function nextSeq<
  StoreName extends StoreNames<LexPromptDB>,
  TxStores extends ArrayLike<StoreNames<LexPromptDB>>,
>(
  store: SeqStore<StoreName, TxStores>,
): Promise<number> {
  const existing = await store.getAll();
  return existing.reduce<number>((max, r) => Math.max(max, seqOf(r as { _seq?: unknown })), 0) + 1;
}
