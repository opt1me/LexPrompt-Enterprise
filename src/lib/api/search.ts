import type { SearchResults } from '@lexprompt/core';
import { apiGet } from './client';

/**
 * FIRM-WIDE SEARCH, FROM THE BROWSER (R-G14 discharged).
 *
 * ## Two kinds of failure, and they are not the same shape
 *
 * A TRANSPORT failure — the service could not be reached, the session
 * expired, the query was refused — REJECTS. It never resolves to an empty
 * result set to represent one: "nothing in this firm matches" is a statement
 * about the corpus, and making it about a request that never arrived is this
 * project's founding defect with a cursor blinking in it.
 *
 * A PER-SOURCE failure is INSIDE the answer, not an exception, and the
 * difference is that the other sources' hits survive. `SearchResults.sources`
 * carries an outcome for every source on every answer, including a completely
 * successful one, so an empty list can always be told apart from a list that
 * is short because an arm did not answer.
 *
 * ## No cache
 *
 * For the reason `assignments.ts` gives about itself: a module holding its
 * own copy would have to be reconciled with a corpus that changes under it,
 * and the shape that produces is a result list naming a matter somebody
 * deleted.
 *
 * The `AbortSignal` goes straight through to `apiGet`, which has taken one
 * since Stage 2 — an abort propagates as an abort rather than being folded
 * into a network error, because a user typing the next letter is not a
 * failure of the firm's service.
 */
export async function search(query: string, signal?: AbortSignal): Promise<SearchResults> {
  return apiGet<SearchResults>(`/v1/search?q=${encodeURIComponent(query)}`, signal);
}
