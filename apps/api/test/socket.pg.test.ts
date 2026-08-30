import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WS_PATH } from '@lexprompt/core';
import { buildTestApi } from './helpers/apiHarness.ts';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { appendEvent } from '../src/run/events.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';
import type { Db } from '../src/db/pool.ts';

/**
 * THE SOCKET, AGAINST A REAL DATABASE AND A REAL SERVER.
 *
 * Not `withPg`'s pinned rollback transaction: this suite needs the events it
 * writes to be visible to ANOTHER connection — the one the socket's replay
 * reads on — so the writes have to commit and be cleaned up by hand. A
 * transaction-local fixture would make every replay come back empty and the
 * failure would read as a broken cursor.
 *
 * The three claims:
 *
 *  1. A replay starts at the cursor, delivers in id order, and ends with
 *     `caught_up` carrying where it got to.
 *  2. A cursor past retention gets `resync_required` and NOT a silently
 *     short replay. Silently short is the failure: a client that asked for
 *     everything after 400 and received everything after 900 has a hole it
 *     cannot see.
 *  3. A subscription this workspace cannot see is REFUSED with a sentence,
 *     never fed silently — a subscription quietly never fed is
 *     indistinguishable from a review where nothing is happening.
 */

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-socket',
  groups: ['reviewers'],
};

/**
 * A REAL uuid, not `apiHarness`'s `WORKSPACE_ID`.
 *
 * That constant is 'ws-configured', which is fine for a suite whose `Db` is
 * a recording fake and fails on the first query against a real Postgres:
 * `workspace_id` is a `uuid` column, so it does not parse. Every suite here
 * runs against the database, so the server is built with an actor carrying
 * the workspace §6 seeds.
 */
const WS = '00000000-0000-0000-0000-000000000001';
const ACTOR = {
  id: '00000000-0000-0000-0000-0000000000aa', displayName: 'Socket Tester', initials: 'ST',
  role: 'reviewer' as const, workspaceId: WS,
};

const servers: FastifyInstance[] = [];
const sockets: TestSocket[] = [];
const createdReviews: string[] = [];
const createdMatters: string[] = [];

async function withWorkspace(db: Db): Promise<void> {
  await db.query(
    `insert into workspace (id, name) values ($1, 'socket suite')
     on conflict (id) do nothing`, [WS]);
}

/** One matter and one review, committed, so another connection can read
 *  them. Torn down in `afterEach`. */
async function seedReview(id: string): Promise<{ matterId: string; reviewId: string }> {
  const db = migratorDb();
  await withWorkspace(db);
  const matterId = `sock-m-${id}`;
  const reviewId = `sock-r-${id}`;
  await db.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Socket suite', now(), now()) on conflict (id) do nothing`, [matterId, WS]);
  await db.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb,
             '{}'::jsonb, 'm', now())
     on conflict (id) do nothing`, [reviewId, WS, matterId]);
  createdReviews.push(reviewId);
  createdMatters.push(matterId);
  return { matterId, reviewId };
}

/** Appends `n` note events to a review and returns their ids, committed. */
async function seedEvents(reviewId: string, n: number): Promise<number[]> {
  const db = migratorDb();
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(await db.tx(t => appendEvent(t, {
      workspaceId: WS, type: 'note.added', reviewId,
      payload: {
        reviewId, findingsKey: 'd1', clauseId: `c${i}`,
        note: {
          id: `sock-n-${reviewId}-${i}`, findingId: `d1::c${i}`, text: 't',
          byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
        },
      },
    })));
  }
  return ids;
}

async function listening(
  opts: Partial<Parameters<typeof buildTestApi>[0]> = {},
): Promise<{ app: FastifyInstance; url: string }> {
  const { app } = buildTestApi({ principal: PRINCIPAL, db: appDb(), actor: ACTOR, ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { app, url: `ws://127.0.0.1:${port}${WS_PATH}` };
}

async function open(url: string): Promise<TestSocket> {
  const socket = await connect(url, 'a-token-the-fake-verifier-accepts');
  sockets.push(socket);
  await socket.waitFor('hello');
  return socket;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const app of servers.splice(0)) await app.close();
  const db = migratorDb();
  for (const reviewId of createdReviews.splice(0)) {
    await db.query('delete from event where review_id = $1', [reviewId]);
    await db.query('delete from review where id = $1', [reviewId]);
  }
  for (const matterId of createdMatters.splice(0)) {
    await db.query('delete from matter where id = $1', [matterId]);
  }
});

const eventIds = (frames: Frame[]): number[] => frames
  .filter(f => f.t === 'event')
  .map(f => (f.event as { id: number }).id);

