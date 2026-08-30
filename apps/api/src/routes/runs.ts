import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../audit/write.ts';
import {
  ModelError, couldNotBeReadMessageFor, notYetReadMessageFor, targetDocumentIds,
  type RetryCleared, type RetryResult, type ReviewTarget, type EventPage, type RunView,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { cellsFor, createRun, readRun, settleRunIfFinished, type RunRow } from '../run/queue.ts';
import { dispositionFor } from '../dispositions/service.ts';
import { readEvents } from '../run/events.ts';
import { cancelPendingCells } from '../run/lifecycle.ts';

/**
 * The queue's four routes (§9).
 *
 * `POST /v1/reviews/:id/runs` creates and RETURNS; it does not execute. The
 * response is the run, not the results — a review of forty cells against a
 * five-minute-per-cell model is not a request anybody can hold open, and the
 * whole of this stage is that the work outlives the request that asked for
 * it.
 */

export interface RunRoutesConfig {
  /** `API_EVENT_PAGE_MAX`. A caller asking for more gets this, never an
   *  unbounded read: the outbox is the one table a client can ask to be
   *  handed in full, and a run of forty cells writes eighty-odd events. */
  eventPageMax: number;
}

function intParam(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ModelError(
      `LexPrompt could not read this request (${JSON.stringify(raw)} is not a whole number).`,
      'unknown', 400);
  }
  return n;
}

