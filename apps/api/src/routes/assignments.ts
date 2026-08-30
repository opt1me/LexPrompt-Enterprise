import type { FastifyInstance } from 'fastify';
import {
  ModelError, uid,
  type AssignmentInboxItem, type AssignmentInboxPage,
  type AssignmentsPage, type AssignmentView,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { appendAudit } from '../audit/write.ts';
import { appendEvent } from '../run/events.ts';
import type { FindingKey } from '../findings/rows.ts';

/**
 * ASKING A COLLEAGUE TO LOOK AT A CLAUSE (§6.3, S17, Task 24).
 *
 * The owner's escape hatch, in his own framing: *"a trainee may verify one
 * clause and be happy, then flag another for a Partner's view."* Two acts —
 * a judgement about the answer, and a request that a person look at it — and
 * this file is the second one only.
 *
 * ## An assignment is a request, and never a disposition
 *
 * Nothing here writes `finding_disposition`, nothing here writes a
 * `finding_disposition_event`, and nothing here clears anything. Assigning
 * changes no state on the finding at all. That is asserted rather than
 * described (`assignments.pg.test.ts`), because the assertion is what a
 * later "flag and assign in one click" would have to break deliberately.
 *
 * ## Why the audit log carries it, when a disposition change does not
 *
 * S22 keeps a disposition change out of `audit_event`: it is recorded once,
 * in `finding_disposition_event`, and two append-only accounts of one fact
 * is how a card and an export come to disagree in front of an auditor.
 *
 * An assignment has no append-only log of its own, because the row is
 * MUTABLE — it is created and later resolved. So the acts go into
 * `audit_event` (`assignment.created`, `assignment.resolved`), and there is
 * still exactly one record of each fact. The asymmetry is the rule being
 * applied, not an exception to it.
 *
 * ## The bar is `reviewer`, and that is the owner's case rather than a
 * convenience
 *
 * A partner-only gate here would invert his own story: it is the TRAINEE who
 * assigns, when they are not sure. So it sits at the same bar as the
 * disposition it deliberately does not change.
 */
export interface AssignmentRouteOptions {
  /** `API_ASSIGNMENT_INBOX_LIMIT`. Read with a `limit + 1` so `capped` is
   *  measured rather than guessed. */
  inboxLimit: number;
}

export function registerAssignments(
  app: FastifyInstance, db: Db, opts: AssignmentRouteOptions,
): void {
  /**
   * *"Please look at this."*
   *
   * The assigner is the AUTHENTICATED ACTOR and never a body field — the
   * same refusal the disposition route makes about `byUserId` and `at`, for
   * the same reason: a request that could name its own author is a request
   * anybody could put anybody's name on, and this one arrives on somebody's
   * screen saying who asked.
   */
  app.post('/v1/reviews/:id/findings/:findingsKey/:clauseId/assignments',
    async (req, reply): Promise<AssignmentView> => {
      const ws = req.actor!.workspaceId;
      const key = keyOf(req.params);
      const body = parseAssign(req.body);

      const assignment = await db.tx(async t => {
        await requireFinding(t, key, ws);
        await requireWorkspaceUser(t, body.assigneeUserId, ws);

        const id = uid();
        const created = await t.query<{ created_at: Date }>(
          `insert into assignment
             (id, review_id, findings_key, clause_id, workspace_id,
              assignee_user_id, assigned_by_user_id, message)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           -- The partial unique index refuses a SECOND OPEN request to the
           -- same person for the same clause. An "on conflict do nothing"
           -- would answer 200 with no row, which reads to a caller as a
           -- request that was made.
           returning created_at`,
          [id, key.reviewId, key.findingsKey, key.clauseId, ws,
            body.assigneeUserId, req.actor!.id, body.message ?? null])
          .catch((err: { code?: string }) => {
            if (err.code === '23505') {
              throw new ModelError(
                'You have already asked that person to look at this clause, and they have not '
                + 'closed it yet. Two identical open requests would put the same row in front '
                + 'of them twice.', 'conflict', 409);
            }
            throw err;
          });

        const view: AssignmentView = {
          id,
          reviewId: key.reviewId,
          findingsKey: key.findingsKey,
          clauseId: key.clauseId,
          assigneeUserId: body.assigneeUserId,
          assignedByUserId: req.actor!.id,
          ...(body.message === undefined ? {} : { message: body.message }),
          createdAt: created[0].created_at.getTime(),
        };

        // THE AUDIT ROW AND THE PUSH, both in this transaction. An audit row
        // committed while the act rolled back is a log that says something
        // happened which did not; a push that commits while its write rolls
        // back tells a person they were asked for something nobody asked.
        await appendAudit(t, {
          workspaceId: ws,
          actorUserId: req.actor!.id,
          action: 'assignment.created',
          subjectType: 'assignment',
          subjectId: id,
          reviewId: key.reviewId,
          detail: { assigneeUserId: body.assigneeUserId, clauseId: key.clauseId },
        });
        await appendEvent(t, {
          workspaceId: ws,
          type: 'assignment.created',
          reviewId: key.reviewId,
          payload: {
            reviewId: key.reviewId,
            findingsKey: key.findingsKey,
            clauseId: key.clauseId,
            assignment: view,
          },
        });
        return view;
      });

      // `reply.code(201)` and NOT `await reply.code(201)` — a `FastifyReply`
      // is thenable, so an awaited `.code()` with no `.send()` hangs until
      // the client gives up. The notes route says the same thing.
      reply.code(201);
      return assignment;
    });

  /**
   * CLOSING ONE — by the assignee, who has looked, or by the assigner, who
   * no longer needs them to.
   *
   * Nobody else, and the refusal is a 403 that says which two people may.
   * A third person closing a request would make "this was dealt with" a
   * claim neither of the people involved made.
   *
   * It changes NO disposition either. Closing a request is not deciding the
   * clause: the assignee's judgement, if they formed one, is a disposition
   * they set separately and which names them.
   */
  app.post('/v1/assignments/:id/resolve', async (req): Promise<AssignmentView> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };

    return db.tx(async t => {
      const rows = await t.query<AssignmentRow>(
        `select * from assignment where id = $1 and workspace_id = $2`, [id, ws]);
      const row = rows[0];
      // 404 rather than 403 for an assignment in another workspace: a 403
      // would confirm the id exists somewhere.
      if (!row) {
        throw new ModelError(
          'LexPrompt has no such assignment in your workspace.', 'not_found', 404);
      }
      if (row.resolved_at) {
        // ALREADY CLOSED is not a failure of this request, and it is not a
        // silent success either: answering 200 with the stored row would
        // tell the caller they closed something somebody else closed
        // minutes ago, which is a small version of the attribution defect
        // this stage exists to end.
        throw new ModelError(
          'That request was already closed.', 'conflict', 409);
      }
      if (req.actor!.id !== row.assignee_user_id && req.actor!.id !== row.assigned_by_user_id) {
        throw new ModelError(
          'Only the person who was asked, or the person who asked them, can close this '
          + 'request.', 'not_permitted', 403);
      }

      const at = new Date();
      await t.query(
        `update assignment set resolved_at = $3, resolved_by_user_id = $4
          where id = $1 and workspace_id = $2 and resolved_at is null`,
        [id, ws, at, req.actor!.id]);

      const view = { ...toAssignmentView(row), resolvedAt: at.getTime(),
        resolvedByUserId: req.actor!.id };
      await appendAudit(t, {
        workspaceId: ws,
        actorUserId: req.actor!.id,
        action: 'assignment.resolved',
        subjectType: 'assignment',
        subjectId: id,
        reviewId: row.review_id,
        detail: { clauseId: row.clause_id, withdrawn: req.actor!.id === row.assigned_by_user_id },
      });
      await appendEvent(t, {
        workspaceId: ws,
        type: 'assignment.resolved',
        reviewId: row.review_id,
        payload: {
          reviewId: row.review_id,
          findingsKey: row.findings_key,
          clauseId: row.clause_id,
          assignment: view,
        },
      });
      return view;
    });
  });

  /**
   * WHAT HAS BEEN ASKED OF ME, AND WHAT I HAVE ASKED OF OTHERS — the
   * caller's own open requests, in both directions.
   *
   * The CALLER'S, always: the id comes from the token and never from a query
   * parameter. A `?assignee=` would be a route that reads another person's
   * queue, which is a different feature with a different bar. Reading BOTH
   * directions is not that: a request you made is your own act, and the
   * card's own prop doc promises both — *"one you made reads 'You asked
   * R. Okafor to look at this'"*.
   *
   * IT USED TO READ ONLY `assignee_user_id`, and this is the only read of
   * `assignment` there is. So a request you made lived in memory and nowhere
   * else: it vanished on reload, taking the **Withdraw the request** control
   * with it, while the assignee still saw the row open. One party could
   * close it and the other could not, which is not a queue anybody can
   * work.
   *
   * A THIRD PARTY IS STILL TOLD NOTHING. `resolve` refuses anybody but these
   * two, and the browser filters the review-scoped push to the same pair
   * (`assignmentParty`), so what a card shows live is what it shows after a
   * reload.
   *
   * `?review=` narrows it to one review, which is what Stage 4's surface
   * needs (Task 25). The firm-wide "assigned to me" counter is Stage 5 (S18)
   * and is a different screen, not a different truth.
   */
  app.get('/v1/assignments',
    async (req): Promise<AssignmentsPage | AssignmentInboxPage> => {
      const ws = req.actor!.workspaceId;
      const query = req.query as { state?: string; review?: string };
      if (query.state !== undefined && query.state !== 'open') {
        // A CLOSED SET, refused rather than silently treated as `open`. A
        // caller who asked for `state=resolved` and received open requests
        // would be reading the wrong list with no way to tell.
        throw new ModelError(
          `LexPrompt lists open assignments; it does not understand state=${query.state}.`,
          'unknown', 400);
      }
      if (query.review !== undefined) {
        const rows = await db.query<AssignmentRow>(
          `select * from assignment
            where workspace_id = $1 and resolved_at is null
              and (assignee_user_id = $2 or assigned_by_user_id = $2)
              and review_id = $3
            order by created_at desc`, [ws, req.actor!.id, query.review]);
        return { assignments: rows.map(toAssignmentView) };
      }

      // THE CROSS-MATTER INBOX. `limit + 1` so `capped` is measured rather
      // than guessed -- the same idiom `readEvents` uses for `hasMore`, and
      // for the same reason: a `count(*)` is a second statement that can
      // disagree with the first.
      const rows = await db.query<InboxRow>(
        INBOX, [ws, req.actor!.id, opts.inboxLimit + 1]);
      const capped = rows.length > opts.inboxLimit;
      return {
        items: rows.slice(0, opts.inboxLimit).map(toInboxItem),
        capped,
      };
    });
}

