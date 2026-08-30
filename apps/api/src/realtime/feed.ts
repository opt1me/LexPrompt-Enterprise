import { Client } from 'pg';
import { subscriptionKey } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { EVENT_CHANNEL, readEvents } from '../run/events.ts';
import type { Hub } from './hub.ts';
import { decodePresence, PRESENCE_CHANNEL, type PresenceRegistry } from './presence.ts';

/**
 * FAN-OUT ACROSS REPLICAS: THE OUTBOX IS THE DELIVERY, THE NOTIFICATION IS
 * THE DOORBELL (§8, P39, Spike 3's answer).
 *
 * Every event is already written to `event` in the same transaction as the
 * row it describes, already carries a monotonic id, and is already read by
 * cursor with an honest `resyncRequired` past retention. So each replica
 * keeps one cursor per subscription it holds and reads FORWARD from the
 * outbox; `pg_notify`, issued in the same transaction as the insert, wakes
 * it immediately, and a replica that misses a notification catches up on the
 * next `API_HUB_TICK_MS` tick.
 *
 * > **The notification is a doorbell, never a delivery.** Nothing that
 * > matters rides in the payload — it is empty — so a lost notification
 * > costs latency and never content. That is the difference between this and
 * > a message bus, and it is what makes the mechanism correct with no
 * > delivery guarantee at all.
 *
 * No Redis. Postgres already holds the durable record and already delivers a
 * transactional notification; adding a container to every environment for a
 * property the database has is a dependency bought with nothing, plus a new
 * §5.1 divergence row, a new credential and a new thing that can be down.
 *
 * ## Nothing else publishes to the hub
 *
 * Not the disposition route, not the worker. A route that published locally
 * AND wrote the outbox would deliver twice on the replica that served the
 * write and once everywhere else, so the busiest path would be the one with
 * the different behaviour — and the local publish would be the one nobody
 * tested across replicas. One path, exercised constantly.
 */

export interface EventFeed {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reads the outbox forward once, for every subscription the hub holds.
   *  Exported on the interface so a test can drive it deterministically
   *  instead of waiting out a tick. */
  tick(): Promise<void>;
}

export interface EventFeedDeps {
  db: Db;
  hub: Hub;
  /**
   * THE ROSTER THIS REPLICA MERGES OTHER REPLICAS' BEATS INTO (Task 22).
   *
   * Presence is the ONE thing that rides the notification payload, and it
   * rides it here rather than through the outbox because it is never
   * persisted: there is no table to read a beat forward from, and there must
   * not be one (S6). It shares this connection rather than opening a second
   * `pg.Client` per replica — the `LISTEN` connection is already one per
   * replica and already named in the caps table, and a second would be a
   * second thing to reconnect, on a signal whose whole failure budget is one
   * TTL.
   *
   * A SEPARATE CHANNEL from `EVENT_CHANNEL`, deliberately. That channel's
   * handler reads nothing from its payload, by design (P39: the doorbell is
   * never the delivery), and giving it a payload to parse is exactly how the
   * doorbell quietly becomes one.
   */
  presence: PresenceRegistry;
  /**
   * A DEDICATED connection string for the `LISTEN`.
   *
   * `LISTEN` is bound to a session, and a session issued on a POOLED client
   * is lost the moment that client is returned to the pool — so the feed
   * needs its own `pg.Client` and this is a fact about `pg` rather than a
   * preference. It is also why this is a separate connection in the pool
   * arithmetic: one per replica, named in the caps table.
   */
  listenerUrl: string;
  tickMs: number;
  /** How many events one tick may read per subscription. `API_EVENT_PAGE_MAX`. */
  pageMax: number;
  /**
   * `false` disables the `LISTEN` entirely, so a test can prove THE TICK
   * ALONE is sufficient. If delivery only works with the notification on,
   * the outbox is not the delivery and a dropped `LISTEN` would be a silent
   * hole.
   */
  listen?: boolean;
  /** Where a diagnostic goes. Injected so a test can read it; defaults to
   *  stderr, where an operator will actually see it. */
  log?: (line: string) => void;
}

const bucketKey = (workspaceId: string, sub: Parameters<typeof subscriptionKey>[0]): string =>
  `${workspaceId}|${subscriptionKey(sub)}`;

