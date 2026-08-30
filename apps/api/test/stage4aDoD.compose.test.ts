import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  API_BASE, asUser, twoAccounts, type TestAccount,
} from './helpers/twoAccounts.ts';
// NOTHING IS IMPORTED FROM `src/` HERE, and the reason is worth writing
// down: `apps/api`'s tsconfig is a Node project by construction, and any
// import from the browser workspace drags the DOM lib in behind it
// (`findingOutcome.ts` -> `../types` -> `docxRedlines.ts`, which names
// `DOMParser`). The export BYTES are asserted in `exportDocx.test.ts` and
// `csv.test.ts` under jsdom; what check 8 below adds is that the LIVE read
// gives those exporters exactly the inputs their sentences are made of.

/**
 * PART 4A'S GATE, ON A RUNNING STACK, WITH TWO REAL ACCOUNTS.
 *
 * ## How this differs from Task 1's demonstration
 *
 * `twoAccounts.compose.test.ts` demonstrated the GAP: a partner's override
 * of a trainee's verification succeeded, and the payload the browser renders
 * from named the partner by an id and nothing else — no name, no route that
 * could produce one, and no field saying the finding had been changed at
 * all. The trainee's own judgement was simply gone from it.
 *
 * This file demonstrates the same override CLOSED, over the same stack, with
 * the same two tokens: both sides are named, the change is on the read, a
 * simultaneous second write is refused with the row that won, the refused
 * person's re-apply produces a THIRD history row so both intentions are on
 * the record, and the DOCX and the CSV built from that review say when they
 * were true and that they can change again.
 *
 * ## Why `.compose.test.ts` and not the plan's `.pg.test.ts`
 *
 * The live half of this gate needs two Keycloak tokens and the shipped
 * proxy. A `.pg.test.ts` has a database connection and no stack: it could
 * assert the SQL and not the thing the gate is about, which is that two
 * different people, authenticated by the shipped verifier and resolved by
 * the shipped actor resolver, land on one row and are both nameable
 * afterwards. The searched half is `stage4aDoD.test.ts`.
 *
 * Requires `npm run compose:up` with an `api` built from this commit.
 */

const now = (): number => Date.now();

interface Seeded { matterId: string; reviewId: string; findingsKey: string; clauseId: string }

const litter: { who: TestAccount; seeded: Seeded }[] = [];

const dispositionPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/disposition`;

async function seedOneDoneFinding(who: TestAccount): Promise<Seeded> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const seeded: Seeded = {
    matterId: `g4a-${stamp}`,
    reviewId: `g4a-${stamp}-review`,
    findingsKey: 'd1',
    clauseId: 'c1',
  };

  const matter = await asUser(who, 'PUT', `/v1/matters/${seeded.matterId}`,
    { name: 'Part 4A gate', createdAt: now() });
  expect(matter.status, await matter.text()).toBe(200);

  const review = await asUser(who, 'PUT', `/v1/reviews/${seeded.reviewId}`, {
    matterId: seeded.matterId,
    playbookSnapshot: {
      id: 'p1', name: 'Part 4A gate', clauses: [{ id: 'c1', title: 'Liability cap' }],
    },
    target: { kind: 'documents', documentIds: [] },
    documentIds: [],
    modelId: 'test-model',
    startedAt: now(),
    findings: {
      [seeded.findingsKey]: {
        [seeded.clauseId]: {
          clauseId: seeded.clauseId,
          status: 'done',
          summary: 'Liability is capped at the fees paid in the preceding 12 months.',
          citations: [],
        },
      },
    },
  });
  expect(review.status, await review.text()).toBe(200);

  litter.push({ who, seeded });
  return seeded;
}

interface DispositionCell {
  disposition: {
    state: string; byUserId?: string; at?: number; changedCount: number; version: number;
  };
  last?: { fromState: string; byUserId: string; cause: string };
}

async function readCell(who: TestAccount, s: Seeded): Promise<DispositionCell> {
  const page = await asUser(who, 'GET', `/v1/reviews/${s.reviewId}/findings`);
  expect(page.status).toBe(200);
  const read = await page.json() as {
    dispositions: Record<string, Record<string, DispositionCell>>;
  };
  return read.dispositions[s.findingsKey][s.clauseId];
}

describe('Part 4A gate — the record is honest, with two accounts on a running stack', () => {
  afterAll(async () => {
    // Rule 7: everything this gate created is deleted.
    for (const { who, seeded } of litter.splice(0)) {
      await asUser(who, 'DELETE', `/v1/reviews/${seeded.reviewId}`);
      await asUser(who, 'DELETE', `/v1/matters/${seeded.matterId}`);
    }
  });

  it('2. refuses an unauthenticated caller by NAME, not with an empty list', async () => {
    const { trainee, partner } = await twoAccounts();
    expect(trainee.userId).not.toBe(partner.userId);

    const anonymous = await fetch(`${API_BASE}/v1/matters`);
    expect(anonymous.status).toBe(401);
    const body = await anonymous.json() as { error: { code: string } };
    // "You are not signed in" and "you have no matters" are different facts,
    // and only one of them is an answer.
    expect(body.error.code).toBe('sign_in_required');
    expect(JSON.stringify(body)).not.toContain('[]');
  });

  it('3. lists both people to a signed-in reviewer, and nobody to a stranger', async () => {
    const { trainee, partner } = await twoAccounts();
    const res = await asUser(trainee, 'GET', '/v1/workspace/users');
    expect(res.status).toBe(200);
    const { users } = await res.json() as { users: { id: string; displayName: string }[] };
    expect(users.some(u => u.id === trainee.userId)).toBe(true);
    expect(users.some(u => u.id === partner.userId)).toBe(true);

    expect((await fetch(`${API_BASE}/v1/workspace/users`)).status).toBe(401);
  });

  it('4-5. names each side of an override, to the OTHER person, on the read they render from',
    async () => {
      const { trainee, partner } = await twoAccounts();
      const seeded = await seedOneDoneFinding(trainee);

      // 4. The trainee verifies. The PARTNER's read carries the trainee.
      const first = await asUser(trainee, 'PUT', dispositionPath(seeded),
        { state: 'verified', version: 1 });
      expect(first.status, await first.clone().text()).toBe(200);

      const seenByPartner = await readCell(partner, seeded);
      expect(seenByPartner.disposition.byUserId).toBe(trainee.userId);
      expect(seenByPartner.disposition.changedCount).toBe(1);
      expect(seenByPartner.last!.fromState).toBe('unchecked');

      // 5. The partner overrides, with a reason. The TRAINEE's read now
      // names the partner and says the judgement was replaced — the exact
      // payload that, in Task 1's demonstration, carried an id and nothing
      // that could become a name.
      const override = await asUser(partner, 'PUT', dispositionPath(seeded),
        { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 2 });
      expect(override.status, await override.clone().text()).toBe(200);

      const seenByTrainee = await readCell(trainee, seeded);
      expect(seenByTrainee.disposition.byUserId).toBe(partner.userId);
      expect(seenByTrainee.disposition.changedCount).toBe(2);
      expect(seenByTrainee.last!.fromState).toBe('verified');
      expect(seenByTrainee.disposition.version).toBe(3);
    });

  it('6. refuses one of two simultaneous writes with the row that WON, and records both intentions',
    async () => {
      const { trainee, partner } = await twoAccounts();
      const seeded = await seedOneDoneFinding(trainee);
      // One verification first, so the concurrent pair below contends over a
      // judgement that already exists — which is the case the requirement is
      // about ("a partner may override a verification"), and which makes the
      // re-apply's row the THIRD rather than the second.
      const opened = await asUser(trainee, 'PUT', dispositionPath(seeded),
        { state: 'verified', version: 1 });
      expect(opened.status, await opened.clone().text()).toBe(200);

      // Both against version 2, at once, over the real proxy.
      const [a, b] = await Promise.all([
        asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'unchecked', version: 2 }),
        asUser(partner, 'PUT', dispositionPath(seeded),
          { state: 'rejected', reason: 'The cap is uncapped.', version: 2 }),
      ]);
      const codes = [a.status, b.status].sort();
      expect(codes, `${await a.clone().text()} | ${await b.clone().text()}`).toEqual([200, 409]);

      const refused = a.status === 409 ? a : b;
      const loser = a.status === 409 ? trainee : partner;
      const refusal = await refused.json() as {
        current?: { state: string; byUserId?: string; version: number };
      };
      // THE REFUSAL CARRIES THE ROW THAT WON, so §6.3's sentence — "R.
      // Okafor changed this to Rejected at 14:22, after you loaded it" —
      // needs no second round trip. This is the field the browser could not
      // read at all before Stage 4: `modelErrorFrom` dropped it.
      expect(refusal.current, 'the refusal named no row').toBeDefined();
      expect(refusal.current!.version).toBe(3);
      expect(refusal.current!.byUserId).toBeTruthy();
      expect(refusal.current!.byUserId).not.toBe(loser.userId);

      // THE RE-APPLY, by the person who lost, against the version that won.
      // A PERSON's second request — nothing retried this for them.
      const again = await asUser(loser, 'PUT', dispositionPath(seeded),
        { state: 'flagged', version: 3 });
      expect(again.status, await again.clone().text()).toBe(200);

      // A THIRD history row: both intentions are on the record.
      const history = await asUser(trainee, 'GET',
        `/v1/reviews/${seeded.reviewId}/findings/${seeded.findingsKey}/${seeded.clauseId}/history`);
      const { events } = await history.json() as {
        events: { fromState: string; toState: string; byUserId: string }[];
      };
      expect(events).toHaveLength(3);
      expect(events[0]!.toState).toBe('flagged');
      expect(events[0]!.byUserId).toBe(loser.userId);
    });

  it('7. lists a review s whole history, oldest first, with BOTH names', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee);
    await asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'verified', version: 1 });
    await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped.', version: 2 });
    await asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'verified', version: 3 });

    const res = await asUser(partner, 'GET', `/v1/reviews/${seeded.reviewId}/history`);
    expect(res.status, await res.clone().text()).toBe(200);
    const page = await res.json() as {
      events: { fromState: string; toState: string; byUserId: string; clauseTitle?: string }[];
      hasMore: boolean;
    };
    expect(page.events.map(e => [e.fromState, e.toState])).toEqual([
      ['unchecked', 'verified'],
      ['verified', 'rejected'],
      ['rejected', 'verified'],
    ]);
    expect(new Set(page.events.map(e => e.byUserId)))
      .toEqual(new Set([trainee.userId, partner.userId]));
    // The clause is named from the review's OWN snapshot.
    expect(page.events[0]!.clauseTitle).toBe('Liability cap');
    expect(page.hasMore).toBe(false);
  });

  it('8. gives an export everything its point-in-time sentences are made of', async () => {
    /*
     * §19's worst-consequence item, live. The export's three requirements
     * are "when it was true", "what changed", and "it can change again", and
     * the first two are made ENTIRELY of fields on this read: the
     * disposition's state, its actor, its `changedCount`, and the previous
     * state on the event beside it. A read missing any of them turns
     * `dispositionLabel` into "Checked state not read" on every clause of a
     * report a partner will send.
     *
     * The BYTES are `exportDocx.test.ts`'s and `csv.test.ts`'s — a DOCX and
     * a CSV are bytes a jsdom test reads, and those suites read them. What
     * cannot be checked there is that a LIVE, contested, three-times-moved
     * clause arrives shaped the way those fixtures assume.
     */
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee);
    await asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'verified', version: 1 });
    await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped.', version: 2 });
    await asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'verified', version: 3 });

    const cell = await readCell(trainee, seeded);
    expect(cell.disposition.state).toBe('verified');
    expect(cell.disposition.changedCount).toBe(3);          // "- changed 3 times"
    expect(cell.last!.fromState).toBe('rejected');          // "- was Rejected"
    expect(typeof cell.disposition.at).toBe('number');      // the instant in the line
    expect(cell.disposition.byUserId).toBe(trainee.userId); // "Verified by …"

    // …and the id resolves to a NAME through the one resolver, which is what
    // turns the line above into prose rather than a uuid.
    const directory = await asUser(trainee, 'GET', '/v1/workspace/users');
    const { users } = await directory.json() as { users: { id: string; displayName: string }[] };
    expect(users.find(u => u.id === cell.disposition.byUserId)!.displayName)
      .toBe(trainee.displayName);

    // The history export's own source, live and complete: three rows, both
    // people, oldest first.
    const historyRes = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}/history`);
    const { events } = await historyRes.json() as { events: { byUserId: string }[] };
    expect(events).toHaveLength(3);
    expect(new Set(events.map(e => e.byUserId)))
      .toEqual(new Set([trainee.userId, partner.userId]));
  });

  it('9. names both people in the matter s activity feed', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee);
    await asUser(trainee, 'PUT', dispositionPath(seeded), { state: 'verified', version: 1 });
    await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped.', version: 2 });

    const res = await asUser(partner, 'GET', `/v1/matters/${seeded.matterId}/activity`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { rows } = await res.json() as {
      rows: { source: string; kind: string; byUserId: string; clauseTitle?: string }[];
    };
    expect(new Set(rows.filter(r => r.source === 'disposition').map(r => r.byUserId)))
      .toEqual(new Set([trainee.userId, partner.userId]));
    // The matter's own creation is in the feed too, from `audit_event` —
    // Task 11's first writer, read where it lives.
    expect(rows.some(r => r.source === 'audit' && r.kind === 'matter.created')).toBe(true);
    // S22: the disposition is NOT also in the audit log.
    expect(rows.some(r => r.source === 'audit' && /finding|disposition/.test(r.kind))).toBe(false);
  });

  it('10. still cannot reach the public internet from api', () => {
    // §5's central claim is a NETWORK fact, and a new route group landed —
    // so it is re-checked rather than inherited.
    let out = '';
    let code = 0;
    try {
      out = execFileSync('docker', [
        'compose', 'exec', '-T', 'api', 'node', '-e',
        "fetch('https://example.com',{signal:AbortSignal.timeout(8000)})"
        + ".then(r=>console.log('REACHED',r.status)).catch(e=>console.log('BLOCKED',e.message))",
      ], { encoding: 'utf8', timeout: 30_000 });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code, out).toBe(0);
    expect(out).toContain('BLOCKED');
    expect(out).not.toContain('REACHED');
  });
});
