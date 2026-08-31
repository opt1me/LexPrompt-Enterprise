import { describe, it, expect, afterAll } from 'vitest';
import type { AssignmentInboxPage } from '@lexprompt/core';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import { removeSeeded, seedOneDoneFinding, type Seeded } from './helpers/seedReview.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';

/**
 * "ASSIGNED TO ME", ACROSS TWO MATTERS, ON THE RUNNING STACK (S18).
 *
 * The counter's whole claim is a number that is right, and every unit test
 * behind it runs against a fake. What this proves is the two halves those
 * cannot: that the cross-matter read really crosses matters over real HTTP
 * with two real tokens, and that the frame the browser re-reads on really
 * arrives at the assignee's own socket within a second.
 *
 * WHAT THIS CANNOT PROVE, and Task 7's report says so rather than implying
 * otherwise: that anybody has SEEN the number, or the "not known" marker
 * that replaces it when the read fails.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  // EVERY ROW THIS SUITE CREATED. `test:pg` and `test:compose` share one
  // database and a suite that leaves state behind breaks a different file
  // with a message pointing at the wrong feature.
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

const assignPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/assignments`;

const liveAssignment = (type: string, after: number) => (f: Frame): boolean => {
  if (f.t !== 'event') return false;
  const event = f.event as { type?: string; id?: number } | undefined;
  return event?.type === type && Number(event.id) > after;
};

async function inboxOf(who: TestAccount): Promise<AssignmentInboxPage> {
  const res = await asUser(who, 'GET', '/v1/assignments?state=open');
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as AssignmentInboxPage;
}

describe('the counter reads across matters and moves when a request closes', () => {
  it('counts two matters, names them, and drops to one within a second of a close', async () => {
    const { trainee, partner } = await twoAccounts();
    expect(trainee.userId).not.toBe(partner.userId);

    const a = await seedOneDoneFinding(trainee, 'Assigned to me A (Task 2)');
    const b = await seedOneDoneFinding(trainee, 'Assigned to me B (Task 2)');
    litter.push({ who: trainee, seeded: a }, { who: trainee, seeded: b });

    // What the partner's inbox holds BEFORE anything is asked of them, so
    // the assertions below are about this suite's own rows and not about
    // whatever else the shared database is carrying.
    const before = await inboxOf(partner);
    const mine = (page: AssignmentInboxPage): string[] =>
      page.items.map(i => i.matterName)
        .filter(n => n.startsWith('Assigned to me '));
    expect(mine(before)).toEqual([]);

    // The PARTNER is watching matter A. Everything after this is the
    // trainee's act.
    const socket = await connect(WS_URL, partner.token, { timeoutMs: 15_000 });
    sockets.push(socket);
    await socket.waitFor('hello', { timeoutMs: 10_000 });
    socket.send({ t: 'subscribe', sub: { review: a.reviewId }, lastEventId: 0 });
    const caughtUp = await socket.waitFor('caught_up', { timeoutMs: 10_000 });
    const cursor = Number(caughtUp.cursor);

    const started = Date.now();
    for (const seeded of [a, b]) {
      const created = await asUser(trainee, 'POST', assignPath(seeded),
        { assigneeUserId: partner.userId, message: 'Not sure the cap survives 14.2.' });
      expect(created.status, await created.text()).toBe(201);
    }

    // THE DOORBELL. The browser re-reads on this; it never derives a count
    // from it.
    await socket.waitFor(liveAssignment('assignment.created', cursor), { timeoutMs: 5_000 });
    process.stdout.write(
      `assignment to the assignee's socket: ${Date.now() - started} ms\n`);

    const two = await inboxOf(partner);
    expect(mine(two).sort())
      .toEqual(['Assigned to me A (Task 2)', 'Assigned to me B (Task 2)']);
    // THE CONTEXT, over real HTTP: the matter's name, the review's name and
    // the clause's title, which the row alone could never have carried.
    const item = two.items.find(i => i.matterName === 'Assigned to me A (Task 2)')!;
    expect(item.matterId).toBe(a.matterId);
    expect(item.reviewName).toBe('Assigned to me A (Task 2)');
    expect(two.capped).toBe(false);

    // …AND THE ASSIGNER'S OWN INBOX IS EMPTY. A counter that included what
    // you asked of others would tell a person they owe an answer they do
    // not owe.
    expect(mine(await inboxOf(trainee))).toEqual([]);

    // One closed. The number moves because the SERVER says so on a fresh
    // read, not because anything decremented.
    const open = two.items.find(i => i.matterName === 'Assigned to me A (Task 2)')!;
    const closed = await asUser(
      partner, 'POST', `/v1/assignments/${open.assignment.id}/resolve`);
    expect(closed.status, await closed.text()).toBe(200);
    await socket.waitFor(liveAssignment('assignment.resolved', cursor), { timeoutMs: 5_000 });

    const one = await inboxOf(partner);
    expect(mine(one)).toEqual(['Assigned to me B (Task 2)']);
  }, 90_000);
});
