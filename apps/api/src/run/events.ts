import {
  isEventType,
  type AppEvent, type EventPage, type EventPayload, type EventType, type SubscriptionRef,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';

/**
 * The outbox (§8, §9, P22) — one payload vocabulary, two transports, and
 * since Stage 4 one table for the engine's progress AND for what people
 * decide.
 *
 * Nine types, three subscriptions (`review`, `matter`, `run`), one cursor.
 * A second table for human changes would be a second resume protocol and a
 * second retention policy, and a client reconnecting would have to
 * reconcile two streams whose ids mean different things.
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
  type: EventType;
  reviewId: string;
  /**
   * OPTIONAL SINCE STAGE 4. A disposition change, a note and an assignment
   * belong to no run, and `runId: ''` would reach a client as a run whose id
   * is empty — the same quiet lie `fromEventRow` used to tell on the way
   * back out.
   */
  runId?: string;
  /**
   * Optional at the CALL SITE and populated at the WRITE. See `appendEvent`:
   * the insert resolves it from `review` when a caller does not supply one,
   * so "every event carries its matter" is a property of the one writer
   * rather than of five callers remembering.
   */
  matterId?: string;
  payload: EventPayload;
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
  /*
   * THE MATTER IS RESOLVED IN THE INSERT, not by the caller.
   *
   * `event.matter_id` existed from 008 and was populated by exactly one of
   * five call sites, so §8's `matter:{id}` subscription had no data to serve
   * — the ledger's own pre-flight names this. Fixing it by adding
   * `matterId:` to the other four would be four places to forget it a sixth
   * time; the subselect makes it a property of the one writer.
   *
   * `coalesce` so a caller that DOES know (the queue, which has the review
   * in hand) pays for no lookup, and a caller that does not (the worker,
   * which holds a `run` row, and `run` has no matter column) still writes a
   * complete row. The subselect runs in the caller's transaction against
   * `review`, which both the app role and the worker role hold `select` on.
   */
  const rows = await t.query<{ id: string | number }>(
    `insert into event (workspace_id, matter_id, review_id, run_id, type, payload)
     select $1, coalesce($2, (select matter_id from review where id = $3 and workspace_id = $1)),
            $3, $4, $5, $6::jsonb
     returning id`,
    [e.workspaceId, e.matterId ?? null, e.reviewId, e.runId ?? null, e.type,
      JSON.stringify(e.payload)],
  );
  /*
   * THE DOORBELL, IN THE SAME TRANSACTION AS THE INSERT (Task 18, P39).
   *
   * Here rather than beside the call or in the route: `appendEvent` is
   * already the one writer and already takes a `Tx`, and a `pg_notify`
   * issued in the same transaction fires ON COMMIT and not before. A
   * notification sent OUTSIDE the transaction can wake a replica that then
   * reads the outbox before the insert has committed, finds nothing, and
   * never comes back — a lost event that no test written against a single
   * process would ever produce.
   *
   * THE PAYLOAD IS EMPTY, deliberately. The notification says "look now";
   * what to look at is this table. Nothing that matters rides in it, so a
   * lost notification costs latency and never content — which is the whole
   * difference between this and a message bus, and what makes the mechanism
   * correct with no delivery guarantee at all.
   */
  await t.query('select pg_notify($1, $2)', [EVENT_CHANNEL, '']);
  return Number(rows[0].id);
}

/**
 * The channel `pg_notify` rings and `realtime/feed.ts` listens on.
 *
 * Named here, beside the one writer, because a channel name spelt two ways
 * is a doorbell nobody hears — and the symptom is not an outage but live
 * change feeling one tick slow, which nobody reports as a fault.
 */
export const EVENT_CHANNEL = 'lexprompt_event';

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * A row to the wire shape.
 *
 * An unrecognised `type` is refused rather than passed through. The nine
 * types are a closed vocabulary both sides read (`EVENT_TYPES` in core);
 * a tenth arriving from a database somebody wrote to by hand would reach a
 * client's switch statement, match nothing, and be dropped in silence —
 * which is exactly the "a hole it cannot see" shape this whole module exists
 * to avoid.
 */
