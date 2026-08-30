import { ModelError } from '@lexprompt/core';
import { apiDelete, apiGet, apiGetOrNull, apiSend } from '../api/client';
import { forgetFindingVersions, getFindings } from '../api/findings';
import { debug } from '../debug';
import { migrateReviewRecord } from './reviewMigration';
import { listVersions } from './playbookVersions';
import { snapshotPlaybookId } from './playbookMigration';
import type { Review } from '../../types';

/**
 * The reviews repository — an HTTP client over `apps/api` since Stage 2.
 *
 * Same file, same exports, same signatures (R3), and
 * `createDebouncedReviewSaver` keeps its interface exactly. What moved OUT
 * is the `_seq` tiebreak and the sort — they are `review.seq` and an
 * `order by started_at desc, seq desc` in the route. What moved IN is the
 * one thing this table needed and could not have before: a stale write is
 * REFUSED rather than applied.
 *
 * ## The version this browser last SAW
 *
 * `reviewFromRun` builds a `Review` from a run in memory. A run has nowhere
 * to carry an optimistic-concurrency token, and the debounced saver hands
 * whatever it is given straight to `saveReview` — so a save built from a run
 * carries no `version`, which the route reads as "I believe this is a
 * create" and refuses against a row that already exists. Every save after
 * the first would fail.
 *
 * So this module remembers, per review id, the version it last saw from the
 * server — from a read, or from its own successful write — and stamps that
 * onto a save. It is knowledge this browser genuinely has, and it is
 * deliberately NOT a way around the check:
 *
 *  - Another tab, or another person, writing bumps the server's version past
 *    what this browser remembers, so the next save from here is REFUSED.
 *    That is the whole point. Verification state is set only by a human
 *    action and nothing derives it; a saver silently overwriting one is the
 *    worst defect available on this path, and no in-tab merge could ever
 *    close it across two tabs, because the other tab's write was never in
 *    this one's snapshot to carry. (The merge that tried is deleted - Task
 *    21 - along with the debounced saver that made it necessary.)
 *  - The refusal reaches the reader: `App.tsx` turns a rejected save into a
 *    visible notice rather than swallowing it.
 *
 * The map is per TAB and dies with it, which is right: it records what this
 * browser has seen, not what is true.
 */
const lastSeenVersion = new Map<string, number>();

/** Records the version the server just reported. Called on every read and
 *  every successful write — the two ways this browser learns one. */
function remember(review: Review): Review {
  if (typeof review.version === 'number') lastSeenVersion.set(review.id, review.version);
  return review;
}

/** Drops what this browser believes about a review's version. Called when a
 *  review is deleted; exported so a test can put this module back into the
 *  state a fresh tab is in. */
export function forgetReviewVersion(id: string): void {
  lastSeenVersion.delete(id);
  // The disposition versions this browser holds for the same review belong
  // to the same "what this tab has seen" bookkeeping and go with it — a
  // stale one left behind would be stated on a write against a row it was
  // never read from.
  forgetFindingVersions(id);
}

/**
 * Task 4: builds the one-entry `versionIndex` `migrateReviewRecord` needs to
 * back-fill `playbookVersionId` on a review written before D. Reaches into
 * the playbook versions repository — the pure repair function must not — but
 * only when the review has no version id of its own yet, so an ordinary
 * post-D review (which already carries one from `reviewFromRun`) costs an
 * extra request exactly never.
 *
 * `record.playbookSnapshot` may still be a pre-D `Template`, whose own `id`
 * IS the playbook's id (there was no separate identity/version split yet);
 * a real `PlaybookVersion` carries that as `playbookId` instead.
 * `snapshotPlaybookId` (`playbookMigration.ts`) is the one place that
 * recovers a playbook id from either shape — `migrateVersionRecord` needs
 * the identical fact for the identical reason, and this function used to
 * re-derive it inline with a second copy of the same fallback chain.
 */
async function buildVersionIndex(record: Review): Promise<Record<string, string>> {
  if (typeof record.playbookVersionId === 'string' && record.playbookVersionId) return {};

  const playbookId = snapshotPlaybookId(record.playbookSnapshot);
  if (!playbookId) return {};

  const versions = await listVersions(playbookId);
  const v1 = versions.find(v => v.version === 1);
  return v1 ? { [playbookId]: v1.id } : {};
}

/**
 * Repair-on-read, at the ONE funnel every read goes through, so a review
 * written before sub-project B (or D) is upgraded exactly once no matter
 * which screen asked for it.
 *
 * No `documentText` lookup is passed — this is the only production caller of
 * `migrateReviewRecord`, so a pre-B review's citations come back without
 * page pins, which is the honest answer spec §4 asks for (an absent page is
 * never wrong, just less than it could be).
 */
