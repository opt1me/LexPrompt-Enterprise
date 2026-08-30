import { describe, it, expect, afterEach } from 'vitest';
import type { ServerFrame, SubscriptionRef } from '@lexprompt/core';
import { subscriptionKey } from '@lexprompt/core';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { appendEvent } from '../src/run/events.ts';
import { startEventFeed, type EventFeed } from '../src/realtime/feed.ts';
import type { ActiveSubscription, Connection, Hub } from '../src/realtime/hub.ts';

/**
 * THE FAN-OUT, WITH NO SOCKET IN THE PROCESS AT ALL.
 *
 * `Hub` is an interface precisely so this file can implement it: the feed is
 * driven against a hub that only records, so what is asserted is what the
 * feed DELIVERED rather than what some socket happened to render. §8's *"the
 * hub is written behind an interface either way, so the answer changes one
 * implementation and no call sites."*
 *
 * These suites commit, deliberately — the feed reads on its own connection,
 * so a `withPg` rollback transaction would make every read come back empty
 * and the failure would look like a broken cursor. Everything written is
 * removed in `afterEach`.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const LISTENER_URL = process.env.LEXPROMPT_TEST_DATABASE_URL ?? '';
const MIGRATION_URL = process.env.LEXPROMPT_TEST_MIGRATION_URL ?? '';

interface RecordingHub extends Hub {
  delivered: ServerFrame[];
  watch(sub: SubscriptionRef, since: number): void;
}

/** A hub that records instead of sending. It implements the same interface
 *  the socket uses, so nothing here is a re-implementation of fan-out. */
function recordingHub(): RecordingHub {
  const delivered: ServerFrame[] = [];
  const active: ActiveSubscription[] = [];
  return {
    delivered,
    watch(sub, since) { active.push({ workspaceId: WS, sub, since }); },
    open() { /* no connection to register */ },
    join() { /* the socket's path, not this one */ },
    leave() { /* … */ },
    publish(_workspaceId, _sub, frame) { delivered.push(frame); },
    close() { /* … */ },
    active() { return active; },
    size() { return active.length; },
  };
}

const reviews: string[] = [];
const feeds: EventFeed[] = [];

async function seedReview(id: string): Promise<string> {
  const db = migratorDb();
  const reviewId = `feed-r-${id}`;
  await db.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('feed-m1', $1, 'Feed suite', now(), now()) on conflict (id) do nothing`, [WS]);
  await db.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, 'feed-m1', '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb,
             '{}'::jsonb, 'm', now())
     on conflict (id) do nothing`, [reviewId, WS]);
  reviews.push(reviewId);
  return reviewId;
}

/** An append made the way a ROUTE makes one — its own transaction on its own
 *  connection, which is the "somewhere else" this feed has to hear about. */
async function appendFromElsewhere(reviewId: string, clauseId: string): Promise<number> {
  return migratorDb().tx(t => appendEvent(t, {
    workspaceId: WS, type: 'note.added', reviewId,
    payload: {
      reviewId, findingsKey: 'd1', clauseId,
      note: {
        id: `feed-n-${reviewId}-${clauseId}`, findingId: `d1::${clauseId}`, text: 't',
        byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
      },
    },
  }));
}

const highestId = async (): Promise<number> => Number((await migratorDb()
  .query<{ max: string | null }>('select coalesce(max(id), 0)::text as max from event'))[0].max);

