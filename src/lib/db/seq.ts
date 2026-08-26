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
 *  guards. */

export function seqOf(record: { _seq?: unknown } | null | undefined): number {
  return typeof record?._seq === 'number' ? record._seq : 0;
}

export async function nextSeq(store: { getAll(): Promise<unknown[]> }): Promise<number> {
  const existing = await store.getAll();
  return existing.reduce<number>((max, r) => Math.max(max, seqOf(r as { _seq?: unknown })), 0) + 1;
}