interface InboxRow extends AssignmentRow {
  matter_id: string;
  matter_name: string;
  review_name: string | null;
  clause_title: string | null;
}

/**
 * ONE STATEMENT, joining the context an assignee needs in order to act from
 * a screen that is not inside any particular matter.
 *
 * ## Only what was asked OF me
 *
 * Unlike `?review=`, which answers both directions because a request you
 * MADE is your own act and the review screen offers you a Withdraw control
 * for it, this is the "assigned to me" queue: `assignee_user_id = $2` and
 * nothing else. A counter that included requests you made would tell you
 * that you owe somebody an answer you do not owe.
 *
 * ## The clause title comes from the review's SNAPSHOT, never from the
 * playbook as it stands
 *
 * `playbook_snapshot` is a deep copy of what the review claims to have
 * checked (`CLAUDE.md`), so a clause renamed since is still named as it was
 * named then, and a clause the snapshot no longer holds yields NULL rather
 * than a title read live from a version this review never ran. Do not join
 * `playbook_version` here: a title read live renames history.
 *
 * Every arm of the join carries `workspace_id` -- `assignment`, `review` and
 * `matter` alike -- because a join that scopes only its driving table is a
 * join one careless `or` away from another firm's matter names.
 */
const INBOX = `
select a.*, m.id as matter_id, m.name as matter_name,
       r.playbook_snapshot ->> 'name' as review_name,
       (select c ->> 'title' from jsonb_array_elements(r.playbook_snapshot -> 'clauses') c
         where c ->> 'id' = a.clause_id limit 1) as clause_title
  from assignment a
  join review r on r.id = a.review_id and r.workspace_id = a.workspace_id
  join matter m on m.id = r.matter_id and m.workspace_id = a.workspace_id
 where a.workspace_id = $1 and a.resolved_at is null and a.assignee_user_id = $2
 order by a.created_at desc
 limit $3`;

