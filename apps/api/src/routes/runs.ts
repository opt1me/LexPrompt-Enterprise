import type { FastifyInstance } from 'fastify';
import {
  ModelError, notYetReadMessageFor, targetDocumentIds,
  type ReviewTarget, type RunEventPage, type RunView,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { createRun, readRun, settleRunIfFinished, type RunRow } from '../run/queue.ts';
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

      return createRun(t, {
        reviewId: review.id,
        matterId: review.matter_id,
        target,
        playbookSnapshot: parsedJson(review.playbook_snapshot),
      }, { id: req.actor!.id, workspaceId: ws });
    });

    // `reply.code(201)` and NOT `await reply.code(201)` — a `FastifyReply`
    // is thenable, and awaiting one means "I am sending this myself", so an
    // awaited `.code()` with no `.send()` hangs until the client gives up.
    // `documents.ts` records the afternoon that cost.
    reply.code(201);
    return run;
  });

  app.get('/v1/runs/:id', async (req): Promise<RunView> => {
    const { id } = req.params as { id: string };
    const run = await readRun(db, id, req.actor!.workspaceId);
    if (!run) throw new ModelError('There is no such run.', 'not_found', 404);
    return run;
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
  app.get('/v1/runs/:id/events', async (req): Promise<RunEventPage> => {
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
      runId: id,
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
    throw new ModelError(
      `${failed.map(r => r.name).join(', ')} could not be read, so a review of it would be a `
      + 'review of no text at all — which reads back as "the agreement is silent on this point" '
      + 'for every clause. Remove it from this review or add the file again. Nothing was started.',
      'conflict', 409);
  }
}
