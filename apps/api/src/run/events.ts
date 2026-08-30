import {
  isRunEventType,
  type RunEvent, type RunEventPage, type RunEventPayload, type RunEventType,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';

/**
 * The run outbox (§8, §9, P22) — one payload vocabulary, two transports.
 *
 * ## `appendEvent` writes in the CALLER'S transaction, never its own
 *
 * It takes a `Tx`, not a `Db`, and that signature is the rule. An event
 * committed while the row it describes rolled back is a client told about a
 * finding that does not exist — the network-era form of every defect on
 * `CLAUDE.md`'s list, and the worse half of it, because the client has no
 * way to find out. Taking a `Db` here would make the correct usage the
 * careful one; taking a `Tx` makes the incorrect one unspellable.
 *
 * ## Retention, and the honest answer past it
 *
 * The outbox keeps `API_EVENT_RETENTION_DAYS` — "a reconnection buffer, not
 * an archive" (§6.5). A cursor older than the oldest surviving event gets
 * `{ resyncRequired: true }` rather than a silently short list. **Silently
 * short is the failure**: a client that asked for everything after 400 and
 * received everything after 900 has a hole it cannot see, and every screen
 * built on it renders a run that is missing findings as one that is missing
 * nothing.
 */

export interface EventToAppend {
  workspaceId: string;
  type: RunEventType;
  reviewId: string;
  runId: string;
  matterId?: string;
  payload: RunEventPayload;
}

export interface EventRow {
  id: string | number;
  workspace_id: string;
  matter_id: string | null;
  review_id: string | null;
  run_id: string | null;
  type: string;
  payload: unknown;
  at: Date;
}

/**
 * One event, in the caller's transaction.
 *
 * The `payload` is a JSON STRING with an explicit `::jsonb` cast, the same
 * way every other jsonb parameter in this codebase is written — `pg` cannot
 * tell an array parameter meant as `jsonb` from one meant as `text[]`, and
 * getting it wrong is a cryptic runtime type error rather than a typecheck
 * one (`db/rows.ts` says the same at length).
 */
export async function appendEvent(t: Tx, e: EventToAppend): Promise<number> {
  const rows = await t.query<{ id: string | number }>(
    `insert into event (workspace_id, matter_id, review_id, run_id, type, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id`,
    [e.workspaceId, e.matterId ?? null, e.reviewId, e.runId, e.type, JSON.stringify(e.payload)],
  );
  return Number(rows[0].id);
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * A row to the wire shape.
 *
 * An unrecognised `type` is refused rather than passed through. The five
 * types are a closed vocabulary both sides read (`RUN_EVENT_TYPES` in core);
 * a sixth arriving from a database somebody wrote to by hand would reach a
 * client's switch statement, match nothing, and be dropped in silence —
 * which is exactly the "a hole it cannot see" shape this whole module exists
 * to avoid.
 */
export function fromEventRow(row: EventRow): RunEvent {
  if (!isRunEventType(row.type)) {
    throw new Error(
      `Event ${row.id} has type ${JSON.stringify(row.type)}, which is not one of the five this `
      + 'system emits. Nothing reads it, so returning it would put an event on the wire that '
      + 'every client silently drops.',
    );
  }
  return {
    id: Number(row.id),
    type: row.type,
    reviewId: row.review_id ?? '',
    runId: row.run_id ?? '',
    at: row.at.getTime(),
    payload: parsedJson(row.payload) as RunEventPayload,
  };
}

export interface ReadEventsOptions {
  workspaceId: string;
  runId: string;
  /** The client's cursor: the id of the last event it applied. `0` means
   *  "from the beginning", which never triggers a resync. */
  after: number;
  /** Bounded by `API_EVENT_PAGE_MAX` at the call site; a caller asking for
   *  more gets the cap, never an unbounded read. */
  limit: number;
}

/**
 * A page of a run's events, oldest first, plus the honest answer when the
 * cursor has fallen off the back of the buffer.
 *
 * The resync test compares the cursor against `min(id)` over the WHOLE
 * table, not against this run's own oldest surviving event. That is
 * deliberate: ids are allocated monotonically and the pruner deletes by AGE,
 * so everything below the table's minimum id is gone and everything at or
 * above it survives. Comparing against this run's own minimum would report a
 * resync for every client that connected before its run's first event was
 * written, which is every client.
 *
 * `after >= min - 1` is continuity: the very next id after the cursor is
 * still present, so nothing between them was dropped.
 */
export async function readEvents(db: Db, opts: ReadEventsOptions): Promise<RunEventPage> {
  const watermark = await db.query<{ oldest: string | number | null }>(
    'select min(id) as oldest from event');
  const oldest = watermark[0]?.oldest === null || watermark[0]?.oldest === undefined
    ? null
    : Number(watermark[0].oldest);

  // `after === 0` is a fresh client asking for everything, and there is
  // nothing it could be missing. Anything else has to be provably
  // continuous with what survives.
  if (opts.after > 0 && (oldest === null || opts.after < oldest - 1)) {
    /*
     * THE CURSOR MOVES TO THE WATERMARK, AND THAT IS THE WHOLE FIX.
     *
     * It used to come back as `opts.after`, unchanged, on the argument that
     * a client whose cursor fell off the back of the buffer should not be
     * handed a position it never reached. That argument produced a watch
     * with NO EXIT. `oldest` is `min(id)` over `event` and only ever
     * increases; the client's own loop advances its cursor from the events
     * it applied and from `nextCursor`, and this branch returns neither —
     * so a watch that entered this state re-entered it on every poll, for
     * the life of the page. A `GET …/events` every second, `run.finished`
     * NEVER DELIVERED, `finishRun` never called, the banner saying the
     * review is still running for ever, and `completedAt` never written —
     * so reopening the review showed `RunInterruptedBanner` for a run that
     * had succeeded. A job that finished looking like a job still working,
     * which is the inversion of this module's own rule.
     *
     * `oldest - 1` is the honest answer, and it is the same continuity test
     * this branch is written from, one step later: everything at or above
     * `oldest` survives, so a cursor of `oldest - 1` is provably continuous
     * with the whole of what is left. The client is told `resyncRequired`
     * in the same breath, so it re-reads the state the lost events
     * described rather than pretending it saw them.
     *
     * `oldest === null` — the `event` table is empty, everything ever
     * written has been pruned — cannot advance to anything, so the cursor
     * stays put. That is not a loop with no exit for the same reason: the
     * next event written anywhere gets an id above the cursor, this branch
     * fires once more, and the cursor moves to it. What that client has
     * genuinely lost is a `run.finished` that was pruned before it read it,
     * which no cursor can recover — `onResync` is why the browser re-reads
     * the RUN as well as its findings.
     */
    return {
      events: [],
      nextCursor: oldest === null ? opts.after : oldest - 1,
      hasMore: false,
      resyncRequired: true,
    };
  }

  // limit + 1, so `hasMore` is a fact rather than a guess. A page that
  // returned exactly `limit` rows and reported `hasMore: false` would stop a
  // client one page short of a run's own `run.finished`.
  const rows = await db.query<EventRow>(
    `select * from event
      where workspace_id = $1 and run_id = $2 and id > $3
      order by id asc
      limit $4`,
    [opts.workspaceId, opts.runId, opts.after, opts.limit + 1]);

  const hasMore = rows.length > opts.limit;
  const page = (hasMore ? rows.slice(0, opts.limit) : rows).map(fromEventRow);
  return {
    events: page,
    nextCursor: page.length > 0 ? page[page.length - 1].id : opts.after,
    hasMore,
  };
}

/**
 * The pruner. Deletes events older than `retentionDays` and reports how
 * many, because a sweeper that says nothing is one nobody can tell from a
 * sweeper that is not running.
 *
 * Runs on the APP connection beside the reaper — the worker has no delete
 * grant on `event` and should not have one (008).
 */
export async function pruneEvents(db: Db, retentionDays: number): Promise<number> {
  const rows = await db.query<{ id: string | number }>(
    "delete from event where at < now() - ($1 || ' days')::interval returning id",
    [String(retentionDays)]);
  return rows.length;
}