/**
 * A row to the wire shape.
 *
 * `reviewName` and `clauseTitle` go back ABSENT rather than
 * `undefined`-valued: `structuredClone` preserves an undefined-valued key,
 * so `clauseTitle: undefined` would read to an `in` check as a clause this
 * review still holds, unnamed.
 */
function toInboxItem(row: InboxRow): AssignmentInboxItem {
  return {
    assignment: toAssignmentView(row),
    matterId: row.matter_id,
    matterName: row.matter_name,
    ...(row.review_name ? { reviewName: row.review_name } : {}),
    ...(row.clause_title ? { clauseTitle: row.clause_title } : {}),
  };
}

export interface AssignmentRow {
  id: string;
  review_id: string;
  findings_key: string;
  clause_id: string;
  workspace_id: string;
  assignee_user_id: string;
  assigned_by_user_id: string;
  message: string | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by_user_id: string | null;
}

/**
 * A row to the wire shape.
 *
 * `message`, `resolvedAt` and `resolvedByUserId` go back ABSENT rather than
 * `null` or `undefined`-valued: `structuredClone` preserves an
 * `undefined`-valued key, so `resolvedAt: undefined` would read to an `in`
 * check as a request somebody closed.
 */
export function toAssignmentView(row: AssignmentRow): AssignmentView {
  return {
    id: row.id,
    reviewId: row.review_id,
    findingsKey: row.findings_key,
    clauseId: row.clause_id,
    assigneeUserId: row.assignee_user_id,
    assignedByUserId: row.assigned_by_user_id,
    ...(row.message === null ? {} : { message: row.message }),
    createdAt: row.created_at.getTime(),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at.getTime() }),
    ...(row.resolved_by_user_id === null
      ? {} : { resolvedByUserId: row.resolved_by_user_id }),
  };
}

