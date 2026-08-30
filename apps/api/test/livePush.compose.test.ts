import { describe, it, expect, afterAll } from 'vitest';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import {
  dispositionPath, notesPath, removeSeeded, seedOneDoneFinding, type Seeded,
} from './helpers/seedReview.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';

/**
 * §18 ITEM 5'S HEADLINE CLAUSE, ON THE RUNNING STACK.
 *
 * Two REAL accounts, two real tokens from the seeded Keycloak realm, a real
 * socket through nginx on the browser's own origin, and one person's write
 * arriving at the other person's session. Not `app.inject` with a stubbed
 * `resolveActor`: the point is that two DIFFERENT people, each authenticated
 * by the shipped verifier and resolved by the shipped actor resolver, meet
 * on the same row.
 *
 * §18.5 says "immediately", and the only honest thing a test can say about
 * that word is HOW LONG IT TOOK — so the number is printed rather than
 * asserted as a feeling.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

/**
 * A socket subscribed and caught up, plus the cursor it reached.
 *
 * THE CURSOR MATTERS, and leaving it out made this file pass for the wrong
 * reason once. The review already has events on it — the seeding, and the
 * first person's own verification — so a `waitFor` on the event TYPE alone
 * matches a REPLAYED frame, and the assertions then hold against something
 * nobody pushed. Everything below is scoped to an id above `caught_up`,
 * which is the difference between "delivered live" and "delivered again".
 */
async function watching(
  who: TestAccount, seeded: Seeded,
): Promise<{ socket: TestSocket; cursor: number }> {
  const socket = await connect(WS_URL, who.token, { timeoutMs: 15_000 });
  sockets.push(socket);
  await socket.waitFor('hello', { timeoutMs: 10_000 });
  socket.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
  const caughtUp = await socket.waitFor('caught_up', { timeoutMs: 10_000 });
  return { socket, cursor: Number(caughtUp.cursor) };
}

const liveEvent = (type: string, after: number) => (f: Frame): boolean => {
  if (f.t !== 'event') return false;
  const event = f.event as { type?: string; id?: number } | undefined;
  return event?.type === type && Number(event.id) > after;
};

describe('another person s change reaches the card, attributed, without a reload', () => {
  it('reaches a second person s socket within a second of the first person s write', async () => {
    const { trainee, partner } = await twoAccounts();
    // The premise. Two tokens resolving to one row would make everything
    // below vacuous.
    expect(trainee.userId).not.toBe(partner.userId);

    const seeded = await seedOneDoneFinding(trainee, 'live push (Task 21)');
    litter.push({ who: trainee, seeded });

    const first = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 1 });
    expect(first.status, await first.text()).toBe(200);

    // The TRAINEE is watching. Everything after this is the partner's.
    const { socket, cursor } = await watching(trainee, seeded);

    const started = Date.now();
    const override = await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 2 });
    expect(override.status, await override.text()).toBe(200);

    const frame = await socket.waitFor(
      liveEvent('finding.disposition_changed', cursor), { timeoutMs: 5_000 });
    const took = Date.now() - started;
    process.stdout.write(`disposition push latency: ${took} ms\n`);

    const event = frame.event as {
      reviewId?: string;
      runId?: string;
      payload: {
        version: number;
        disposition: { state: string; byUserId?: string; changedCount: number; version: number };
        event: { fromState: string; toState: string; byUserId: string; cause: string };
      };
    };

    // THE WHOLE NEW ROW AND THE EVENT THAT PRODUCED IT, on one frame — which
    // is what makes "Rejected by R. Okafor, 16:04 — was Verified" renderable
    // with no second query.
    expect(event.payload.disposition.state).toBe('rejected');
    expect(event.payload.disposition.byUserId).toBe(partner.userId);
    expect(event.payload.disposition.byUserId).not.toBe(trainee.userId);
    expect(event.payload.disposition.changedCount).toBe(2);
    expect(event.payload.event.fromState).toBe('verified');
    expect(event.payload.event.toState).toBe('rejected');
    expect(event.payload.event.cause).toBe('human');
    // The version the receiving client's guard turns on, and the SAME number
    // the stale-change refusal uses.
    expect(event.payload.version).toBe(event.payload.disposition.version ?? 2);

    // A disposition change belongs to NO RUN. `runId: ''` would read to a
    // client as a run whose id is empty; `in` is the only assertion that can
    // tell an absent key from an undefined one.
    expect('runId' in event).toBe(false);
    expect(event.reviewId).toBe(seeded.reviewId);
  }, 60_000);

  it('reaches the same socket with a note, appended rather than replacing', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'live note (Task 21)');
    litter.push({ who: trainee, seeded });

    const { socket, cursor } = await watching(trainee, seeded);

    const posted = await asUser(partner, 'POST', notesPath(seeded),
      { text: 'Check 14.2 against the LOI.' });
    expect(posted.status, await posted.text()).toBe(201);

    const frame = await socket.waitFor(liveEvent('note.added', cursor), { timeoutMs: 5_000 });
    const event = frame.event as {
      payload: { note: { id: string; text: string; byUserId: string } };
    };
    expect(event.payload.note.text).toBe('Check 14.2 against the LOI.');
    expect(event.payload.note.byUserId).toBe(partner.userId);
    // One note, never the list: a payload carrying the array would let a
    // receiver replace a fresh one with a stale copy.
    expect(Array.isArray((event.payload as unknown as { notes?: unknown }).notes)).toBe(false);
  }, 60_000);

  it('refuses to feed a socket a review its workspace cannot see, with a sentence', async () => {
    // The other half of "never fall silent": a subscription that is quietly
    // never fed is indistinguishable from a review where nothing is
    // happening.
    const { trainee } = await twoAccounts();
    const socket = await connect(WS_URL, trainee.token, { timeoutMs: 15_000 });
    sockets.push(socket);
    await socket.waitFor('hello', { timeoutMs: 10_000 });
    socket.send({ t: 'subscribe', sub: { review: 'a-review-in-another-firm' }, lastEventId: 0 });
    const refused = await socket.waitFor('refused', { timeoutMs: 10_000 });
    expect(String(refused.reason)).toMatch(/no such review, matter or run/);
  }, 60_000);
});
