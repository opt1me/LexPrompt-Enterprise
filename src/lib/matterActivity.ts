import type { ActivityRow } from '@lexprompt/core';
import type { Review } from '../types';

export type ActivityKind =
  | 'verified' | 'flagged' | 'rejected' | 'note'
  | 'cleared' | 'rerun'
  | 'net-confirmed' | 'net-amended'
  | 'review-started' | 'review-completed' | 'run-cancelled'
  | 'audited';

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  /** Absent on a review-level event, which belongs to no clause. */
  clauseTitle?: string;
  reviewName: string;
  /**
   * WHO DID IT.
   *
   * `undefined` for an entry whose author the record does not carry — never
   * an id, and never you. The renderer turns it into a name through the
   * workspace directory (`src/lib/api/users.ts`, the only id→name
   * resolver); an id the directory does not hold reads as *"someone this
   * workspace does not name"*, which is true whether the person has left the
   * firm or the directory simply has not loaded.
   */
  byUserId?: string;
  /**
   * Kept, and now DERIVED from `byUserId` rather than being the only fact
   * available. Every existing renderer keeps working, and the derivation is
   * what stops the two ever disagreeing.
   */
  byYou: boolean;
  /** For an `audited` entry: which act it was. A closed set on the server
   *  (`apps/api/src/audit/actions.ts`); a string here, mapped to a verb by a
   *  complete literal `Record` in the renderer. */
  action?: string;
}

/**
 * A matter's history — from the records that already carry an author and a
 * timestamp.
 *
 * ## What changed in Stage 4, and what did not
 *
 * R-G9's reasoning — *"derived at read time from data that already carries
 * an author and a timestamp; nothing is stored: an event log would be a
 * second account of what happened, free to drift"* — was right and is now
 * HALF right. A disposition change and an audited act have their own
 * append-only records **because they are the record**, not a second account
 * of one, and `GET /v1/matters/:id/activity` reads them where they live.
 * What must still never appear is a third: an `activity` table.
 *
 * ## Two inputs, one assembler
 *
 * `rows` are what the SERVER read — disposition changes, audited acts, runs.
 * `reviews` are what this browser already holds, and they carry the two
 * things the server's three sources do not: a note, and a net position
 * somebody confirmed or amended. Both go through this one function so a
 * matter's feed is assembled in exactly one place; a second assembler is how
 * two halves of one list come to sort, limit and attribute differently.
 *
 * Single-actor is no longer true and the code says so: every entry carries
 * `byUserId`, and `byYou` is derived from it.
 *
 * An event with no timestamp is DROPPED, not dated `Date.now()`: a feed
 * whose ordering is invented is worse than a feed with a gap.
 */
export function matterActivity(
  reviews: Review[], localUserId: string, limit = 20, rows: ActivityRow[] = [],
): ActivityEntry[] {
  return [...activityEntries(rows, localUserId), ...fromReviews(reviews, localUserId)]
    .filter(e => Number.isFinite(e.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/**
 * The server's rows as entries.
 *
 * The ONE place a stored row becomes a feed line. A row whose `kind` this
 * browser does not recognise is kept as an `audited` entry naming the raw
 * action rather than dropped — a feed quietly shorter than what happened is
 * the failure R-G9 named, and a client reading an older server must not be
 * the thing that shortens it.
 */
export function activityEntries(
  rows: ActivityRow[], localUserId: string, limit?: number,
): ActivityEntry[] {
  const entries = rows
    .filter(row => Number.isFinite(row.at))
    .map((row): ActivityEntry => ({
      at: row.at,
      kind: kindOf(row),
      ...(row.clauseTitle ? { clauseTitle: row.clauseTitle } : {}),
      reviewName: row.reviewName ?? 'This matter',
      ...(row.byUserId ? { byUserId: row.byUserId } : {}),
      byYou: row.byUserId === localUserId,
      ...(row.source === 'audit' ? { action: row.kind } : {}),
    }))
    .sort((a, b) => b.at - a.at);
  return limit === undefined ? entries : entries.slice(0, limit);
}

/**
 * What a stored row is, in the feed's vocabulary.
 *
 * A RE-RUN IS NOT A PERSON UN-VERIFYING (§6.3: the feed must not flatten
 * them), so `cause === 'rerun_reset'` is its own kind. A person clearing a
 * judgement is another. Everything else in the disposition arm is the state
 * it moved to.
 */
function kindOf(row: ActivityRow): ActivityKind {
  if (row.source === 'audit') return 'audited';
  if (row.source === 'run') {
    if (row.kind === 'cancelled') return 'run-cancelled';
    return row.kind === 'succeeded' || row.kind === 'failed'
      ? 'review-completed' : 'review-started';
  }
  if (row.cause === 'rerun_reset') return 'rerun';
  if (row.kind === 'unchecked') return 'cleared';
  return row.kind === 'verified' || row.kind === 'flagged' || row.kind === 'rejected'
    ? row.kind : 'audited';
}

/**
 * The two things this browser holds that the server's three sources do not:
 * a note, and a net position somebody confirmed or amended.
 *
 * Reviews are read whole by the matter screen already, so this costs no
 * request. It deliberately does NOT re-derive verifications from
 * `finding.verification`: those come from `finding_disposition_event`
 * through the route, which is the record, and deriving them here as well
 * would put the same act in the feed twice.
 */
function fromReviews(reviews: Review[], localUserId: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const review of reviews) {
    const reviewName = review.playbookSnapshot?.name ?? 'Review';
    const titleOf = (clauseId: string) =>
      review.playbookSnapshot?.clauses?.find(c => c.id === clauseId)?.title;

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (!finding) continue;

        for (const note of finding.notes ?? []) {
          entries.push({
            at: note.at, kind: 'note', reviewName,
            ...(titleOf(finding.clauseId) ? { clauseTitle: titleOf(finding.clauseId)! } : {}),
            ...(note.byUserId ? { byUserId: note.byUserId } : {}),
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
            ...(titleOf(finding.clauseId) ? { clauseTitle: titleOf(finding.clauseId)! } : {}),
            ...(net.byUserId ? { byUserId: net.byUserId } : {}),
            byYou: net.byUserId === localUserId,
          });
        }
      }
    }
  }
  return entries;
}
