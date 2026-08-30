import type { ReviewHistory, ReviewHistoryEvent } from '@lexprompt/core';
import { apiGet } from './client';

/**
 * A REVIEW'S WHOLE DISPOSITION HISTORY, from the server (§6.3.1).
 *
 * REJECTS on any failure; it never resolves to an empty history — the same
 * rule `getDispositionHistory` follows one level down, for the same reason.
 * An empty history under a review somebody has been changing is
 * indistinguishable from a record that failed to write itself, and this is
 * the surface a firm would use to answer *"what would this report have said
 * on the day it was signed"*. A failed fetch must not be able to answer that
 * question with silence.
 *
 * NOT CACHED. A history is the surface most likely to have changed since the
 * page loaded, and the whole point of reading it is to see the change.
 */
export async function getReviewHistory(
  reviewId: string, after?: number, limit?: number,
): Promise<ReviewHistory> {
  const query = new URLSearchParams();
  if (after !== undefined) query.set('after', String(after));
  if (limit !== undefined) query.set('limit', String(limit));
  const suffix = query.toString();
  return apiGet<ReviewHistory>(
    `/v1/reviews/${encodeURIComponent(reviewId)}/history${suffix ? `?${suffix}` : ''}`);
}

/**
 * EVERY page of it, followed to the end.
 *
 * An export of "the review's full history" that stopped at the first page
 * would be a document titled *complete* that is not — the failure this
 * project's whole rule set is about, on the surface least likely to be
 * checked by hand. So the export follows the cursor rather than taking what
 * one request happened to return.
 *
 * `maxPages` is a bound, not a policy: a cursor that never advances (a
 * server bug, a proxy replaying a response) would otherwise spin forever
 * inside a click handler. Reaching it THROWS rather than returning what was
 * collected, because a partial history returned as a whole one is exactly
 * what this function exists to prevent.
 */
export async function getAllReviewHistory(
  reviewId: string, maxPages = 100,
): Promise<ReviewHistoryEvent[]> {
  const events: ReviewHistoryEvent[] = [];
  let after: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const got = await getReviewHistory(reviewId, after);
    events.push(...got.events);
    if (!got.hasMore || got.nextCursor === undefined) return events;
    if (after !== undefined && got.nextCursor <= after) {
      throw new Error(
        'The history did not advance past this point, so LexPrompt cannot say it has the '
        + 'whole of it. Nothing was exported.');
    }
    after = got.nextCursor;
  }
  throw new Error(
    `This review's history is longer than ${maxPages} pages, which LexPrompt did not expect. `
    + 'Nothing was exported, rather than exporting part of it as though it were all of it.');
}