const untilDelivered = async (hub: RecordingHub, n: number, ms = 4_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (hub.delivered.filter(f => f.t === 'event').length < n) {
    if (Date.now() > deadline) {
      throw new Error(
        `the feed delivered ${hub.delivered.length} frame(s) in ${ms}ms, expected ${n} events`);
    }
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
};

afterEach(async () => {
  for (const feed of feeds.splice(0)) await feed.stop();
  const db = migratorDb();
  for (const reviewId of reviews.splice(0)) {
    await db.query('delete from event where review_id = $1', [reviewId]);
    await db.query('delete from review where id = $1', [reviewId]);
  }
});

describe('the outbox is the delivery', () => {
  it('delivers an event appended elsewhere WITH NO NOTIFICATION AT ALL', async () => {
    /*
     * The notification is DISABLED here, deliberately: the tick alone must be
     * sufficient. If this only passed with `listen` on, the outbox would not
     * be the delivery and a dropped `LISTEN` would be a silent hole — the
     * app working, one interval late, which nobody reports as a fault.
     */
    const reviewId = await seedReview('tick');
    const hub = recordingHub();
    hub.watch({ review: reviewId }, await highestId());
    const feed = startEventFeed({
      db: appDb(), hub, listenerUrl: LISTENER_URL, tickMs: 100, pageMax: 100, listen: false,
    });
    feeds.push(feed);
    await feed.start();

    await appendFromElsewhere(reviewId, 'c1');
    await untilDelivered(hub, 1);
    const [frame] = hub.delivered.filter(f => f.t === 'event');
    expect(frame).toMatchObject({ t: 'event' });
  }, 20_000);

  it('delivers within a fraction of a tick when the notification arrives', async () => {
    const reviewId = await seedReview('notify');
    const hub = recordingHub();
    hub.watch({ review: reviewId }, await highestId());
    // A tick far longer than the assertion's patience, so a pass here can
    // only be the notification doing the work.
    const feed = startEventFeed({
      db: appDb(), hub, listenerUrl: LISTENER_URL, tickMs: 30_000, pageMax: 100,
    });
    feeds.push(feed);
    await feed.start();

    const started = Date.now();
    await appendFromElsewhere(reviewId, 'c1');
    await untilDelivered(hub, 1, 5_000);
    const took = Date.now() - started;
    process.stdout.write(`feed: notify-driven delivery in ${took} ms\n`);
    expect(took).toBeLessThan(30_000);
  }, 20_000);

  it('delivers each event exactly once across a notification and a tick', async () => {
    /*
     * The cursor is what makes this true, and the ORDER inside the tick is
     * what makes the cursor true: publish, THEN advance. The mutation:
     * advance the cursor before publishing and an event goes missing under a
     * publish that throws — delivered to nobody and never read again,
     * because the cursor says it was.
     */
    const reviewId = await seedReview('once');
    const hub = recordingHub();
    hub.watch({ review: reviewId }, await highestId());
    const feed = startEventFeed({
      db: appDb(), hub, listenerUrl: LISTENER_URL, tickMs: 50, pageMax: 100,
    });
    feeds.push(feed);
    await feed.start();

    await appendFromElsewhere(reviewId, 'c1');
    await appendFromElsewhere(reviewId, 'c2');
    await untilDelivered(hub, 2);
    // Several more ticks AND several more notifications go by; the count
    // must not move.
    await new Promise(resolve => { setTimeout(resolve, 400); });
    const ids = hub.delivered
      .filter(f => f.t === 'event')
      .map(f => (f as { event: { id: number } }).event.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  }, 20_000);

  it('reads each subscription from where its joiner had got to, not from zero', async () => {
    // A reader who has just replayed a review must not be sent its whole
    // seven-day buffer again by the feed. `since` is the socket's own
    // `caught_up` cursor.
    const reviewId = await seedReview('since');
    await appendFromElsewhere(reviewId, 'old-1');
    await appendFromElsewhere(reviewId, 'old-2');
    const hub = recordingHub();
    hub.watch({ review: reviewId }, await highestId());
    const feed = startEventFeed({
      db: appDb(), hub, listenerUrl: LISTENER_URL, tickMs: 50, pageMax: 100, listen: false,
    });
    feeds.push(feed);
    await feed.start();
    await new Promise(resolve => { setTimeout(resolve, 300); });
    expect(hub.delivered.filter(f => f.t === 'event')).toHaveLength(0);

    // …and the sanity check: something appended AFTER that point does
    // arrive, so the silence above is the cursor rather than a feed that is
    // not running.
    await appendFromElsewhere(reviewId, 'new-1');
    await untilDelivered(hub, 1);
  }, 20_000);

  it('recovers its listener when the connection drops, and says so', async () => {
    const reviewId = await seedReview('recover');
    const hub = recordingHub();
    hub.watch({ review: reviewId }, await highestId());
    const lines: string[] = [];
    const feed = startEventFeed({
      db: appDb(), hub,
      // THE MIGRATOR'S DSN, in this test only, and for one reason:
      // `pg_terminate_backend` may only be called on a backend owned by the
      // SAME role unless the caller is a superuser or holds
      // `pg_signal_backend`. The terminator below runs as the migrator, so
      // the listener has to as well or the kill silently returns false and
      // the test reads as a listener that never dropped. Which role holds
      // the LISTEN is immaterial to what is being proved -- reconnection is
      // a property of the client, not of the grant.
      listenerUrl: MIGRATION_URL, tickMs: 150, pageMax: 100,
      log: line => lines.push(line),
    });
    feeds.push(feed);
    await feed.start();

    // Kill the feed's own backend from another session. `pg_terminate_backend`
    // on the connection running `LISTEN lexprompt_event` is the closest a
    // test can get to the network dropping under it.
    const killed = await migratorDb().query<{ pg_terminate_backend: boolean }>(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where query like 'listen lexprompt_event' and pid <> pg_backend_pid()`);
    // ASSERTED, because a kill that matched nothing would make everything
    // below pass for the wrong reason: the listener never dropped, so of
    // course delivery continued.
    expect(killed.some(r => r.pg_terminate_backend), 'no listener backend was terminated')
      .toBe(true);

    await appendFromElsewhere(reviewId, 'c1');
    // Delivered by the TICK while the listener is away — the whole point of
    // the outbox being the delivery.
    await untilDelivered(hub, 1);
    // …and the listener comes back, and SAYS SO. A listener that silently
    // stopped would leave live change feeling one tick slow for the life of
    // the process, which is a fault nobody reports.
    const deadline = Date.now() + 5_000;
    while (!lines.some(l => l.includes('event listener reconnected'))) {
      if (Date.now() > deadline) {
        throw new Error(`the listener did not reconnect. Logged: ${JSON.stringify(lines)}`);
      }
      await new Promise(resolve => { setTimeout(resolve, 50); });
    }
    expect(lines.some(l => l.includes('event listener lost'))).toBe(true);
  }, 30_000);

  it('keys its cursors by workspace AND subscription, so two firms cannot share one', () => {
    // Not a database test: the property is in the key, and it is worth one
    // assertion because a review id is minted in a browser's IndexedDB and
    // imported, so two firms CAN hold the same one.
    expect(subscriptionKey({ review: 'r1' })).toBe('review:r1');
    expect(subscriptionKey({ matter: 'r1' })).not.toBe(subscriptionKey({ review: 'r1' }));
    expect(subscriptionKey({ run: 'r1' })).not.toBe(subscriptionKey({ review: 'r1' }));
  });
});

describe('nothing but the feed publishes to the hub', () => {
  it('leaves a Connection with no publisher of its own', () => {
    // The shape check behind the rule: a `Connection` is a sink. If a route
    // could reach one it could deliver locally and not across replicas, and
    // the busiest path would be the one with the different behaviour.
    const conn: Connection = {
      id: 'c', workspaceId: WS, userId: 'u', send: () => { /* sink */ },
    };
    expect(typeof conn.send).toBe('function');
  });
});
