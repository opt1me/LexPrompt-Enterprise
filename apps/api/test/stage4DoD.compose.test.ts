import { describe, it, expect, afterAll } from 'vitest';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import {
  dispositionPath, notesPath, removeSeeded, seedOneDoneFinding, type Seeded,
} from './helpers/seedReview.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';

/**
 * STAGE 4'S DEFINITION OF DONE, ON THE RUNNING STACK.
 *
 * §18 item 5 in one pass, with two real accounts and two real tokens from the
 * seeded realm, through nginx on the browser's own origin. What each clause
 * is MET BY is the point of the file: a mechanism proved here is a different
 * kind of evidence from a string rendered in jsdom, and the report keeps them
 * apart.
 *
 * ## What this deliberately does NOT restate
 *
 * `livePush`, `replicaFanout`, `presence` and `assignmentReaches` each prove
 * their own clause in full. This file re-runs the ONE END-TO-END SEQUENCE a
 * person would actually perform — a trainee verifies, a partner overrides, a
 * note, an assignment, presence — because the clauses interacting is the
 * thing no single suite covers, and because §18 item 5 is a sentence about a
 * session rather than about a route.
 *
 * ## And what nobody has seen
 *
 * Every assertion below is about bytes and frames. Whether the refusal READS
 * as an error rather than a decision, whether the held-update line is noticed
 * mid-sentence, whether a presence face reads as "looking" rather than
 * "checked" — none of that is here, because browser automation has been
 * unavailable for this whole project. `stage-4-report.md` names those seven
 * things rather than implying them.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

const live = (type: string, after: number) => (f: Frame): boolean => {
  if (f.t !== 'event') return false;
  const event = f.event as { type?: string; id?: number } | undefined;
  return event?.type === type && Number(event.id) > after;
};

describe('§18 item 5, end to end, with two people', () => {
  it('carries one session through every clause of it', async () => {
    const { trainee, partner } = await twoAccounts();
    expect(trainee.userId).not.toBe(partner.userId);
    const seeded = await seedOneDoneFinding(trainee, 'Stage 4 DoD (Task 26)');
    litter.push({ who: trainee, seeded });

    // ---- the trainee is watching, and says where they are ----
    const socket = await connect(WS_URL, trainee.token, { timeoutMs: 15_000 });
    sockets.push(socket);
    await socket.waitFor('hello', { timeoutMs: 10_000 });
    socket.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
    const caughtUp = await socket.waitFor('caught_up', { timeoutMs: 10_000 });
    const cursor = Number(caughtUp.cursor);
    socket.send({
      t: 'presence', sub: { review: seeded.reviewId }, screen: 'review',
      clauseId: seeded.clauseId,
    });

    // ---- CLAUSE: a person's judgement is recorded, and names them ----
    const verified = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 1 });
    // READ ONCE. A `Response` body can be consumed exactly once, so
    // `expect(res.status, await res.text())` followed by `res.json()` throws
    // "Body has already been read" -- a failure that names the test rather
    // than the thing under test.
    const verifiedBody = await verified.text();
    expect(verified.status, verifiedBody).toBe(200);
    const first = JSON.parse(verifiedBody) as {
      disposition: { byUserId: string; at: number; changedCount: number; version: number };
    };
    expect(first.disposition.byUserId).toBe(trainee.userId);
    expect(typeof first.disposition.at).toBe('number');

    // ---- CLAUSE: another person may override it, and the change is NAMED ----
    const override = await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 2 });
    expect(override.status, await override.text()).toBe(200);


    // ---- CLAUSE: it reaches the other person's socket, attributed ----
    /*
     * THE PARTNER'S event, not merely the next one above the cursor.
     *
     * The trainee's OWN verification is also a `finding.disposition_changed`
     * above that cursor -- their own echo, which the browser drops by
     * version. Matching on the type alone made this assert about the
     * trainee's frame and fail saying "expected verified to be rejected",
     * which reads as a broken push rather than as a test matching the wrong
     * frame.
     */
    const pushed = await socket.waitFor(f => {
      if (!live('finding.disposition_changed', cursor)(f)) return false;
      const p = (f.event as { payload?: { disposition?: { byUserId?: string } } }).payload;
      return p?.disposition?.byUserId === partner.userId;
    }, { timeoutMs: 5_000 });
    const payload = (pushed.event as { payload: {
      disposition: { state: string; byUserId: string; changedCount: number };
      event: { fromState: string; toState: string; byUserId: string };
      version: number;
    } }).payload;
    expect(payload.disposition.state).toBe('rejected');
    expect(payload.disposition.byUserId).toBe(partner.userId);
    // §8, verbatim: the row AND the event that produced it, so "Rejected by
    // R. Okafor — was Verified" is renderable from one frame.
    expect(payload.event.fromState).toBe('verified');
    expect(payload.event.toState).toBe('rejected');
    // ONE version number doing both jobs, not two.
    expect(payload.version).toBe(payload.disposition.changedCount + 1);

    // ---- CLAUSE: a stale change is REFUSED, and the refusal carries the
    // row that replaced it ----
    const stale = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 2 });
    expect(stale.status).toBe(409);
    const refusal = await stale.json() as {
      error: { code: string };
      current?: { byUserId?: string; state?: string; version?: number };
    };
    expect(refusal.error.code).toBe('conflict');
    /*
     * NAMED, and read off the SHIPPED envelope rather than the brief's guess
     * at it. `current` sits at the TOP of the body (`server.ts`'s
     * `setErrorHandler`) and is a flat `DispositionView` (`routes/
     * findings.ts`'s `asView` maps the row before re-throwing) -- not
     * `error.details.disposition`, which is what this assertion said first
     * and which would have passed as `undefined === undefined` had it been
     * written with an optional chain and no expectation of a value.
     *
     * §6.3's own sentence needs the actor and the state, and the browser
     * must not make a second request to render it.
     */
    expect(refusal.current?.byUserId).toBe(partner.userId);
    expect(refusal.current?.state).toBe('rejected');

    // …and the SAME change offered again against the new version succeeds,
    // writing a SECOND history row so both intentions are on the record.
    const reapplied = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 3 });
    expect(reapplied.status, await reapplied.text()).toBe(200);

    const history = await asUser(trainee, 'GET',
      `/v1/reviews/${seeded.reviewId}/findings/${seeded.findingsKey}/${seeded.clauseId}/history`);
    const historyBody = await history.text();
    expect(history.status, historyBody).toBe(200);
    const { events } = JSON.parse(historyBody) as {
      events: { byUserId: string; toState: string; cause: string }[];
    };
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map(e => e.byUserId)).toContain(partner.userId);
    // EVERY row names a person and a cause; nothing derives one.
    for (const e of events) {
      expect(e.byUserId, JSON.stringify(e)).toBeTruthy();
      expect(['human', 'rerun_reset']).toContain(e.cause);
    }

    // ---- CLAUSE: a note, and an assignment, both reaching the same socket ----
    const note = await asUser(partner, 'POST', notesPath(seeded), { text: 'See 14.2.' });
    expect(note.status, await note.text()).toBe(201);
    await socket.waitFor(live('note.added', cursor), { timeoutMs: 5_000 });

    const assigned = await asUser(trainee, 'POST',
      `/v1/reviews/${seeded.reviewId}/findings/${seeded.findingsKey}/${seeded.clauseId}`
      + '/assignments',
      { assigneeUserId: partner.userId, message: 'Not sure the cap survives 14.2.' });
    expect(assigned.status, await assigned.text()).toBe(201);
    await socket.waitFor(live('assignment.created', cursor), { timeoutMs: 5_000 });

    // ---- CLAUSE: the audit log holds the assignment and NOT the
    // disposition change (S22) ----
    const activity = await asUser(trainee, 'GET', `/v1/matters/${seeded.matterId}/activity`);
    const activityBody = await activity.text();
    expect(activity.status, activityBody).toBe(200);
    // `kind`, not `action`: the feed's own field name, read off the shipped
    // `routes/activity.ts` rather than guessed at. A row's `kind` is the
    // audit ACTION on an audit row and the new STATE on a disposition row,
    // which is what lets one list carry three records.
    const feed = JSON.parse(activityBody) as { rows: { source: string; kind?: string }[] };
    const audited = feed.rows.filter(r => r.source === 'audit');
    expect(audited.map(r => r.kind)).toContain('assignment.created');
    // Two append-only accounts of one fact is how a card and an export come
    // to disagree in front of an auditor.
    expect(audited.filter(r => (r.kind ?? '').startsWith('finding.'))).toEqual([]);
    // …and the disposition changes ARE in the feed, from their own table.
    expect(feed.rows.some(r => r.source === 'disposition')).toBe(true);
  }, 120_000);

  it('still lets no unauthenticated socket come into being (S29)', async () => {
    // Re-checked rather than inherited: a new dependency arrived this stage
    // and this is the one route whose whole design claim is that it is
    // authenticated before the upgrade.
    await expect(connect(WS_URL, '', { timeoutMs: 10_000 })).rejects.toThrow();
    await expect(connect(WS_URL, 'not-a-token', { timeoutMs: 10_000 })).rejects.toThrow();
    // …and the positive half, so the refusals above are about the token.
    const { trainee } = await twoAccounts();
    const ok = await connect(WS_URL, trainee.token, { timeoutMs: 15_000 });
    sockets.push(ok);
    expect((await ok.waitFor('hello', { timeoutMs: 10_000 })).userId).toBe(trainee.userId);
  }, 60_000);

  it('persists no presence, after a session that used it (S6)', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'Stage 4 DoD, who is here (Task 26)');
    litter.push({ who: trainee, seeded });

    for (const who of [trainee, partner]) {
      // eslint-disable-next-line no-await-in-loop
      const s = await connect(WS_URL, who.token, { timeoutMs: 15_000 });
      sockets.push(s);
      // eslint-disable-next-line no-await-in-loop
      await s.waitFor('hello', { timeoutMs: 10_000 });
      s.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
      // eslint-disable-next-line no-await-in-loop
      await s.waitFor('caught_up', { timeoutMs: 10_000 });
      s.send({
        t: 'presence', sub: { review: seeded.reviewId }, screen: 'review',
        clauseId: seeded.clauseId,
      });
    }

    /*
     * The database's own catalogue is `presence.pg.test.ts`'s. What THIS can
     * add is that a presence session leaves nothing a READER of the API can
     * find: the review, its findings and its history are exactly what they
     * were, with no roster smuggled onto any of them.
     */
    const review = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}`);
    expect(review.status).toBe(200);
    const body = await review.text();
    expect(body.toLowerCase()).not.toContain('presence');
    const findings = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}/findings`);
    expect((await findings.text()).toLowerCase()).not.toContain('presence');
  }, 90_000);
});
