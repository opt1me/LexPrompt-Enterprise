import { ModelError, type ActivityRow, type MatterActivityPage } from '@lexprompt/core';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.ts';

/**
 * WHAT HAPPENED IN THIS MATTER, AND WHO DID IT.
 *
 * ## Three sources, and no fourth
 *
 * R-G9's reasoning — *"derived at read time from data that already carries
 * an author and a timestamp; nothing is stored: an event log would be a
 * second account of what happened, free to drift"* — was right and is now
 * HALF right. Disposition changes and audited acts have their own
 * append-only records **because they are the record**, not a second account
 * of one.
 *
 * What must never appear is a THIRD: an `activity` table. This is a `UNION
 * ALL` over three tables that exist for their own reasons (S22), computed
 * per request, and if it is ever slow the answer is an index rather than a
 * copy.
 *
 * ## One statement, not three merged in TypeScript
 *
 * A limit applied after a merge reads the whole of every source, which is
 * the shape that turns "the last twenty things" into "every disposition
 * change this matter has ever had". Written as one literal so
 * `workspaceScope.test.ts` can read it whole, with each arm carrying its own
 * `workspace_id` predicate — a statement that guard cannot parse is a
 * statement nothing is checking.
 *
 * ## A disposition comes from `finding_disposition_event`, never from
 * `audit_event`
 *
 * S22, and `audit/actions.ts` carries the reasoning: two append-only records
 * of one fact is how a card and an export come to disagree. `AUDIT_ACTIONS`
 * has no disposition verb in it, `stage4aDoD.test.ts` asserts that absence
 * over the source, and the first arm below is where the fact is actually
 * read.
 */
export function registerActivity(app: FastifyInstance, db: Db): void {
  app.get('/v1/matters/:id/activity', async (req): Promise<MatterActivityPage> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const limit = limitOf(req.query);

    // REFUSES rather than answering an empty feed for a matter this
    // workspace cannot see. "Nothing has happened here" and "this is not
    // yours" are different facts, and the first is a real answer.
    const matters = await db.query<{ id: string }>(
      'select id from matter where id = $1 and workspace_id = $2', [id, ws]);
    if (!matters[0]) throw new ModelError('There is no such matter.', 'not_found', 404);

    const rows = await db.query<FeedRow>(FEED, [id, ws, limit]);
    return { rows: rows.map(toActivityRow) };
  });
}

interface FeedRow {
  at: Date;
  source: 'disposition' | 'audit' | 'run';
  kind: string;
  by_user_id: string;
  review_id: string | null;
  review_name: string | null;
  clause_id: string | null;
  clause_title: string | null;
  cause: string | null;
}

/**
 * ONE statement. Each arm names `workspace_id` in its own `where`, and the
 * matter is reached through `review` for the two tables that do not carry a
 * `matter_id` of their own.
 *
 * The clause TITLE comes from the review's own `playbook_snapshot` — a deep
 * copy taken when the review ran — so a clause a later playbook version
 * removed is still named. `->>` yields NULL when the snapshot does not name
 * it, and the row survives with its id instead of being dropped.
 *
 * A RE-RUN'S RESET carries `cause = 'rerun_reset'`, and the browser must not
 * flatten it into "somebody un-verified this" (§6.3). It is carried, not
 * filtered: a clause whose judgement was removed because the answer was
 * replaced is a thing that happened in this matter.
 */
const FEED = `
select at, source, kind, by_user_id, review_id, review_name, clause_id, clause_title, cause
  from (
    select e.at as at, 'disposition' as source, e.to_state as kind,
           e.by_user_id::text as by_user_id, e.review_id as review_id,
           r.playbook_snapshot ->> 'name' as review_name, e.clause_id as clause_id,
           (select c ->> 'title' from jsonb_array_elements(r.playbook_snapshot -> 'clauses') c
             where c ->> 'id' = e.clause_id limit 1) as clause_title,
           e.cause as cause
      from finding_disposition_event e
      join review r on r.id = e.review_id and r.workspace_id = e.workspace_id
     where e.workspace_id = $2 and r.matter_id = $1
    union all
    select a.at, 'audit', a.action, a.actor_user_id::text, a.review_id, null, null, null, null
      from audit_event a
     where a.workspace_id = $2 and a.matter_id = $1
    union all
    select coalesce(n.started_at, n.created_at), 'run', n.state,
           n.requested_by_user_id::text, n.review_id,
           r.playbook_snapshot ->> 'name', null, null, null
      from run n
      join review r on r.id = n.review_id and r.workspace_id = n.workspace_id
     where n.workspace_id = $2 and r.matter_id = $1
  ) as feed
 order by at desc
 limit $3`;

/**
 * A row to the wire shape.
 *
 * Every optional field is ABSENT rather than `undefined`-valued, for the
 * reason `toDispositionView` gives: `structuredClone` preserves an
 * undefined-valued key, so an `in` check would read "this event belongs to
 * no clause" as "it belongs to one, unnamed".
 */
function toActivityRow(row: FeedRow): ActivityRow {
  return {
    at: row.at.getTime(),
    source: row.source,
    kind: row.kind,
    byUserId: row.by_user_id,
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(row.review_name ? { reviewName: row.review_name } : {}),
    ...(row.clause_id ? { clauseId: row.clause_id } : {}),
    ...(row.clause_title ? { clauseTitle: row.clause_title } : {}),
    ...(row.cause ? { cause: row.cause } : {}),
  };
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/** Read rather than trusted, and a bad value falls back rather than
 *  refusing: `?limit=0` would answer an empty feed, which reads as "nothing
 *  has happened in this matter". */
function limitOf(query: unknown): number {
  const raw = Number((query as { limit?: unknown } | null)?.limit);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
}