function keyOf(params: unknown): FindingKey {
  const p = params as { id: string; findingsKey: string; clauseId: string };
  return { reviewId: p.id, findingsKey: p.findingsKey, clauseId: p.clauseId };
}

interface AssignBody {
  assigneeUserId: string;
  message?: string;
}

/**
 * The body, narrowed.
 *
 * There is no `assignedByUserId` field and there must not be one — the
 * assigner is the token's actor. An empty message is refused rather than
 * stored: a message that renders as a message and carries nothing sends the
 * assignee to the clause to work out what was wanted, which is the whole
 * failure the message exists to prevent.
 */
function parseAssign(body: unknown): AssignBody {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.assigneeUserId !== 'string' || b.assigneeUserId.trim() === '') {
    throw new ModelError(
      'An assignment needs somebody to assign it to (assigneeUserId).', 'unknown', 400);
  }
  if (b.message !== undefined && typeof b.message !== 'string') {
    throw new ModelError('A message must be text.', 'unknown', 400);
  }
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  return {
    assigneeUserId: b.assigneeUserId,
    ...(message === '' ? {} : { message }),
  };
}

/**
 * The assignee must be a person IN THIS WORKSPACE.
 *
 * The foreign key alone would accept any `app_user` row, which in a
 * multi-workspace database is somebody at another firm — and the request
 * would then sit in a queue they can never see, looking to the assigner
 * exactly like one that arrived.
 */
async function requireWorkspaceUser(t: Tx, userId: string, workspaceId: string): Promise<void> {
  const rows = await t.query<{ id: string }>(
    'select id from app_user where id = $1 and workspace_id = $2', [userId, workspaceId])
    .catch(() => [] as { id: string }[]);
  if (rows.length === 0) {
    throw new ModelError(
      'That person is not in your workspace, so they would never see the request.',
      'not_found', 404);
  }
}

/**
 * The finding must EXIST, in this workspace.
 *
 * A request to look at a clause this review does not cover is a request
 * addressed to nothing, and the assignee would open a review to find no such
 * clause in it. Scoped by workspace so a key from another firm's review
 * answers 404 rather than 403 — a 403 would confirm the review id exists.
 */
async function requireFinding(t: Tx, key: FindingKey, workspaceId: string): Promise<void> {
  const rows = await t.query<{ clause_id: string }>(
    `select clause_id from finding
      where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4`,
    [key.reviewId, key.findingsKey, key.clauseId, workspaceId]);
  if (rows.length === 0) {
    throw new ModelError(
      `LexPrompt has no clause ${key.clauseId} in that review.`, 'not_found', 404);
  }
}
