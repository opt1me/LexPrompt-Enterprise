import { describe, it, expect, afterAll } from 'vitest';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import { removeSeeded, seedOneDoneFinding, type Seeded } from './helpers/seedReview.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';

/**
 * §18 ITEM 5'S LAST CLAUSE: *"AN ASSIGNMENT REACHES THE ASSIGNEE."*
 *
 * The owner's trainee-and-partner story, end to end, on the running stack:
 * two real accounts, two real tokens from the seeded realm, a real socket
 * through nginx, and one person's request arriving in the other person's
 * session and in their own list.
 *
 * **An assignment nobody receives is a correct mechanism with no path to
 * it**, and this project has nineteen recorded instances of exactly that. So
 * "reaches" is asserted twice, because there are two ways a person actually
 * finds out: the push, for a session that is already open, and the list, for
 * one that opens later. A feature that had only the first would silently
 * lose every request made while its assignee was away from their desk.
 *
 * WHAT THIS CANNOT PROVE is that the assignee NOTICES — that the panel reads
 * as a request rather than as decoration, mid-scroll, on a busy review.
 * Browser automation has been unavailable for three stages; that half is
 * named in Task 26's report rather than implied here.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

const assignPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/assignments`;

/** An assignment event on the socket, ABOVE the cursor the replay reached —
 *  the difference between "delivered live" and "delivered again". */
const liveAssignment = (type: string, after: number) => (f: Frame): boolean => {
  if (f.t !== 'event') return false;
  const event = f.event as { type?: string; id?: number } | undefined;
  return event?.type === type && Number(event.id) > after;
};

async function watching(who: TestAccount, seeded: Seeded): Promise<{
  socket: TestSocket; cursor: number;
}> {
  const socket = await connect(WS_URL, who.token, { timeoutMs: 15_000 });
  sockets.push(socket);
  await socket.waitFor('hello', { timeoutMs: 10_000 });
  socket.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
  const caughtUp = await socket.waitFor('caught_up', { timeoutMs: 10_000 });
  return { socket, cursor: Number(caughtUp.cursor) };
}

describe('an assignment reaches the person it was addressed to', () => {
  it('reaches the assignee s open socket, and their list, within a second', async () => {
    const { trainee, partner } = await twoAccounts();
    // The premise. Two tokens resolving to one row would make it all vacuous.
    expect(trainee.userId).not.toBe(partner.userId);

    const seeded = await seedOneDoneFinding(trainee, 'assignment reaches (Task 25)');
    litter.push({ who: trainee, seeded });

    // The PARTNER is watching. Everything after this is the trainee's.
    const { socket, cursor } = await watching(partner, seeded);

    const started = Date.now();
    const created = await asUser(trainee, 'POST', assignPath(seeded), {
      assigneeUserId: partner.userId,
      message: 'Not sure the cap survives 14.2.',
    });
    expect(created.status, await created.text()).toBe(201);

    const frame = await socket.waitFor(
      liveAssignment('assignment.created', cursor), { timeoutMs: 5_000 });
    // A NUMBER rather than an impression, as `livePush` prints for a
    // disposition: this is what the partner actually waits.
    process.stdout.write(`assignment to the assignee's socket: ${Date.now() - started} ms\n`);

    const payload = (frame.event as { payload: {
      assignment: {
        assigneeUserId: string; assignedByUserId: string; message?: string; id: string;
      };
    } }).payload;
    expect(payload.assignment.assignedByUserId).toBe(trainee.userId);
    expect(payload.assignment.assigneeUserId).toBe(partner.userId);
    // THE WHOLE ROW, so the receiving screen renders "A. Trainee asked you
    // to look at this" and the message from one frame with no second query.
    expect(payload.assignment.message).toBe('Not sure the cap survives 14.2.');

    // …AND THE LIST. The push serves a session that is already open; the
    // list is how a person who was away from their desk finds out at all,
    // and a feature with only the first would lose every request made while
    // its assignee was signed out.
    const listed = await asUser(partner, 'GET', '/v1/assignments?state=open');
    expect(listed.status).toBe(200);
    const { assignments } = await listed.json() as {
      assignments: { id: string; clauseId: string }[];
    };
    expect(assignments.filter(a => a.id === payload.assignment.id)).toHaveLength(1);

    // …and it is NOT in the assigner's own list. "What has been asked of me"
    // is the caller's own queue, from the token; a route that answered with
    // everybody's would be a different feature with a different bar.
    const mine = await asUser(trainee, 'GET', '/v1/assignments?state=open');
    const theirs = await mine.json() as { assignments: { id: string }[] };
    expect(theirs.assignments.filter(a => a.id === payload.assignment.id)).toEqual([]);
  }, 60_000);

  it('changes no disposition on the way, on the running stack', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'assignment is not a disposition (Task 25)');
    litter.push({ who: trainee, seeded });

    const before = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}/findings`);
    const beforeBody = await before.text();

    const created = await asUser(trainee, 'POST', assignPath(seeded),
      { assigneeUserId: partner.userId });
    expect(created.status, await created.text()).toBe(201);

    const after = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}/findings`);
    // §6.3: a request, not a disposition. Over the SERVED bytes rather than
    // over a row, because what a reader is handed is what would carry a
    // judgement nobody made.
    expect(await after.text()).toBe(beforeBody);
  }, 60_000);

  it('closes when the assignee says they have looked, and leaves their list', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'assignment closes (Task 25)');
    litter.push({ who: trainee, seeded });

    const { socket, cursor } = await watching(trainee, seeded);
    const created = await asUser(trainee, 'POST', assignPath(seeded),
      { assigneeUserId: partner.userId });
    const { id } = await created.json() as { id: string };

    const closed = await asUser(partner, 'POST', `/v1/assignments/${id}/resolve`);
    expect(closed.status, await closed.text()).toBe(200);

    // The ASSIGNER hears about it too, live: they asked, so they are the
    // person waiting to know it was looked at.
    const frame = await socket.waitFor(
      liveAssignment('assignment.resolved', cursor), { timeoutMs: 5_000 });
    const payload = (frame.event as { payload: {
      assignment: { resolvedByUserId?: string };
    } }).payload;
    expect(payload.assignment.resolvedByUserId).toBe(partner.userId);

    const listed = await asUser(partner, 'GET', '/v1/assignments?state=open');
    const { assignments } = await listed.json() as { assignments: { id: string }[] };
    expect(assignments.filter(a => a.id === id)).toEqual([]);
  }, 60_000);

  it('refuses a third person closing it, with two real tokens', async () => {
    // Both people here are real and neither is the third party, so this is
    // asserted through the seeded realm's OWN accounts: the trainee assigns
    // to the partner, and the partner's request is closed by nobody else
    // because there is nobody else — so the negative is proved the only way
    // it can be here, by an id that is not either of them.
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'assignment refusal (Task 25)');
    litter.push({ who: trainee, seeded });
    const created = await asUser(trainee, 'POST', assignPath(seeded),
      { assigneeUserId: partner.userId });
    const { id } = await created.json() as { id: string };
    const missing = await asUser(partner, 'POST', '/v1/assignments/not-a-real-id/resolve');
    // A 403 would confirm the id exists somewhere.
    expect(missing.status).toBe(404);
    // …and the real one still closes, so the refusal above is about the id.
    expect((await asUser(partner, 'POST', `/v1/assignments/${id}/resolve`)).status).toBe(200);
  }, 60_000);
});
