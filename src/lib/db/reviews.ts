import { getDb } from './open';
import { debug } from '../debug';
import { STORES } from './schema';
import { nextSeq, seqOf } from './seq';
import type { Review } from '../../types';

/** A review record as it actually sits in IndexedDB: the public `Review`
 *  shape plus a write sequence number. `_seq` exists to break ties when two
 *  saves land in the same millisecond (`Date.now()` resolution) — mirrors
 *  `playbooks.ts`'s `StoredPlaybook` / `matters.ts`'s `StoredMatter`. Never
 *  appears on a `Review` returned to callers. */
interface StoredReview extends Review {
  _seq: number;
}

function stripSeq(record: StoredReview): Review {
  const { _seq, ...review } = record;
  void _seq;
  return review;
}

/** All reviews for a matter, most recently started first; tiebreak on write
 *  sequence descending so the review saved most recently wins a
 *  same-millisecond collision (mirrors `matters.ts`/`playbooks.ts`).
 *
 *  Rejects (rather than resolving to `[]`) on a genuine database failure —
 *  a caller must be able to tell "this matter has no reviews" apart from
 *  "the database failed". Nothing here catches errors from
 *  `getDb()`/`getAllFromIndex`, so they propagate as-is (mirrors
 *  `documents.ts`'s `listDocuments`). */
export async function listReviews(matterId: string): Promise<Review[]> {
  const db = await getDb();
  const raw = (await db.getAllFromIndex(STORES.reviews, 'byMatter', matterId)) as StoredReview[];
  const entries = raw.map(r => ({ review: stripSeq(r), seq: seqOf(r) }));
  entries.sort((a, b) => {
    const diff = b.review.startedAt - a.review.startedAt;
    return diff !== 0 ? diff : b.seq - a.seq;
  });
  return entries.map(e => e.review);
}

export async function getReview(id: string): Promise<Review | null> {
  const db = await getDb();
  const found = (await db.get(STORES.reviews, id)) as StoredReview | undefined;
  return found ? stripSeq(found) : null;
}

/** Persists a review, deep-copying `playbookSnapshot` first.
 *
 *  This carries forward v1's discipline: editing a playbook after a review
 *  must not retroactively change what that review claims to have checked.
 *  IndexedDB's own write path (`structuredClone` under the hood — see
 *  `fake-indexeddb`'s `cloneValueForInsertion`, and the spec's
 *  `StructuredSerializeForStorage`) already decouples the *stored* record
 *  from the caller's object graph, so relying on that alone would make the
 *  persisted snapshot safe. But it would NOT protect the `Review` object
 *  this function *returns* to its caller in the same tick — that object
 *  would still share `playbookSnapshot` (and everything nested under it)
 *  with the caller's in-memory playbook, so a mutation immediately after
 *  `await saveReview(r)` would corrupt the in-memory copy even though the
 *  database was fine. Cloning explicitly here fixes both: it does not rely
 *  on which storage backend is behind `getDb()`, and it protects the
 *  returned value, not just the stored one. */
export async function saveReview(r: Review): Promise<Review> {
  const db = await getDb();
  const saved: Review = { ...r, playbookSnapshot: structuredClone(r.playbookSnapshot) };
  // The read (current max _seq) and the write share ONE readwrite
  // transaction, so two concurrent saveReview calls can never both read the
  // same max before either has written theirs. Nothing non-IDB is awaited
  // between the seq read and the put, which is what keeps IndexedDB from
  // auto-committing the transaction early. Mirrors playbooks.ts/matters.ts.
  const tx = db.transaction(STORES.reviews, 'readwrite');
  // `nextSeq`'s parameter type only accepts a 'readwrite' store from a
  // transaction scoped to this one store — so `tx.store` here is
  // load-bearing, not incidental: passing e.g. `{ getAll: () =>
  // db.getAll(STORES.reviews) }` instead would fail to compile, because
  // that shape opens its own transaction and would silently break the
  // atomicity below. See seq.ts's `SeqStore`.
  const seq = await nextSeq(tx.store);
  const record: StoredReview = { ...saved, _seq: seq };
  await tx.store.put(record);
  await tx.done;
  return saved;
}

export async function deleteReview(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORES.reviews, id);
}

const DEFAULT_REVIEW_SAVE_DEBOUNCE_MS = 2000;

/** Drives how a review's in-progress state gets persisted during a run,
 *  without writing on every `onUpdate` call. `runReview`'s `onUpdate` fires
 *  roughly twice per cell — a 3-document x 20-clause run is ~120 calls — and
 *  saving on every one of those would be 120 writes for one run. Instead:
 *
 *  - `scheduleSave` records the latest state and, if no save is already
 *    pending, arms a timer for `debounceMs` (>= 2000ms). Further calls
 *    before that timer fires only update *which* state will be written;
 *    they do not push the timer back. This is a deliberate departure from
 *    textbook trailing-edge debounce (reset-on-every-call): `onUpdate`
 *    fires continuously throughout a run, not in a bursty-then-quiet
 *    pattern, so a reset-on-every-call debounce could in principle never
 *    fire until the run itself goes quiet — i.e. never save mid-run at all,
 *    which is exactly the crash-loses-the-whole-run failure this exists to
 *    prevent. Throttling to "at most one save per debounceMs, but at least
 *    one every debounceMs while updates keep coming" is what actually
 *    delivers "a crash costs seconds, not the run".
 *  - `saveNow` cancels any pending timer and persists immediately — call it
 *    on completion and on cancellation, per the brief. Its promise is
 *    returned to the caller as-is, so a failure there is never swallowed.
 *  - `dispose` cancels a pending timer without persisting (e.g. on
 *    unmount), so a stale save cannot land after the caller has moved on.
 *
 *  The debounced write that `scheduleSave` eventually fires is
 *  fire-and-forget by nature — nothing is `await`ing it — so a failure
 *  there (quota, a blocked upgrade) cannot surface as a rejection on any
 *  promise the caller holds. It is always reported through `debug()` so it
 *  is not dropped silently, and additionally handed to the optional
 *  `onError` callback below so a caller that wants to surface "your
 *  in-progress review isn't saving" to the user can do so without this
 *  module needing to guess what that should look like.
 *
 *  This only persists `Review` records; converting a `ReviewRun` (the
 *  in-progress shape `runReview` operates on) into a `Review` and wiring
 *  this helper into the UI is left to a later task. */
export interface DebouncedReviewSaver {
  scheduleSave(review: Review): void;
  saveNow(review: Review): Promise<Review>;
  dispose(): void;
}

export function createDebouncedReviewSaver(
  debounceMs: number = DEFAULT_REVIEW_SAVE_DEBOUNCE_MS,
  onError?: (error: unknown, review: Review) => void,
): DebouncedReviewSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Review | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    scheduleSave(review: Review): void {
      pending = review;
      if (timer !== null) return; // A save is already armed; it will pick up the latest `pending` when it fires.
      timer = setTimeout(() => {
        const toSave = pending;
        timer = null;
        pending = null;
        if (toSave) {
          // Deliberately not awaited (this callback isn't async) — but the
          // rejection MUST still be handled here, not left to become an
          // unhandled rejection: nobody else is holding this promise.
          saveReview(toSave).catch(error => {
            debug('debounced review auto-save failed', error);
            onError?.(error, toSave);
          });
        }
      }, debounceMs);
    },
    async saveNow(review: Review): Promise<Review> {
      clearTimer();
      pending = null;
      return saveReview(review);
    },
    dispose(): void {
      clearTimer();
      pending = null;
    },
  };
}