async function repair(record: Review): Promise<Review> {
  const versionIndex = await buildVersionIndex(record);
  return remember(migrateReviewRecord(record, undefined, versionIndex));
}

/** All reviews for a matter, most recently started first; tiebreak on write
 *  sequence descending so the review saved most recently wins a
 *  same-millisecond collision. The order is the server's and is not
 *  re-derived here.
 *
 *  Rejects (rather than resolving to `[]`) on any failure — a caller must be
 *  able to tell "this matter has no reviews" apart from "the server
 *  failed". */
export async function listReviews(matterId: string): Promise<Review[]> {
  const raw = await apiGet<Review[]>(`/v1/matters/${encodeURIComponent(matterId)}/reviews`);
  return Promise.all(raw.map(repair));
}

/**
 * `null` for "there is no such review", and ONLY for that.
 *
 * TASK 14: THE FINDINGS COME FROM ROWS. `GET /v1/reviews/:id` no longer
 * carries them — absent, not `{}` — and `GET /v1/reviews/:id/findings`
 * assembles them from `finding`, `finding_disposition` and `note`. The
 * signature does not change and neither does the `Review` this returns, so
 * not one consumer of `review.findings` had to learn anything.
 *
 * The second read is AWAITED and its failure PROPAGATES. Defaulting to `{}`
 * on a failed findings read would render a review of a contract as one that
 * found nothing — this project's founding defect, in the one place a new
 * load path could reintroduce it. `repair`/`buildVersionIndex` still run
 * over the assembled record, because a review read today can still be one
 * written before sub-project B or D.
 */
export async function getReview(id: string): Promise<Review | null> {
  const found = await apiGetOrNull<Review>(`/v1/reviews/${encodeURIComponent(id)}`);
  if (!found) return null;
  const { findings } = await getFindings(id);
  return repair({ ...found, findings });
}

/**
 * Persists a review, deep-copying `playbookSnapshot` first.
 *
 * The clone still matters, for the half of its original reason the transport
 * did not take over. `JSON.stringify` on the way out already decouples what
 * is STORED from the caller's object graph, and the `Review` this returns is
 * parsed from the response and is therefore a fresh object — but between
 * this line and the request actually going out there is now a network's
 * worth of time in which a caller can mutate the playbook it handed over.
 * Cloning closes that.
 *
 * THE VERSION IS STAMPED FROM WHAT THIS BROWSER LAST SAW, and is preferred
 * over whatever the record carries: a `Review` built by `reviewFromRun` has
 * none, and one held in component state since a screen opened may carry a
 * stale one this browser has already superseded with its own writes. See the
 * module docstring for why that is not a way around the check.
 *
 * A stale write REJECTS with a `conflict` `ModelError` rather than being
 * applied. Every caller must surface it — silently losing a colleague's
 * verification is the failure this refusal exists to prevent.
 */
export async function saveReview(r: Review): Promise<Review> {
  const known = lastSeenVersion.get(r.id);
  const body: Review = {
    ...r,
    playbookSnapshot: structuredClone(r.playbookSnapshot),
    ...(known === undefined ? {} : { version: known }),
  };
  const saved = await apiSend<Review>('PUT', `/v1/reviews/${encodeURIComponent(r.id)}`, body);
  return remember(saved);
}

/** A 404 RESOLVES — the caller asked for the review to be gone and it is
 *  gone, which is what `db.delete` on a missing key always did. Every other
 *  failure rejects. */
export async function deleteReview(id: string): Promise<void> {
  try {
    await apiDelete(`/v1/reviews/${encodeURIComponent(id)}`);
  } catch (err) {
    if (!(err instanceof ModelError && err.status === 404)) throw err;
  }
  // Whether it was there or not, nothing here knows its version any more.
  forgetReviewVersion(id);
}

/**
 * TASK 18: `createDebouncedReviewSaver` IS GONE, with the orchestration it
 * existed to keep up with.
 *
 * It wrote the whole review roughly every two seconds while a browser ran a
 * review, so a crash cost seconds rather than the run. The server writes
 * every finding now — there is no in-progress state held only in a tab, so
 * there is nothing for a mid-run whole-review save to rescue.
 *
 * Deleting it also retires the failure P25 names: a run's saver holds its
 * own copy of a review and knows nothing about anyone else's writes, so
 * every save after somebody else's landed was refused with a 409, forever,
 * with a notice on screen the reader could do nothing about. That is a
 * defect removed by deletion rather than by a fix.
 *
 * `saveReview` itself stays, and `App.tsx` makes exactly ONE call to it per
 * run now: the write that records WHEN the review ended (`finishRun`).
 */
