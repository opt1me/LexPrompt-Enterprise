import { describe, it, expect, afterAll } from 'vitest';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import { dispositionPath, removeSeeded, seedOneDoneFinding, type Seeded } from './helpers/seedReview.ts';
import {
  connect, socketsOnDistinctReplicas, type Frame, type TestSocket,
} from './helpers/wsClient.ts';

/**
 * PRESENCE, ON THE RUNNING STACK, WITH TWO REAL PEOPLE (§8, S6, Task 22).
 *
 * The owner's requirement is *"we can see when two people are viewing the
 * same output at once, ideally down to the particular clause"*. This file is
 * the half of that a test can prove: two tokens from the seeded realm, two
 * sockets through nginx on the browser's own origin, and one person's beat
 * arriving on the other person's roster with the clause on it.
 *
 * THE HALF IT CANNOT PROVE is what a person SEES — that a face on a clause
 * reads as "somebody is looking at this" and never as "somebody has checked
 * this". Browser automation has been unavailable for three stages; that half
 * is named in Task 26's report rather than implied here.
 *
 * ## The TTL is exercised in real time, and that is why one test is slow
 *
 * `API_PRESENCE_TTL_MS` is 15s in the running stack. A test that faked the
 * clock would be testing the registry, which `presence.pg.test.ts` already
 * does; what only this file can answer is whether the sweep actually runs in
 * the shipped process, on its own timer, with nobody beating at it. So it
 * waits, and the wait is the assertion.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;
/** Room for the TTL plus a sweep interval (a third of it) plus the network. */
const EXPIRY_BUDGET_MS = 30_000;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

interface Member { userId: string; screen: string; clauseId?: string }

const membersOf = (f: Frame): Member[] => (f.members ?? []) as Member[];

/** A presence frame for `reviewId` whose roster satisfies `holds`. Scoped to
 *  the subscription, so a frame about another suite's review — this stack is
 *  shared — cannot answer an assertion here. */
const rosterWhere = (reviewId: string, holds: (m: Member[]) => boolean) => (f: Frame): boolean =>
  f.t === 'presence'
  && (f.sub as { review?: string } | undefined)?.review === reviewId
  && holds(membersOf(f));

async function watching(who: TestAccount, seeded: Seeded): Promise<TestSocket> {
  const socket = await connect(WS_URL, who.token, { timeoutMs: 15_000 });
  sockets.push(socket);
  await socket.waitFor('hello', { timeoutMs: 10_000 });
  socket.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
  await socket.waitFor('caught_up', { timeoutMs: 10_000 });
  return socket;
}

