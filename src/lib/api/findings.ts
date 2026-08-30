import type { FindingsPage } from '@lexprompt/core';
import { apiGet } from './client';

/**
 * The browser's reader of a review's findings — Task 14's half of the flip.
 *
 * `GET /v1/reviews/:id/findings` assembles `finding`, `finding_disposition`
 * and `note` into the nested `findingsKey -> clauseId -> Finding` shape
 * `Review.findings` has always had, so nothing that renders a finding
 * changed when the storage did.
 *
 * ## The disposition version this browser last SAW
 *
 * A disposition write is version-guarded server-side: a stale version is
 * refused with a 409 carrying the current row, because the alternative is
 * silently overwriting a judgement the writer never saw. The browser has to
 * state the version it was looking at, and a `Finding` has nowhere to carry
 * one — it is the domain shape three programs share, and an
 * optimistic-concurrency token is a fact about one table's row.
 *
 * So this module remembers it, per `(reviewId, findingsKey, clauseId)`,
 * exactly as `src/lib/db/reviews.ts` remembers a review's version and for
 * the same reasons, written out there at length. In short: it records what
 * this browser has SEEN, from a read or from its own successful write; it
 * is per tab and dies with the tab; and it is deliberately not a way around
 * the check, because another writer moving the row past what this browser
 * remembers is exactly the case the refusal exists for.
 */
/**
 * `reviewId -> cellKey -> version`, nested rather than flat.
 *
 * Nested because forgetting a review has to forget everything under it, and
 * a flat map would need a prefix match over a composite key — which means
 * choosing a separator that cannot appear in a document id, a collection id
 * or a clause id. `JSON.stringify` of the pair is unambiguous with no such
 * choice to get wrong.
 */
const lastSeenVersion = new Map<string, Map<string, number>>();

const cellKey = (findingsKey: string, clauseId: string): string =>
  JSON.stringify([findingsKey, clauseId]);

/** Records the disposition versions the server just reported. */
function remember(reviewId: string, versions: FindingsPage['dispositionVersions']): void {
  for (const [findingsKey, byClause] of Object.entries(versions)) {
    for (const [clauseId, version] of Object.entries(byClause)) {
      rememberDispositionVersion(reviewId, findingsKey, clauseId, version);
    }
  }
}

/** Records one version — called after a write that returned the row it
 *  produced, so the next write from this browser is not refused as stale. */
export function rememberDispositionVersion(
  reviewId: string, findingsKey: string, clauseId: string, version: number,
): void {
  let byCell = lastSeenVersion.get(reviewId);
  if (!byCell) {
    byCell = new Map<string, number>();
    lastSeenVersion.set(reviewId, byCell);
  }
  byCell.set(cellKey(findingsKey, clauseId), version);
}

/**
 * The version this browser last saw for one finding's disposition.
 *
 * `1` is the version a `finding_disposition` row is created with, so a
 * finding this browser has read but whose version it somehow does not hold
 * states the create-shaped value rather than omitting the field — and if
 * that is wrong, the write is REFUSED with a 409 rather than applied. The
 * fallback cannot cause a silent overwrite, which is the only property it
 * needs to have.
 */
export function dispositionVersionFor(
  reviewId: string, findingsKey: string, clauseId: string,
): number {
  return lastSeenVersion.get(reviewId)?.get(cellKey(findingsKey, clauseId)) ?? 1;
}

/** Drops what this browser believes about a review's disposition versions.
 *  Exported so a test can put this module back into the state a fresh tab
 *  is in, and called when a review is deleted. */
export function forgetFindingVersions(reviewId: string): void {
  lastSeenVersion.delete(reviewId);
}

/**
 * Every finding of a review, from the rows.
 *
 * REJECTS on any failure — it never resolves to an empty map. A review is a
 * record of what was examined, and "the findings could not be read" and
 * "this review found nothing" are the two things this codebase most insists
 * on keeping apart. The caller renders the rejection through
 * `describeLoadError`/`LoadErrorPanel`; a 404 arrives as a `ModelError`
 * carrying "There is no such review."
 */
export async function getFindings(reviewId: string): Promise<FindingsPage> {
  const page = await apiGet<FindingsPage>(
    `/v1/reviews/${encodeURIComponent(reviewId)}/findings`);
  remember(reviewId, page.dispositionVersions ?? {});
  return page;
}
