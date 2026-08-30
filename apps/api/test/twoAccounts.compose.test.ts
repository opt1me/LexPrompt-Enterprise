import { describe, it, expect, afterAll } from 'vitest';
import {
  API_BASE, asUser, twoAccounts, type TestAccount,
} from './helpers/twoAccounts.ts';

/**
 * THE GAP THIS WHOLE STAGE EXISTS TO CLOSE, DEMONSTRATED RATHER THAN ARGUED.
 *
 * Change-by-others is already live and already unattributed. `PUT
 * …/disposition` is `ROUTE_POLICY: 'reviewer'`, scoped by workspace and
 * nothing else, and `setDisposition` compares a version and a state but
 * never actors. So the moment a second seeded account signs in — which, as
 * of this task, it can — one reviewer can overwrite another's verification,
 * and the data a card renders from names neither of them.
 *
 * Two real tokens, through the real proxy, against the real stack. Not
 * `app.inject` with a stubbed `resolveActor`: the point is that two DIFFERENT
 * people, each authenticated by the shipped verifier and resolved by the
 * shipped actor resolver, land on the same row.
 *
 * ## The three assertions this stage INVERTS
 *
 * Each names the task that inverts it, so a reader of a red test in a later
 * task knows where it goes rather than deleting it:
 *
 *  - `changedCount` is absent from the finding's verification  -> Task 3
 *  - the findings page carries no `dispositions` map           -> Task 3
 *  - no route resolves another user's name                     -> Task 2
 *
 * They are written as assertions rather than as prose because a documented
 * gap is a claim and a red test is a fact — and because, once Tasks 2 and 3
 * land, the failure this file produces is the record that they did.
 */

const now = (): number => Date.now();

interface Seeded { matterId: string; reviewId: string; findingsKey: string; clauseId: string }

/** Everything this file created, torn down in `afterAll` — `test:pg` and
 *  `test:compose` share ONE database, and a suite that leaves state behind
 *  breaks a different file with a message pointing at the wrong feature. */
const litter: { who: TestAccount; seeded: Seeded }[] = [];

/**
 * One review, one clause, one `done` finding nobody has judged yet.
 *
 * Seeded over HTTP as the signed-in person rather than by reaching into
 * Postgres, so that every row it produces carries the attribution the API
 * would actually have given it. The findings map travels on the CREATE —
 * `PUT /v1/reviews/:id` accepts findings for a review this workspace has
 * never seen (`importFindings`) and refuses them on an update — and the
 * import records the authenticated actor and nobody else.
 */
async function seedOneDoneFinding(who: TestAccount): Promise<Seeded> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const seeded: Seeded = {
    matterId: `t1-${stamp}`,
    reviewId: `t1-${stamp}-review`,
    findingsKey: 'd1',
    clauseId: 'c1',
  };

  const matter = await asUser(who, 'PUT', `/v1/matters/${seeded.matterId}`,
    { name: 'Two accounts (Task 1)', createdAt: now() });
  expect(matter.status, await matter.text()).toBe(200);

  const review = await asUser(who, 'PUT', `/v1/reviews/${seeded.reviewId}`, {
    matterId: seeded.matterId,
    playbookSnapshot: { id: 'p1', name: 'Task 1', clauses: [] },
    // No documents: this suite is about WHO changed a judgement, and a
    // document would add an upload, a parse and a blob to a test that
    // asserts nothing about any of them. `findingsKeyFor` returns the key
    // itself for a `documents` target, so 'd1' is a key this review's own
    // target explains.
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

const dispositionPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/disposition`;

/** Whether a route is REGISTERED, as distinct from refused. A signed-in
 *  caller reaching an unregistered path gets Fastify's 404; anything else
 *  means the route exists and answered. */
async function routeExists(who: TestAccount, path: string): Promise<boolean> {
  const res = await asUser(who, 'GET', path);
  return res.status !== 404;
}

describe('two real accounts, and the unattributed override they demonstrate', () => {
  afterAll(async () => {
    for (const { who, seeded } of litter.splice(0)) {
      // The review first: a matter delete cascades, but deleting in
      // dependency order means a failure names the record that actually
      // resisted rather than a foreign key.
      await asUser(who, 'DELETE', `/v1/reviews/${seeded.reviewId}`);
      await asUser(who, 'DELETE', `/v1/matters/${seeded.matterId}`);
    }
  });

  it('signs two DIFFERENT people in, each with their own app_user id', async () => {
    const { trainee, partner } = await twoAccounts();
    // The whole premise. Two tokens that resolved to one row would make
    // every assertion below vacuous.
    expect(trainee.userId).not.toBe(partner.userId);
    expect(trainee.role).toBe('reviewer');
    expect(partner.role).toBe('partner');
    expect(trainee.token).not.toBe(partner.token);
    // Through the PROXY, because `api` publishes no port by construction.
    expect(API_BASE).toBe('http://localhost:3005/api');
  });

  it('lets a second person overwrite the first person s verification, and says nothing about who', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee);

    const first = await asUser(trainee, 'PUT', dispositionPath(seeded),
      { state: 'verified', version: 1 });
    expect(first.status, await first.text()).toBe(200);

    const override = await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 2 });
    // IT SUCCEEDS TODAY. Nothing compares actors; the route is `reviewer`
    // and the only guard is the version.
    expect(override.status, await override.clone().text()).toBe(200);
    const body = await override.json() as { disposition: { byUserId?: string; state: string } };
    expect(body.disposition.byUserId).toBe(partner.userId);
    expect(body.disposition.state).toBe('rejected');

    // AND THE GAP. This is the payload the browser's findings pane actually
    // renders from.
    const page = await asUser(trainee, 'GET', `/v1/reviews/${seeded.reviewId}/findings`);
    expect(page.status).toBe(200);
    const read = await page.json() as {
      findings: Record<string, Record<string, { verification: Record<string, unknown> }>>;
      dispositions?: unknown;
    };
    const verification = read.findings[seeded.findingsKey][seeded.clauseId].verification;

    // The trainee's verification is gone, replaced by a stranger's rejection.
    expect(verification.state).toBe('rejected');
    // An id, and only an id: nothing here could become a name.
    expect(verification.byUserId).toBe(partner.userId);
    expect(verification.byUserId).not.toBe(trainee.userId);

    // `in`, not `toEqual`: `toEqual` cannot tell an absent key from an
    // undefined one, and absence is the thing being asserted.
    expect('changedCount' in verification).toBe(false);   // -> Task 3
    expect('dispositions' in read).toBe(false);           // -> Task 3
    expect(await routeExists(trainee, '/v1/workspace/users')).toBe(false);  // -> Task 2

    // The one thing that IS on the record today, and the reason Part 4A is
    // an attribution problem rather than a storage one: the history exists,
    // and no screen reads it.
    const history = await asUser(trainee,
      'GET', `/v1/reviews/${seeded.reviewId}/findings/${seeded.findingsKey}/${seeded.clauseId}/history`);
    expect(history.status).toBe(200);
    const events = (await history.json() as { events: { fromState: string; toState: string; byUserId: string }[] }).events;
    expect(events.map(e => [e.fromState, e.toState, e.byUserId])).toEqual([
      ['verified', 'rejected', partner.userId],
      ['unchecked', 'verified', trainee.userId],
    ]);
  });
});
