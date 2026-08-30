import { subscriptionKey, type ServerFrame, type SubscriptionRef } from '@lexprompt/core';

/**
 * WHO IS LISTENING TO WHAT — and nothing about how a frame is carried.
 *
 * Three files, three concerns: `hub.ts` knows about connections and
 * subscriptions, `socket.ts` knows about frames and sockets, `feed.ts`
 * (Task 18) knows about the outbox. That separation is what lets Task 18
 * change the fan-out without touching either of the others — §8's *"the hub
 * is written behind an interface either way, so the answer changes one
 * implementation and no call sites."*
 *
 * The interface is deliberately small enough that a test can implement it.
 * `feed.pg.test.ts` does exactly that: it drives the real feed against a
 * hub that only records, and asserts about deliveries with no socket in the
 * process at all.
 */

/**
 * One live client, as the hub sees it.
 *
 * `workspaceId` is on the CONNECTION and not on the subscription, because it
 * comes from the authenticated actor and never from anything a client sent.
 * A subscription carries an id a client chose; the workspace it is read
 * within is not negotiable, and keeping the two on different objects is what
 * makes that structural rather than remembered.
 */
export interface Connection {
  /** Unique per socket, for the lifetime of the socket. */
  id: string;
  workspaceId: string;
  userId: string;
  send(frame: ServerFrame): void;
}

export interface Hub {
  /** Registers a connection BEFORE it has subscribed to anything.
   *  `size()` counts these, so the connection cap bites on a socket that
   *  opens and never subscribes -- which is exactly the shape a client
   *  holding sockets open would take. */
  open(conn: Connection): void;
  /**
   * Joins `conn` to `sub`, from the event id it has ALREADY SEEN.
   *
   * `since` is what stops the feed republishing a review's whole seven-day
   * buffer at a reader who just replayed it: the socket has caught the
   * connection up to that id itself, so the feed starts there. It is
   * recorded only for the FIRST joiner of a bucket -- a second connection
   * arriving with an older cursor gets its own backlog from its own replay,
   * and rewinding the shared feed for it would resend everything to the
   * connection that was already current.
   */
  join(conn: Connection, sub: SubscriptionRef, since: number): void;
  leave(conn: Connection, sub: SubscriptionRef): void;
  /** Sends `frame` to every connection joined to `sub` IN THAT WORKSPACE. */
  publish(workspaceId: string, sub: SubscriptionRef, frame: ServerFrame): void;
  /** Drops a connection and every subscription it held. */
  close(conn: Connection): void;
  /** Every subscription with at least one local listener, for the feed to
   *  read forward from. Returned as data rather than iterated internally so
   *  the feed owns its own cursors. */
  active(): ActiveSubscription[];
  /** How many connections this process is holding, for the cap and for the
   *  operator. */
  size(): number;
}

export interface ActiveSubscription {
  workspaceId: string;
  sub: SubscriptionRef;
  /** Where the feed should read this bucket from if it has no cursor of its
   *  own yet. See `join`. */
  since: number;
}

/**
 * The workspace is part of the key, always.
 *
 * Two firms whose reviews happen to share an id — which is possible, because
 * a review id is minted in a browser's IndexedDB and imported — must not
 * share a fan-out bucket. Without the workspace in the key, one firm's
 * disposition change would be published into the other's socket, and the
 * subscription's own read predicate would never get a chance to refuse it
 * because the frame would already have been sent.
 */
function bucketKey(workspaceId: string, sub: SubscriptionRef): string {
  return `${workspaceId}|${subscriptionKey(sub)}`;
}

export function createHub(): Hub {
  /** bucket key -> the connections listening on it. */
  const buckets = new Map<string, Set<Connection>>();
  /** connection id -> the buckets it is in, so `close` is O(its own
   *  subscriptions) rather than a sweep of every bucket in the process. */
  const held = new Map<string, { conn: Connection; keys: Map<string, ActiveSubscription> }>();
  /** bucket key -> the event id its FIRST joiner had already seen. */
  const starts = new Map<string, number>();

  return {
    open(conn) {
      if (!held.has(conn.id)) {
        held.set(conn.id, { conn, keys: new Map<string, ActiveSubscription>() });
      }
    },

    join(conn, sub, since) {
      const key = bucketKey(conn.workspaceId, sub);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new Set<Connection>();
        buckets.set(key, bucket);
      }
      bucket.add(conn);
      if (!starts.has(key)) starts.set(key, since);
      let mine = held.get(conn.id);
      if (!mine) {
        mine = { conn, keys: new Map<string, ActiveSubscription>() };
        held.set(conn.id, mine);
      }
      mine.keys.set(key, { workspaceId: conn.workspaceId, sub, since });
    },

    leave(conn, sub) {
      const key = bucketKey(conn.workspaceId, sub);
      const bucket = buckets.get(key);
      bucket?.delete(conn);
      // An empty bucket is DELETED rather than left behind: `active()` is
      // what the feed reads forward from, and a bucket nobody is in would
      // keep a cursor advancing over a review no one is watching, for the
      // life of the process.
      if (bucket && bucket.size === 0) { buckets.delete(key); starts.delete(key); }
      held.get(conn.id)?.keys.delete(key);
    },

    publish(workspaceId, sub, frame) {
      const bucket = buckets.get(bucketKey(workspaceId, sub));
      if (!bucket) return;
      for (const conn of bucket) {
        // One connection's failure must not stop the others being told. A
        // socket that has gone away throws on write, and the alternative —
        // letting it propagate — would silently drop every listener after
        // it in the set.
        try {
          conn.send(frame);
        } catch (err) {
          process.stderr.write(
            `api: could not send to connection ${conn.id}: ${(err as Error).message}\n`);
        }
      }
    },

    close(conn) {
      const mine = held.get(conn.id);
      if (!mine) return;
      for (const key of mine.keys.keys()) {
        const bucket = buckets.get(key);
        bucket?.delete(conn);
        if (bucket && bucket.size === 0) { buckets.delete(key); starts.delete(key); }
      }
      held.delete(conn.id);
    },

    active() {
      const out: ActiveSubscription[] = [];
      const seen = new Set<string>();
      for (const entry of held.values()) {
        for (const [key, active] of entry.keys) {
          if (seen.has(key)) continue;
          // A bucket the connection has left is still in nobody's map; this
          // guard is about the window where two connections held one bucket
          // and one has gone.
          if (!buckets.has(key)) continue;
          seen.add(key);
          out.push({ ...active, since: starts.get(key) ?? active.since });
        }
      }
      return out;
    },

    size() {
      return held.size;
    },
  };
}
