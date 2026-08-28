import type { Review } from '../types';

export type ActivityKind =
  | 'verified' | 'flagged' | 'rejected' | 'note'
  | 'net-confirmed' | 'net-amended'
  | 'review-started' | 'review-completed';

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  /** Absent on a review-level event, which belongs to no clause. */
  clauseTitle?: string;
  reviewName: string;
  /** True when the recorded author is the local profile. An unrecognised
   *  author renders with NO actor rather than an invented one (R-GP5). */
  byYou: boolean;
}

/**
 * A matter's history, derived at read time from data that already carries
 * an author and a timestamp (R-G9). Nothing is stored: an event log would
 * be a second account of what happened, free to drift from the findings it
 * claims to describe — this project's most repeated defect.
 *
 * Single-actor by construction (R-G1/R-GP5). Every line the UI renders
 * reads "You …" for the local profile, and an entry whose `byUserId`
 * matches nothing known is rendered without an actor — never as a
 * colleague, because there are none.
 *
 * An event with no timestamp is DROPPED, not dated `Date.now()`: a feed
 * whose ordering is invented is worse than a feed with a gap.
 */
export function matterActivity(reviews: Review[], localUserId: string, limit = 20): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const review of reviews) {
    const reviewName = review.playbookSnapshot?.name ?? 'Review';
    const titleOf = (clauseId: string) =>
      review.playbookSnapshot?.clauses?.find(c => c.id === clauseId)?.title;

    entries.push({ at: review.startedAt, kind: 'review-started', reviewName, byYou: review.createdByUserId === localUserId });
    if (review.completedAt !== undefined) {
      entries.push({ at: review.completedAt, kind: 'review-completed', reviewName, byYou: review.createdByUserId === localUserId });
    }

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (!finding) continue;

        const v = finding.verification;
        if (v && v.state !== 'unchecked' && v.at !== undefined) {
          entries.push({
            at: v.at, kind: v.state, reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: v.byUserId === localUserId,
          });
        }

        for (const note of finding.notes ?? []) {
          entries.push({
            at: note.at, kind: 'note', reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: note.byUserId === localUserId,
          });
        }

        const net = finding.netPosition;
        if (net && net.state === 'confirmed' && net.at !== undefined) {
          entries.push({
            at: net.at,
            // Amending is a stronger claim than confirming — a person wrote
            // every word of it — so the two are different events.
            kind: net.amended !== undefined ? 'net-amended' : 'net-confirmed',
            reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: net.byUserId === localUserId,
          });
        }
      }
    }
  }

  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}