export function registerRuns(app: FastifyInstance, db: Db, config: RunRoutesConfig): void {
  app.post('/v1/reviews/:id/runs', async (req, reply): Promise<RunView> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };

    const run = await db.tx(async t => {
      const reviews = await t.query<{
        id: string; matter_id: string; target: unknown; playbook_snapshot: unknown;
      }>(
        // ONE literal, not two concatenated. `workspaceScope.test.ts` reads
        // string literals out of the source and checks the predicate region
        // of each; a statement split across a `+` puts `from review` in one
        // literal and `where … workspace_id` in another, and the first is
        // then reported as an unscoped read of another firm's matters. The
        // guard is right to: a statement it cannot read whole is a statement
        // nothing is checking.
        `select id, matter_id, target, playbook_snapshot from review
          where id = $1 and workspace_id = $2`, [id, ws]);
      if (!reviews[0]) throw new ModelError('There is no such review.', 'not_found', 404);
      const review = reviews[0];
      const target = parsedJson(review.target) as ReviewTarget;

      // REFUSAL ONE: one live run per review.
      //
      // Two concurrent runs over one review would be two writers per
      // finding, which is the thing this stage exists to end. The unique
      // partial index in 008 is what makes this true under a race this
      // SELECT cannot see; the SELECT is what makes the refusal a sentence
      // instead of a constraint name.
      const live = await t.query<{ id: string; state: string }>(
        `select id, state from run where review_id = $1 and workspace_id = $2
          and state in ('queued','running','cancelling')`, [id, ws]);
      if (live[0]) {
        throw new ModelError(
          `This review is already running (run ${live[0].id} is ${live[0].state}). Wait for it `
          + 'to finish, or cancel it, before starting another.', 'conflict', 409);
      }

      // REFUSAL TWO: §11's third load state, ENFORCED rather than rendered
      // around.
      //
      // A document still being read has no text yet, and a review of a
      // document with no text is this project's founding defect — the model
      // answers "the agreement is silent on this point" for every clause,
      // fluently, with nothing on the card to say the text never arrived. A
      // document whose parse FAILED is worse to run: it has an error message
      // nobody would see.
      await refuseUnparsedDocuments(t, ws, target);

      const created = await createRun(t, {
        reviewId: review.id,
        matterId: review.matter_id,
        target,
        playbookSnapshot: parsedJson(review.playbook_snapshot),
      }, { id: req.actor!.id, workspaceId: ws });
      // In `createRun`'s own transaction (S11), so a run that failed to
      // start records nothing. `run.started` is the act; the run's own
      // `event` rows are its progress, and the two are not the same log.
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'run.started',
        subjectType: 'run', subjectId: created.id,
        ...(review.matter_id ? { matterId: review.matter_id } : {}),
        reviewId: review.id,
        detail: { runState: created.state },
      });
      return created;
    });

    // `reply.code(201)` and NOT `await reply.code(201)` — a `FastifyReply`
    // is thenable, and awaiting one means "I am sending this myself", so an
    // awaited `.code()` with no `.send()` hangs until the client gives up.
    // `documents.ts` records the afternoon that cost.
    reply.code(201);
    return run;
  });

  /**
   * ONE CLAUSE, RE-RUN — and the reset that goes with it, in ONE transaction
   * (§9.1, §18 item 4).
   *
   * This is `handleRetryCell`'s rule moved to where the row is. The browser
   * did it in three writes it could not make atomic; here the finding is
   * blanked, the disposition is cleared and the clearing is RECORDED, all in
   * the transaction that queues the work — so there is no instant at which a
   * `verified` disposition sits beside content nobody has seen.
   *
   * Three things it must not do, each of which the shipped browser code gets
   * right and a fresh implementation would get wrong:
   *
   *  - **It runs in the request handler, never in the worker** (S21). A
   *    person asked for this. The worker's role holds no grant on either
   *    disposition table, so putting it there would not merely be wrong — it
   *    would fail, which is the point of the grant.
   *  - **It attributes to the person who asked**, not to `'system'` and not
   *    to whoever last held the disposition. §9.1: that is what lets an
   *    export say *"unchecked — re-run by A. Gray at 11:07, previously
   *    verified by R. Okafor"*.
   *  - **The disposition row is UPDATED, never deleted.** Deleting it would
   *    lose who last held it and leave the history's `from_state` with
   *    nothing to be read against.
   *
   * A COLLECTION clause is retried through the collection extractor, and
   * there is no path by which it is not: the cell's `findings_key` is the
   * collection id, because that is the only key `cellsFor` produces for a
   * collection target, and Task 10's dispatch reads the review's own target.
   * The browser's own comment says what the alternative costs — *"replace
   * that synthesis with a one-document answer, on screen indistinguishable
   * from a correct re-run."*
   *
   * Notes are NOT touched: a note is a person's remark about the clause, not
   * a component of their judgement on one answer.
   */
  app.post('/v1/reviews/:id/findings/:findingsKey/:clauseId/retry',
    async (req, reply): Promise<RetryResult> => {
      const ws = req.actor!.workspaceId;
      const p = req.params as { id: string; findingsKey: string; clauseId: string };

      const result = await db.tx(async t => {
        const reviews = await t.query<{
          id: string; matter_id: string; target: unknown; playbook_snapshot: unknown;
        }>(
          `select id, matter_id, target, playbook_snapshot from review
            where id = $1 and workspace_id = $2`, [p.id, ws]);
        if (!reviews[0]) throw new ModelError('There is no such review.', 'not_found', 404);
        const review = reviews[0];
        const target = parsedJson(review.target) as ReviewTarget;
        const snapshot = parsedJson(review.playbook_snapshot);

        // THE SAME REFUSAL A WHOLE-REVIEW RUN MAKES, for the same reason:
        // two writers per finding is what this stage exists to end. A retry
        // while a run is live would also race that run's own answer for this
        // very cell.
        const live = await t.query<{ id: string; state: string }>(
          `select id, state from run where review_id = $1 and workspace_id = $2
            and state in ('queued','running','cancelling')`, [p.id, ws]);
        if (live[0]) {
          throw new ModelError(
            `This review is already running (run ${live[0].id} is ${live[0].state}). Wait for it `
            + 'to finish, or cancel it, before re-running a clause.', 'conflict', 409);
        }

        // THE KEY AND THE CLAUSE, CHECKED AGAINST WHAT THIS REVIEW CLAIMS TO
        // COVER — through `cellsFor`, which goes through `findingsKeyFor`
        // and is the only place a findings key is decided. One check answers
        // three questions: is this clause in the snapshot the review ran
        // against, does this key belong to this target, and — for a
        // collection — is it the COLLECTION's key rather than one of its
        // documents'. Six defects in sub-project C came from code that
        // answered the third by picking a document.
        const cell = cellsFor(target, snapshot).find(
          c => c.findingsKey === p.findingsKey && c.clauseId === p.clauseId);
        if (!cell) {
          throw new ModelError(
            `Clause ${p.clauseId} under ${p.findingsKey} is not one this review covers, so there `
            + 'is nothing to re-run.', 'not_found', 404);
        }

        // The finding has to exist before its judgement can be cleared, and
        // WHAT IT HELD is read here — before anything is written — because
        // the browser composes its notice from what was actually cleared
        // rather than from its own copy.
        const findings = await t.query<{ net_position: unknown }>(
          `select net_position from finding
            where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4`,
          [p.id, p.findingsKey, p.clauseId, ws]);
        if (!findings[0]) {
          throw new ModelError(
            `There is no finding for clause ${p.clauseId} under ${p.findingsKey} in this review, `
            + 'so there is nothing to re-run.', 'not_found', 404);
        }
        const disposition = await dispositionFor(
          t, { reviewId: p.id, findingsKey: p.findingsKey, clauseId: p.clauseId });
        const position = parsedJson(findings[0].net_position) as { state?: string } | null;
        const cleared: RetryCleared = {
          verification: disposition !== undefined && disposition.state !== 'unchecked',
          // The browser's own predicate: an UNCONFIRMED position is not a
          // judgement anybody made, so clearing it clears nothing.
          netPosition: position !== null && position !== undefined
            && position.state !== 'unconfirmed',
        };

        await refuseUnparsedDocuments(t, ws, target);

        // ONE TRANSACTION, and it is `createRun`'s — the finding back to
        // `pending` with its net position cleared, the disposition cleared
        // through `setDisposition` with cause `rerun_reset`, the event that
        // records the clearing, the cell queued and `run.started` appended.
        // Over ONE cell rather than all of them; see `createRun`'s `only`.
        const run = await createRun(t, {
          reviewId: review.id,
          matterId: review.matter_id,
          target,
          playbookSnapshot: snapshot,
        }, { id: req.actor!.id, workspaceId: ws }, [cell]);

        return { run, cleared };
      });

      reply.code(201);
      return result;
    });

  app.get('/v1/runs/:id', async (req): Promise<RunView> => {
    const { id } = req.params as { id: string };
    const run = await readRun(db, id, req.actor!.workspaceId);
    if (!run) throw new ModelError('There is no such run.', 'not_found', 404);
    return run;
  });

  /**
   * THE REVIEW'S LIVE RUN, IF IT HAS ONE — and the whole point of the stage,
   * seen from the reader's side.
   *
   * A run used to live in React state and die with the tab. It is a row now,
   * so a review opened in another tab, or after a reload, or by a colleague,
   * can be picked up and watched to completion. Without this route the
   * browser would have no way to ASK, and "the work outlives the request
   * that asked for it" would be true of the server and invisible to the
   * person who started it.
   *
   * `null` — 200, not 404 — for a review with no live run. That is a fact
   * about the review, not a failure to find it, and the difference matters
   * at exactly the place this codebase keeps insisting it does: a 404 here
   * would be indistinguishable from "there is no such review", and the
   * browser would show a load error over a review that is simply idle. The
   * review's own existence IS checked, so a bad id still answers 404.
   *
   * There is at most one, enforced by 008's unique partial index — the same
   * fact the two refusals above rest on.
   */
  app.get('/v1/reviews/:id/runs/live', async (req): Promise<RunView | null> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const reviews = await db.query<{ id: string }>(
      'select id from review where id = $1 and workspace_id = $2', [id, ws]);
    if (!reviews[0]) throw new ModelError('There is no such review.', 'not_found', 404);

    const live = await db.query<{ id: string }>(
      `select id from run where review_id = $1 and workspace_id = $2
        and state in ('queued','running','cancelling')`, [id, ws]);
    if (!live[0]) return null;
    return (await readRun(db, live[0].id, ws))!;
  });

  /**
   * Cancel: a person asked it to stop, which is NOT a failure.
   *
   * Everything already completed stays completed — a `done` cell is never
   * rewritten, because a cancelled run is real, partial work and a reviewer
   * is entitled to what it found. What must not survive is a cell in
   * `queued` or a finding in `pending`: *"an abandoned run reopening with
   * every cell spinning forever, unfinishable"* is on `CLAUDE.md`'s list of
   * defects this project has already shipped.
   *
   * A LEASED cell is left to the worker holding it. It checks
   * `cancel_requested_at` between cells and aborts the call in flight, then
   * releases the cell as `cancelled` itself — which is the only way the
   * write it may already have started cannot land on a cell this route has
   * declared finished.
   */
  app.post('/v1/runs/:id/cancel', async (req): Promise<RunView> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };

    return db.tx(async t => {
      const rows = await t.query<RunRow>(
        'select * from run where id = $1 and workspace_id = $2 for update', [id, ws]);
      if (!rows[0]) throw new ModelError('There is no such run.', 'not_found', 404);
      const run = rows[0];

      // Idempotent on a run that has already ended. Cancelling a finished
      // run is not an error a person needs to see — they asked for it to
      // stop and it has — but it must not rewrite `succeeded` into
      // `cancelled`, which would make a complete review read as a partial
      // one.
      if (run.state === 'cancelled' || run.state === 'succeeded' || run.state === 'failed') {
        const settled = await readRun(dbOnTx(t), id, ws);
        return settled!;
      }

      await t.query(
        `update run set state = 'cancelling', cancel_requested_at = coalesce(cancel_requested_at, now()),
                        version = version + 1
          where id = $1 and workspace_id = $2`, [id, ws]);
      await cancelPendingCells(t, run.id, run.review_id, ws);
      // A run nobody had started yet, or one whose workers had already
      // released every lease, ends HERE rather than waiting for a worker to
      // notice. There may be no worker: the pool can be busy, or the API can
      // have restarted since.
      await settleRunIfFinished(t, id, ws);

      // AFTER the state moved and only when this request is what moved it —
      // the already-ended branch above returns before reaching here, so a
      // second cancel of a finished run audits nothing.
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'run.cancelled',
        subjectType: 'run', subjectId: id,
        reviewId: run.review_id,
        detail: { stateBefore: run.state },
      });

      const settled = await readRun(dbOnTx(t), id, ws);
      return settled!;
    });
  });

  /**
   * The cursor Stage 4 inherits (P22).
   *
   * The same `after`/`resyncRequired` protocol §8 gives a reconnecting
   * WebSocket, expressed over HTTP — so Stage 4 adds a transport rather than
   * inventing a second contract. `resyncRequired` is the honest answer past
   * retention; see `run/events.ts` for why a silently short page is the
   * failure.
   */
  app.get('/v1/runs/:id/events', async (req): Promise<EventPage> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const query = (req.query ?? {}) as Record<string, unknown>;

    // The run's existence is checked FIRST, so an id from another workspace
    // answers 404 rather than an empty page — an empty page would be
    // indistinguishable from a run that has not started, which is precisely
    // the empty-versus-broken confusion this codebase has a rule about.
    const exists = await db.query<{ id: string }>(
      'select id from run where id = $1 and workspace_id = $2', [id, ws]);
    if (!exists[0]) throw new ModelError('There is no such run.', 'not_found', 404);

    const requested = intParam(query.limit, config.eventPageMax);
    return readEvents(db, {
      workspaceId: ws,
      // This route is and stays the RUN's events. The review and matter
      // subscriptions are the socket's (§8) and have no HTTP equivalent by
      // design: a poll over a whole matter would be a second, slower way to
      // do the thing the socket exists for.
      subscription: { run: id },
      after: intParam(query.after, 0),
      limit: Math.max(1, Math.min(config.eventPageMax, requested)),
    });
  });
}

