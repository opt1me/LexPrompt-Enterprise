import type { Finding, PlaybookClause, PlaybookVersion, Review } from '../types';
import { positionHealth, type PositionHealth } from './positionHealth';

/**
 * The date a standard position's health should be measured from: the
 * `publishedAt` of the version in which THAT CLAUSE'S position text last
 * changed (ruling R-D17).
 *
 * `positionHealth` discards every verification older than the date it is
 * given. Handing it the CURRENT version's `publishedAt` — the only date the
 * editor has directly to hand — would mean publishing v5 to change clause B
 * silently erased clause A's months of evidence, and the app would report
 * `UNTESTED` for a position that has been tested since v1. That is the
 * difference between "nobody has tested this" and "we forgot what we knew",
 * and only the first is a claim; making it falsely is the failure this
 * function exists to prevent.
 *
 * Returns `undefined` when no published version carries this exact wording —
 * an unpublished edit to a position, or a clause that has never been
 * published. That is not a dating failure to paper over: no review has ever
 * run against those words, so there is genuinely nothing to count.
 *
 * Sorts defensively rather than trusting the caller's order. `listVersions`
 * returns newest first, but a wrong date here is silently wrong in the
 * direction of discarding real evidence, so the ordering is not left as an
 * unchecked precondition.
 */
export function positionPublishedAt(
  versions: PlaybookVersion[],
  clauseId: string,
  currentText: string,
): number | undefined {
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  let dated: number | undefined;
  // Walk back from the newest version while the wording is unchanged; the
  // oldest version still carrying it is the one that introduced it.
  for (const version of newestFirst) {
    const text = version.clauses.find(c => c.id === clauseId)?.standardPosition?.text;
    if (text !== currentText) break;
    dated = version.publishedAt;
  }
  return dated;
}

export interface PositionHealthMapInput {
  /** The clauses currently on screen — the working copy, so a position the
   *  author has just edited is judged on the words they can see. */
  clauses: PlaybookClause[];
  /** Every published version of THIS playbook (`listVersions`). */
  versions: PlaybookVersion[];
  /** Every review the caller could read, from every matter. `listReviews` is
   *  matter-scoped and a playbook's health spans matters, so the caller
   *  gathers them; reviews belonging to other playbooks are filtered out
   *  here rather than by each caller. */
  reviews: Review[];
}

/**
 * Per-clause position health, keyed by clause id — DoD #7's read model.
 *
 * Pure, as ruling R-D2 requires: it reads no store, so the IO stays in the
 * container and this stays testable. A clause with no `standardPosition`
 * gets NO ENTRY, not a `no-position` one: the editor renders a chip for
 * every entry, and "we have no house rule here" is the absence of the
 * question rather than an answer to it.
 */
export function buildPositionHealthMap(
  { clauses, versions, reviews }: PositionHealthMapInput,
): Record<string, PositionHealth> {
  const versionIds = new Set(versions.map(v => v.id));
  // A review counts only if it ran against a version of this playbook. An
  // id that resolves to nothing (R-D15: deleting a playbook cascades to its
  // versions, so a review can keep a stale pointer) is not this playbook's,
  // and an absent one names no version at all.
  const relevant = reviews.filter(
    r => r.playbookVersionId !== undefined && versionIds.has(r.playbookVersionId),
  );

  const map: Record<string, PositionHealth> = {};
  for (const clause of clauses) {
    const position = clause.standardPosition;
    if (!position) continue;

    const publishedAt = positionPublishedAt(versions, clause.id, position.text);
    if (publishedAt === undefined) {
      // These exact words have never been published, so no review has ever
      // run against them. Untested is the honest answer, and it is a fact
      // about the position rather than a gap in what we could read.
      map[clause.id] = { kind: 'untested' };
      continue;
    }

    // Every finding for this clause, under whatever key: a collection review
    // keys its findings by the collection id and a document review by the
    // document id (R-C5), and health asks what the position has been tested
    // against, not which document owns the answer.
    const findings: Finding[] = relevant.flatMap(review =>
      Object.values(review.findings).flatMap(byClause => {
        const finding = byClause[clause.id];
        return finding ? [finding] : [];
      }),
    );
    map[clause.id] = positionHealth(publishedAt, findings);
  }
  return map;
}