describe('two people on one review can see each other, down to the clause', () => {
  it('puts a colleague s beat on the other person s roster, with the clause', async () => {
    const { trainee, partner } = await twoAccounts();
    expect(trainee.userId).not.toBe(partner.userId);
    const seeded = await seedOneDoneFinding(trainee, 'presence (Task 22)');
    litter.push({ who: trainee, seeded });

    const traineeSocket = await watching(trainee, seeded);
    const partnerSocket = await watching(partner, seeded);

    const started = Date.now();
    partnerSocket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c1',
    });

    const frame = await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => m.some(x => x.userId === partner.userId)),
      { timeoutMs: 10_000 });
    // A NUMBER rather than an impression, as `livePush` prints for a
    // disposition: this is what a reviewer actually waits to see a colleague.
    process.stdout.write(`presence beat to another socket: ${Date.now() - started} ms\n`);

    const them = membersOf(frame).find(m => m.userId === partner.userId)!;
    expect(them.clauseId).toBe('c1');
    expect(them.screen).toBe('review');
    // THE ROSTER CARRIES NO NAME AND NO TIME. A display name would be a
    // second copy of a mutable field (P32); a timestamp is what a "last seen
    // 3m ago" would be built out of, and the roster expires at fifteen
    // seconds so no such claim can be true.
    expect(Object.keys(them).sort()).toEqual(['clauseId', 'screen', 'userId']);

    // The clause MOVES when they move.
    partnerSocket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c2',
    });
    const moved = await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId,
        m => m.some(x => x.userId === partner.userId && x.clauseId === 'c2')),
      { timeoutMs: 10_000 });
    expect(membersOf(moved).find(m => m.userId === partner.userId)?.clauseId).toBe('c2');
  }, 60_000);

  it('takes them off the roster when their tab closes, not one TTL later', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'presence close (Task 22)');
    litter.push({ who: trainee, seeded });

    const traineeSocket = await watching(trainee, seeded);
    const partnerSocket = await watching(partner, seeded);
    partnerSocket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c1',
    });
    await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => m.some(x => x.userId === partner.userId)),
      { timeoutMs: 10_000 });

    const started = Date.now();
    partnerSocket.close();
    await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => !m.some(x => x.userId === partner.userId)),
      { timeoutMs: 10_000 });
    const took = Date.now() - started;
    process.stdout.write(`presence cleared on close: ${took} ms\n`);
    // The TTL is the backstop for a replica that died. A clean close says so
    // at once, on every replica, or a colleague's face sits on a clause they
    // have left for as long as the TTL allows.
    expect(took).toBeLessThan(EXPIRY_BUDGET_MS);
  }, 60_000);

  it('expires a member whose beats stop, in the running process, within the TTL', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'presence ttl (Task 22)');
    litter.push({ who: trainee, seeded });

    const traineeSocket = await watching(trainee, seeded);
    const partnerSocket = await watching(partner, seeded);
    // ONE beat, and then silence — a tab frozen, a laptop shut, a network
    // gone. The socket stays open, so nothing but the TTL can correct this.
    partnerSocket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c1',
    });
    await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => m.some(x => x.userId === partner.userId)),
      { timeoutMs: 10_000 });

    const started = Date.now();
    await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => !m.some(x => x.userId === partner.userId)),
      { timeoutMs: EXPIRY_BUDGET_MS });
    const took = Date.now() - started;
    process.stdout.write(`presence expired after silence: ${took} ms\n`);
    /*
     * THE CLAIM THIS WHOLE FEATURE RESTS ON, checked against the shipped
     * process rather than an injected TTL: a person who stopped beating is
     * GONE, and the sweep that removes them runs on its own timer with
     * nobody prompting it. The mutation: comment out the `sweeper` interval
     * in `realtime/socket.ts` and this is what goes red — the registry's own
     * unit tests would all still pass, because they call `sweep` themselves.
     */
    expect(took).toBeLessThan(EXPIRY_BUDGET_MS);
    expect(partnerSocket.open).toBe(true);
  }, 90_000);

  it('gates no write: a disposition change succeeds while somebody is on that clause', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'presence advisory (Task 22)');
    litter.push({ who: trainee, seeded });

    const traineeSocket = await watching(trainee, seeded);
    const partnerSocket = await watching(partner, seeded);
    partnerSocket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c1',
    });
    await traineeSocket.waitFor(
      rosterWhere(seeded.reviewId, m => m.some(x => x.userId === partner.userId)),
      { timeoutMs: 10_000 });

    // S6: presence locks nothing, blocks nothing, gates no write. On the
    // running stack, with the roster genuinely non-empty at the moment of
    // the write.
    const res = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 1 });
    expect(res.status, await res.text()).toBe(200);
  }, 60_000);

  it('refuses a beat on a subscription this socket has not joined', async () => {
    const { trainee } = await twoAccounts();
    const socket = await connect(WS_URL, trainee.token, { timeoutMs: 15_000 });
    sockets.push(socket);
    await socket.waitFor('hello', { timeoutMs: 10_000 });
    // No `subscribe`. A beat here would put this person on the roster of a
    // review whose existence and workspace nothing has checked — the check
    // lives in `subscribe`, which is exactly why presence must not bypass it.
    socket.send({ t: 'presence', sub: { review: 'a-review-i-guessed' }, screen: 'review' });
    const refused = await socket.waitFor('refused', { timeoutMs: 10_000 });
    expect(String(refused.reason)).toContain('subscription this socket has joined');
  }, 60_000);
});

describe('presence crosses replicas', () => {
  it('shows a colleague connected to the OTHER replica', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'presence replicas (Task 22)');
    litter.push({ who: trainee, seeded });

    /*
     * A DIFFERENT CHANNEL FROM THE OUTBOX'S, and therefore a genuinely
     * separate claim from `replicaFanout.compose.test.ts`'s.
     *
     * Presence is the one thing that rides the notification PAYLOAD (P39's
     * sole exception), because it has no outbox to be read forward from and
     * must not acquire one (S6). So "does a beat cross replicas" is not
     * answered by "does an event cross replicas": they travel different ways.
     */
    const [a, b] = await socketsOnDistinctReplicas(WS_URL, trainee.token, partner.token, sockets);
    for (const socket of [a, b]) {
      socket.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
      // eslint-disable-next-line no-await-in-loop
      await socket.waitFor('caught_up', { timeoutMs: 10_000 });
    }

    const started = Date.now();
    b.send({ t: 'presence', sub: { review: seeded.reviewId }, screen: 'review', clauseId: 'c7' });
    const frame = await a.waitFor(
      rosterWhere(seeded.reviewId,
        m => m.some(x => x.userId === partner.userId && x.clauseId === 'c7')),
      { timeoutMs: 15_000 });
    process.stdout.write(`cross-replica presence beat: ${Date.now() - started} ms\n`);
    expect(membersOf(frame).some(m => m.userId === partner.userId)).toBe(true);
  }, 90_000);
});