/** A `Db` over a pinned `Tx`, so the read helpers can run inside the
 *  transaction that just wrote. The same wrapper `pgHarness.dbOn` builds for
 *  tests, needed here for the same reason: a second connection would read
 *  outside the transaction and see the state before the write. */
function dbOnTx(t: Tx): Db {
  return { query: (text, values) => t.query(text, values), tx: run => t.tx(run) };
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * §11's third load state: a document that has not finished being read is not
 * a document a review may run over.
 *
 * Named per document, in the message, because "one of your documents is not
 * ready" sends a reviewer to look at all of them.
 */
async function refuseUnparsedDocuments(
  t: Tx, workspaceId: string, target: ReviewTarget,
): Promise<void> {
  const ids = targetDocumentIds(target);
  if (ids.length === 0) return;
  const rows = await t.query<{ id: string; name: string; parse_state: string }>(
    'select id, name, parse_state from document where workspace_id = $1 and id = any($2::text[])',
    [workspaceId, ids]);

  const found = new Map(rows.map(r => [r.id, r]));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) {
    throw new ModelError(
      `This review names ${missing.length === 1 ? 'a document' : 'documents'} LexPrompt no `
      + `longer has (${missing.join(', ')}). Nothing was started.`, 'conflict', 409);
  }
  const pending = rows.filter(r => r.parse_state === 'pending');
  const failed = rows.filter(r => r.parse_state === 'failed');
  if (pending.length > 0) {
    // The sentence is `@lexprompt/core`'s, shared with both hydrations on
    // each side and with the browser's own pre-flight. This refusal was the
    // ONLY reader of `parse_state` anywhere, which is how a blanked `text`
    // reached a review through every other door.
    throw new ModelError(notYetReadMessageFor(pending.map(r => r.name)), 'conflict', 409);
  }
  if (failed.length > 0) {
    // The sentence is `@lexprompt/core`'s, exactly as the pending one above
    // is. It was written out here and then a second time in the browser's
    // pre-flight, which is the drift this project keeps paying for.
    throw new ModelError(couldNotBeReadMessageFor(failed.map(r => r.name)), 'conflict', 409);
  }
}