export function fromEventRow(row: EventRow): AppEvent {
  if (!isEventType(row.type)) {
    throw new Error(
      `Event ${row.id} has type ${JSON.stringify(row.type)}, which is not one of the nine this `
      + 'system emits. Nothing reads it, so returning it would put an event on the wire that '
      + 'every client silently drops.',
    );
  }
  return {
    id: Number(row.id),
    type: row.type,
    workspaceId: row.workspace_id,
    // ABSENT, not `''`. The old empty strings were written for the five
    // run-only types, where they were always populated and the coercion
    // never showed; a disposition change belongs to no run, and `runId: ''`
    // reads to a client as a run whose id is empty. Spread-on-condition
    // rather than `?? undefined`, because `structuredClone` preserves an
    // undefined-valued key and an `in` check would then find a run that is
    // not there.
    ...(row.matter_id === null ? {} : { matterId: row.matter_id }),
    ...(row.review_id === null ? {} : { reviewId: row.review_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    at: row.at.getTime(),
    payload: parsedJson(row.payload) as EventPayload,
  };
}

export interface ReadEventsOptions {
  workspaceId: string;
  /** §8's three subscriptions. One shape, one predicate — see `predicateFor`. */
  subscription: SubscriptionRef;
  /** The client's cursor: the id of the last event it applied. `0` means
   *  "from the beginning", which never triggers a resync. */
  after: number;
  /** Bounded by `API_EVENT_PAGE_MAX` at the call site; a caller asking for
   *  more gets the cap, never an unbounded read. */
  limit: number;
}

/**
 * ONE PREDICATE PER SUBSCRIPTION SHAPE, each written as a WHOLE LITERAL.
 *
 * Not `` `... and ${column} = $2` `` with the column name interpolated. Three
 * whole strings is three statements `workspaceScope.test.ts`'s extractor can
 * read; a name spliced into a template is a statement no scanner can see the
 * predicate of, and this module is already outside that guard by design —
 * which is a reason to be MORE legible here, not less.
 *
 * Every shape carries `workspace_id`. A subscription is named by a client,
 * so the id in it is exactly the "id out of a URL" shape §19 warns about:
 * without the predicate, `{ review: <another firm's review> }` would be fed
 * that review's events for as long as the socket stayed open.
 */
function predicateFor(sub: SubscriptionRef): { sql: string; id: string } {
  if ('review' in sub) {
    return {
      sql: 'select * from event where workspace_id = $1 and review_id = $2 and id > $3'
        + ' order by id asc limit $4',
      id: sub.review,
    };
  }
  if ('matter' in sub) {
    return {
      sql: 'select * from event where workspace_id = $1 and matter_id = $2 and id > $3'
        + ' order by id asc limit $4',
      id: sub.matter,
    };
  }
  return {
    sql: 'select * from event where workspace_id = $1 and run_id = $2 and id > $3'
      + ' order by id asc limit $4',
    id: sub.run,
  };
}

/**
 * A page of one subscription's events, oldest first, plus the honest answer
 * when the cursor has fallen off the back of the buffer.
 *
 * The resync test compares the cursor against `min(id)` over the WHOLE
 * table, not against this SUBSCRIPTION's own oldest surviving event. That is
 * deliberate: ids are allocated monotonically and the pruner deletes by AGE,
 * so everything below the table's minimum id is gone and everything at or
 * above it survives. Comparing against this subscription's own minimum would report a
 * resync for every client that connected before its first event was
 * written, which is every client -- and the predicate getting wider in
 * Stage 4 does not change that argument, it only widens what would have
 * been compared.
 *
 * `after >= min - 1` is continuity: the very next id after the cursor is
 * still present, so nothing between them was dropped.
 */
export async function readEvents(db: Db, opts: ReadEventsOptions): Promise<EventPage> {
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
  const { sql, id } = predicateFor(opts.subscription);
  const rows = await db.query<EventRow>(
    sql, [opts.workspaceId, id, opts.after, opts.limit + 1]);

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
