import type { FastifyInstance } from 'fastify';
import {
  ModelError, type ReviewHistory, type ReviewHistoryEvent,
} from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import {
  readReviewDispositionEvents, toEventView, type ReviewEventRow,
} from '../dispositions/service.ts';

/**
 * A REVIEW'S WHOLE DISPOSITION HISTORY (§6.3.1's fourth requirement).
 *
 * ## Why it exists
 *
 * §6.3.1: *"reconstruct what this report would have said on the day it was
 * signed"* is a question a firm will eventually ask, and only the history
 * can answer it. The current row answers only *as of right now* — and as of
 * Stage 4 that row is mutable by anyone in the workspace at any time, which
 * is precisely what turns "what did it say then" from a curiosity into a
 * question with consequences.
 *
 * The per-finding route (`GET …/:clauseId/history`) answers it one clause at
 * a time. Somebody reconstructing a signed report has forty clauses and no
 * reason to ask forty times.
 *
 * ## Oldest first
 *
 * The opposite of the per-finding panel's order, deliberately. A chronology
 * reads forward; a panel answering "what most recently happened to this one
 * clause" reads backward. Both are right for their reader, and the wire type
 * says which is which.
 *
 * ## A clause the playbook no longer names still appears
 *
 * The title comes from the review's OWN `playbook_snapshot`, which is a deep
 * copy taken when the review ran — so a clause removed from a later playbook
 * version is still named here. When even the snapshot does not name it (a
 * snapshot written before a clause existed, or a repaired record), the row
 * SURVIVES with no title rather than being dropped: a history quietly
 * shorter than what happened is the blank-CSV-cell defect on the one surface
 * whose entire purpose is completeness.
 */
export function registerHistory(app: FastifyInstance, db: Db): void {
  app.get('/v1/reviews/:id/history', async (req): Promise<ReviewHistory> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const { after, limit } = parsePage(req.query);

    return db.tx(async t => {
      // REFUSES rather than answering an empty history for a review this
      // workspace cannot see. An empty history is indistinguishable from a
      // review nobody has touched, and "this review is not yours" rendered
      // as "nobody has changed anything here" is the founding defect wearing
      // a new coat. Same 404 `readFindings` takes, for the same reason, and
      // scoped by workspace so the id's existence elsewhere is not confirmed.
      const reviews = await t.query<{ playbook_snapshot: unknown }>(
        'select playbook_snapshot from review where id = $1 and workspace_id = $2', [id, ws]);
      if (!reviews[0]) throw new ModelError('There is no such review.', 'not_found', 404);

      const titles = clauseTitles(reviews[0].playbook_snapshot);
      const rows = await readReviewDispositionEvents(t, id, ws, after, limit);
      // One row over the limit was fetched so `hasMore` needs no second
      // count over a table that only grows.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const events: ReviewHistoryEvent[] = page.map(row => toReviewHistoryEvent(row, titles));
      const last = events[events.length - 1];
      return {
        events,
        hasMore,
        ...(hasMore && last ? { nextCursor: last.id } : {}),
      };
    });
  });
}

/**
 * One stored event as the wire shape, with the cell and the clause's name.
 *
 * EXPORTED, and the reason is a test that passed against broken code. The
 * absence of `clauseTitle` was first asserted through `app.inject().json()`,
 * where `JSON.stringify` drops an undefined-valued key on the way out — so
 * `clauseTitle: title` and `...(title ? { clauseTitle: title } : {})` are
 * indistinguishable over HTTP, and the guard reported green with the
 * mutation in place. `structuredClone` — how this shape would cross any
 * other boundary, including Part 4B's socket payloads — PRESERVES it. The
 * seam exists so the assertion can be made on the object itself.
 */
export function toReviewHistoryEvent(
  row: ReviewEventRow, titles: Map<string, string>,
): ReviewHistoryEvent {
  const title = titles.get(row.clause_id);
  return {
    ...toEventView(row),
    findingsKey: row.findings_key,
    clauseId: row.clause_id,
    // ABSENT, never `clauseTitle: undefined`: "the snapshot does not name
    // this clause" and "it names it, as nothing" are different facts, and an
    // `in` check must be able to tell them apart.
    ...(title ? { clauseTitle: title } : {}),
  };
}

/** The clause titles the review's own snapshot carries. A snapshot shaped
 *  differently — an older schema, a repaired record — yields an empty map
 *  rather than throwing: a history with unnamed clauses is worth far more
 *  than a 500. */
export function clauseTitles(snapshot: unknown): Map<string, string> {
  const clauses = (snapshot as { clauses?: unknown } | null)?.clauses;
  const out = new Map<string, string>();
  if (!Array.isArray(clauses)) return out;
  for (const clause of clauses) {
    const c = clause as { id?: unknown; title?: unknown };
    if (typeof c?.id === 'string' && typeof c?.title === 'string' && c.title) {
      out.set(c.id, c.title);
    }
  }
  return out;
}

/** The default page. Large enough that a normal review is one request, small
 *  enough that a year of a busy matter is not one response. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * `after` and `limit`, read rather than trusted.
 *
 * A `limit` of `0`, a negative one, or `?limit=all` would each produce a
 * different silent wrongness — an empty page that reads as an empty history
 * being the worst of them. Anything unreadable falls back to the default
 * rather than refusing: the caller asked for a history and the honest
 * answer is a history, not a 400 about a query string.
 */
function parsePage(query: unknown): { after?: number; limit: number } {
  const q = (query ?? {}) as { after?: unknown; limit?: unknown };
  const after = Number(q.after);
  const limit = Number(q.limit);
  return {
    ...(Number.isInteger(after) && after > 0 ? { after } : {}),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}