export function startEventFeed(deps: EventFeedDeps): EventFeed {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /** bucket key -> the highest event id this replica has published to it. */
  const cursors = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let listener: Client | null = null;
  let stopped = false;
  let ticking = false;
  let again = false;

  /**
   * One pass over every subscription this replica holds.
   *
   * COALESCED, like `refreshFindings` in the browser and for the same
   * reason: a notification storm during a forty-cell run would otherwise
   * stack forty overlapping passes over the same rows, and two passes
   * running at once could publish the same event twice from either side of
   * the cursor write.
   */
  async function tick(): Promise<void> {
    if (stopped) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        for (const { workspaceId, sub, since } of deps.hub.active()) {
          const key = bucketKey(workspaceId, sub);
          // A bucket seen for the first time starts at the cursor its
          // JOINER reported, never at 0: the socket has already replayed
          // everything up to that point, and reading from 0 would republish
          // a review's whole seven-day buffer at every reader in it.
          const from = cursors.get(key) ?? since;
          let page;
          try {
            page = await readEvents(deps.db, {
              workspaceId, subscription: sub, after: from, limit: deps.pageMax,
            });
          } catch (err) {
            // Reported, never swallowed: a feed that has quietly stopped
            // reading is a live view that has quietly stopped being live,
            // which is the founding defect wearing a websocket.
            log(`api: event feed could not read ${key}: ${(err as Error).message}`);
            continue;
          }
          if (page.resyncRequired) {
            // The cursor fell off the back of the buffer. Every connection
            // in this bucket is told, and the cursor moves to the watermark
            // the read returned — the same exit `readEvents` gives the HTTP
            // poll, for the same reason: a cursor that could not advance
            // re-entered this branch on every tick, for ever.
            deps.hub.publish(workspaceId, sub, { t: 'resync_required', sub });
          }
          /*
           * PUBLISH FIRST, THEN ADVANCE THE CURSOR.
           *
           * The mutation this ordering exists for: advance the cursor before
           * publishing and an event goes missing under a publish that
           * throws — delivered to nobody, and never read again, because the
           * cursor says it was.
           */
          let cursor = page.nextCursor;
          for (const event of page.events) {
            deps.hub.publish(workspaceId, sub, { t: 'event', sub, event });
            cursor = Math.max(cursor, event.id);
          }
          cursors.set(key, Math.max(from, cursor));
        }
        // A bucket nobody is in any more must not keep a cursor: a later
        // reader joining it would inherit a position it never reached, and
        // its own `since` would be ignored.
        const live = new Set(deps.hub.active().map(a => bucketKey(a.workspaceId, a.sub)));
        for (const key of [...cursors.keys()]) if (!live.has(key)) cursors.delete(key);
      } while (again);
    } finally {
      ticking = false;
    }
  }

  /**
   * The `LISTEN` connection, and its own recovery.
   *
   * A dropped listener is not an outage — the tick still delivers
   * everything, one interval later — so it is reported and reconnected
   * rather than being allowed to take the process down. Saying so out loud
   * matters: the symptom of a listener that has silently gone is that live
   * change feels a second slow, which nobody reports as a fault.
   */
  async function connectListener(): Promise<void> {
    if (stopped || deps.listen === false) return;
    const client = new Client({ connectionString: deps.listenerUrl });
    client.on('error', err => {
      log(`api: event listener lost (${err.message}); the tick still delivers everything`);
      listener = null;
      if (!stopped) setTimeout(() => { void reconnect(); }, 1_000).unref?.();
    });
    client.on('notification', msg => {
      if (msg.channel === PRESENCE_CHANNEL) {
        applyPresence(msg.payload);
        return;
      }
      // On `EVENT_CHANNEL` the payload is EMPTY and this branch reads
      // nothing from it. The notification says "look now", and what to look
      // at is the outbox.
      void tick();
    });
    await client.connect();
    await client.query(`listen ${EVENT_CHANNEL}`);
    await client.query(`listen ${PRESENCE_CHANNEL}`);
    listener = client;
  }

  /**
   * A beat from another replica, applied to this one's roster.
   *
   * The `at` is REPLACED with this replica's own clock rather than trusted
   * from the sender. Two container clocks that disagree by a minute would
   * otherwise expire a whole roster instantly (a sender running slow) or
   * never (a sender running fast), and a TTL only means anything measured
   * against the clock that sweeps it.
   *
   * A payload this replica cannot read is DROPPED and reported, not guessed
   * at. The cost is one colleague missing from one roster for at most one
   * TTL, which is the correct failure for an advisory signal — and the
   * report is what stops a version skew between two replicas looking like a
   * quiet review.
   */
  function applyPresence(payload: string | undefined): void {
    const n = payload === undefined ? undefined : decodePresence(payload);
    if (!n) {
      log('api: a presence notification could not be read; that person is absent from this '
        + "replica's roster until their next beat");
      return;
    }
    const scope = { workspaceId: n.workspaceId, sub: n.sub };
    if (n.k === 'leave') {
      deps.presence.leave(n.beat.connectionId, scope);
      return;
    }
    deps.presence.beat(scope, { ...n.beat, at: Date.now() });
  }

  async function reconnect(): Promise<void> {
    if (stopped || listener) return;
    try {
      await connectListener();
      if (listener) log('api: event listener reconnected');
    } catch (err) {
      log(`api: event listener could not reconnect (${(err as Error).message}); retrying`);
      if (!stopped) setTimeout(() => { void reconnect(); }, 1_000).unref?.();
    }
  }

  return {
    async start() {
      stopped = false;
      try {
        await connectListener();
      } catch (err) {
        // NOT a startup failure. The tick is the delivery; the listener is
        // latency. Refusing to serve because a doorbell is broken would be
        // the wrong trade at exactly the moment the database is under
        // strain.
        log(`api: event listener could not start (${(err as Error).message}); `
          + `falling back to the ${deps.tickMs}ms tick`);
        setTimeout(() => { void reconnect(); }, 1_000).unref?.();
      }
      timer = setInterval(() => { void tick(); }, deps.tickMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const client = listener;
      listener = null;
      if (client) await client.end().catch(() => { /* already gone */ });
    },
    tick,
  };
}