describe('the socket replays from the cursor and then says caught_up', () => {
  it('says hello with the instance id, so a client knows which replica it reached', async () => {
    const { url } = await listening();
    const socket = await open(url);
    const hello = await socket.waitFor('hello');
    // The fact `replicaFanout.compose.test.ts` rests on: two sockets that
    // report the same instance are not the cross-replica condition.
    expect(hello.instanceId).toBe('api-test-instance');
    expect(hello.userId).toBe(ACTOR.id);
  });

  it('delivers exactly the events after the cursor, in id order', async () => {
    const { reviewId } = await seedReview('replay');
    const ids = await seedEvents(reviewId, 6);
    const { url } = await listening();
    const socket = await open(url);

    socket.send({ t: 'subscribe', sub: { review: reviewId }, lastEventId: ids[2] });
    const frames = await socket.collectUntil(f => f.t === 'caught_up');
    // The last three, and nothing before the cursor.
    expect(eventIds(frames)).toEqual(ids.slice(3));
    expect(frames.at(-1)).toMatchObject({ t: 'caught_up', cursor: ids[5] });
  });

  it('replays everything for a cursor of 0, which is a fresh client', async () => {
    const { reviewId } = await seedReview('fresh');
    const ids = await seedEvents(reviewId, 3);
    const { url } = await listening();
    const socket = await open(url);

    socket.send({ t: 'subscribe', sub: { review: reviewId }, lastEventId: 0 });
    const frames = await socket.collectUntil(f => f.t === 'caught_up');
    expect(eventIds(frames)).toEqual(ids);
    // A cursor of 0 is a client that could not be missing anything, so it
    // must NEVER resync.
    expect(frames.some(f => f.t === 'resync_required')).toBe(false);
  });

  it('says resync_required rather than a silently short replay', async () => {
    /*
     * THE MUTATION THIS EXISTS FOR: make the replay return what survives and
     * NOT send this frame. Every happy-path test above still passes and the
     * client silently has a hole. This is the assertion that catches it.
     */
    const { reviewId } = await seedReview('pruned');
    await seedEvents(reviewId, 2);
    const { url } = await listening();
    const socket = await open(url);

    // A cursor below the table's watermark: the events between it and now
    // are gone, whatever this review's own oldest id happens to be.
    const oldest = Number((await migratorDb().query<{ oldest: string | null }>(
      'select min(id)::text as oldest from event'))[0].oldest);
    socket.send({ t: 'subscribe', sub: { review: reviewId }, lastEventId: Math.max(1, oldest - 5) });
    const frames = await socket.collectUntil(f => f.t === 'caught_up');
    expect(frames.some(f => f.t === 'resync_required')).toBe(true);
  });

  it('serves a matter subscription, which has no HTTP equivalent at all', async () => {
    const { matterId, reviewId } = await seedReview('matter');
    const ids = await seedEvents(reviewId, 2);
    const { url } = await listening();
    const socket = await open(url);

    socket.send({ t: 'subscribe', sub: { matter: matterId }, lastEventId: 0 });
    const frames = await socket.collectUntil(f => f.t === 'caught_up');
    expect(eventIds(frames)).toEqual(ids);
  });
});

describe('the socket refuses rather than falling silent', () => {
  it('refuses a subscription to a review this workspace cannot see, with a sentence', async () => {
    const { url } = await listening();
    const socket = await open(url);
    socket.send({ t: 'subscribe', sub: { review: 'a-review-in-another-firm' }, lastEventId: 0 });
    const refused = await socket.waitFor('refused');
    // NOT silence, and NOT an empty stream: a subscription that is quietly
    // never fed is indistinguishable from a review where nothing is
    // happening, which is the founding defect wearing a websocket.
    expect(String(refused.reason)).toMatch(/no such review, matter or run/);
    // …and it never becomes `caught_up`, which would tell the client it is
    // live on something it is not.
    await socket.idleFor(200);
    expect(socket.frames.some(f => f.t === 'caught_up')).toBe(false);
  });

  it('refuses a frame it does not understand rather than dropping it', async () => {
    const { url } = await listening();
    const socket = await open(url);
    socket.send({ t: 'subscribe-to-everything' });
    const refused = await socket.waitFor('refused');
    expect(String(refused.reason)).toMatch(/not a frame/);
  });

  it('refuses a subscription naming two shapes at once', async () => {
    // `{ review: 'r', matter: 'm' }` is not resolved to whichever key is
    // checked first: a client that sent both meant something this server
    // cannot honour, and picking one silently is how a reader ends up
    // watching a subscription they did not ask for.
    const { url } = await listening();
    const socket = await open(url);
    socket.send({ t: 'subscribe', sub: { review: 'r', matter: 'm' }, lastEventId: 0 });
    expect(await socket.waitFor('refused')).toBeDefined();
  });

  it('refuses more than API_WS_MAX_SUBSCRIPTIONS, naming the cap', async () => {
    const { reviewId } = await seedReview('cap');
    const { url } = await listening({ socketCaps: { maxSubscriptions: 1 } });
    const socket = await open(url);

    socket.send({ t: 'subscribe', sub: { review: reviewId }, lastEventId: 0 });
    await socket.waitFor('caught_up');
    socket.send({ t: 'subscribe', sub: { run: 'some-other-run' }, lastEventId: 0 });
    const refused = await socket.waitFor('refused');
    expect(String(refused.reason)).toContain('API_WS_MAX_SUBSCRIPTIONS');
  });
});

describe('the socket closes a client that stops answering', () => {
  it('closes a socket that does not answer two pings', async () => {
    // The heartbeat is a `ping` FRAME rather than a protocol ping: a browser
    // answers a protocol ping in the network stack with no JavaScript
    // involved, which proves the connection is alive and proves nothing
    // about whether the page still is.
    const { url } = await listening({ socketCaps: { pingMs: 60 } });
    const socket = await open(url);
    await socket.waitFor('ping', { timeoutMs: 2_000 });
    // This client never sends `pong`. Two unanswered pings and it is closed.
    await socket.idleFor(400);
    expect(socket.open).toBe(false);
  });

  it('keeps a socket that DOES answer, so the close above is about the pong', async () => {
    const { url } = await listening({ socketCaps: { pingMs: 60 } });
    const socket = await open(url);
    const timer = setInterval(() => {
      if (socket.open) socket.send({ t: 'pong' });
    }, 20);
    try {
      await socket.idleFor(400);
      expect(socket.open).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});
