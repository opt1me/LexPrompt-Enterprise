import { describe, it, expect, afterAll } from 'vitest';
import { API_BASE, asUser, twoAccounts, type TestAccount } from './helpers/twoAccounts.ts';
import { dispositionPath, removeSeeded, seedOneDoneFinding, type Seeded } from './helpers/seedReview.ts';
import { connect, type Frame, type TestSocket } from './helpers/wsClient.ts';

/**
 * SPIKE 3'S QUESTION, EXECUTED LOCALLY AT TWO REPLICAS (Task 14, P41).
 *
 * Does a client connected to one replica see a write made on another?
 *
 * `docker-compose.yml` runs `api` at `replicas: 2` and `web`'s nginx
 * resolves it per request through Docker's embedded DNS, which answers both
 * containers' A records — so successive connections genuinely land on
 * different containers. That condition is not assumed here: every socket's
 * `hello` frame carries the replica's own `instanceId`, so "these two
 * sockets are on different replicas" is a FACT this file checks before it
 * asserts anything, and twenty attempts that all land on one replica FAIL
 * saying so rather than passing vacuously.
 *
 * ## Why this file was written RED
 *
 * It was created by Task 14 and skipped, naming Task 18, because with an
 * in-process hub the answer is no: a socket held by replica A never learns
 * of a write served by replica B. That failure IS the spike's answer and it
 * is the evidence the "outbox-by-cursor, `pg_notify` as a doorbell, no
 * Redis" decision rests on. Task 18 builds that fan-out and un-skips this.
 *
 * The half this file CANNOT answer is Azure's: ingress idle timeouts,
 * scale-to-zero wake behaviour, and whether Container Apps ingress pins a
 * socket to a replica. No Azure environment has been reachable for three
 * stages. That half stays named as unanswered in
 * `spike-3-report.md` rather than guessed at.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const litter: { who: TestAccount; seeded: Seeded }[] = [];
const sockets: TestSocket[] = [];

/**
 * Two sockets on DIFFERENT replicas, or a failure that says so.
 *
 * The loop is bounded and the bound is the assertion: nginx round-robins
 * over the addresses its resolver returns, so a handful of attempts is
 * plenty, and twenty that all land on one replica means the multi-replica
 * condition this file exists to test does not exist — which must be a
 * failure, not a pass.
 */
async function twoSocketsOnDifferentReplicas(
  a: TestAccount, b: TestAccount,
): Promise<[TestSocket, TestSocket]> {
  const first = await connect(WS_URL, a.token);
  sockets.push(first);
  const firstHello = await first.waitFor('hello');
  const seen = new Set<string>([String(firstHello.instanceId)]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = await connect(WS_URL, b.token);
    sockets.push(next);
    const hello = await next.waitFor('hello');
    if (hello.instanceId !== firstHello.instanceId) return [first, next];
    seen.add(String(hello.instanceId));
    next.close();
  }
  throw new Error(
    'twenty connections all landed on one replica '
    + `(instance ids seen: ${[...seen].join(', ')}). The cross-replica condition this file `
    + 'tests does not exist, so a pass here would mean nothing. Check that `api` really is '
    + 'running at two replicas (`docker compose ps`) and that nginx is resolving it per '
    + 'request (infra/nginx/web.conf).');
}

// SKIPPED BY TASK 14, UN-SKIPPED BY TASK 18. The reason is in the source
// rather than in somebody's memory: there is no `/v1/ws` route at all as of
// Task 14 (it arrives in Task 16), and even once there is, the hub is
// in-process — so this test fails, and that failure is Spike 3's answer.
// `it.fails` would have passed for the wrong reason (a connection refused
// rather than an undelivered event), which is why this is a skip with a
// sentence and not an inverted assertion.
describe.skip('fan-out across replicas', () => {
  afterAll(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
  });

  it('delivers a write made on one replica to a socket held on the other', async () => {
    const { trainee, partner } = await twoAccounts();
    const seeded = await seedOneDoneFinding(trainee, 'replica fan-out (Task 14)');
    litter.push({ who: trainee, seeded });

    const [a, b] = await twoSocketsOnDifferentReplicas(trainee, partner);
    // The listening socket subscribes; the WRITE goes over HTTP, which
    // nginx may route to either replica — so the assertion below holds
    // whichever replica served the PUT, and it is the socket's own replica
    // being the OTHER one that makes it interesting.
    a.send({ t: 'subscribe', sub: { review: seeded.reviewId }, lastEventId: 0 });
    await a.waitFor('caught_up');
    // `b` is only here to prove the two replicas were both reachable; the
    // delivery being asserted is `a`'s.
    expect(b.open).toBe(true);

    const started = Date.now();
    const put = await asUser(partner, 'PUT', dispositionPath(seeded),
      { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 1 });
    expect(put.status, await put.text()).toBe(200);

    const seen: Frame = await a.waitFor(
      f => f.t === 'event'
        && (f.event as { type?: string } | undefined)?.type === 'finding.disposition_changed',
      { timeoutMs: 5_000 });
    const event = seen.event as { payload: { disposition: { state: string; byUserId?: string } } };
    expect(event.payload.disposition.state).toBe('rejected');
    expect(event.payload.disposition.byUserId).toBe(partner.userId);
    // A NUMBER rather than an impression: this is the latency a reviewer
    // actually waits, across replicas, through the proxy.
    process.stdout.write(`cross-replica disposition push: ${Date.now() - started} ms\n`);
  }, 30_000);
});
