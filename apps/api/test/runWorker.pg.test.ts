import { describe, it, expect } from 'vitest';
import { withPg } from './helpers/pgHarness.ts';
import {
  WS, MODEL, aDocument, aMatter, aModelChoice, aReview, aRun, aUser, assertStatesAgree,
  fakeGateway, workerDeps,
} from './helpers/runHarness.ts';
import {
  allowlistOf, leaseCell, releaseOwnOrphanedLeases, runOneStep, withCapabilities,
} from '../src/run/worker.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * Task 10: the engine runs server-side, one leased cell per transaction.
 *
 * Every scenario ends with `assertStatesAgree`, because an invariant checked
 * in one scenario is an assertion about one scenario.
 */

async function cell(t: Tx, runId: string, clause: string) {
  const rows = await t.query<{
    state: string; attempts: number; leased_by: string | null; last_error: string | null;
  }>('select state, attempts, leased_by, last_error from run_cell where run_id = $1 '
    + 'and clause_id = $2', [runId, clause]);
  return rows[0];
}

async function finding(t: Tx, reviewId: string, key: string, clause: string) {
  const rows = await t.query<{
    status: string; summary: string | null; error: string | null; citations: unknown;
    version: string; risk_level: string | null;
  }>('select status, summary, error, citations, version, risk_level from finding '
    + 'where review_id = $1 and findings_key = $2 and clause_id = $3', [reviewId, key, clause]);
  return rows[0];
}

async function run(t: Tx, runId: string) {
  const rows = await t.query<{
    state: string; provider: string | null; model: string | null; jurisdiction: unknown;
    started_at: Date | null; finished_at: Date | null; heartbeat_at: Date | null;
  }>('select state, provider, model, jurisdiction, started_at, finished_at, heartbeat_at '
    + 'from run where id = $1', [runId]);
  return rows[0];
}

async function events(t: Tx, runId: string): Promise<string[]> {
  const rows = await t.query<{ type: string }>(
    'select type from event where run_id = $1 order by id', [runId]);
  return rows.map(r => r.type);
}

async function seedOneCell(t: Tx, suffix: string): Promise<{ userId: string }> {
  const userId = await aUser(t);
  await aMatter(t, `w-m-${suffix}`);
  await aDocument(t, `w-d-${suffix}`, `w-m-${suffix}`);
  await aReview(t, `w-r-${suffix}`, `w-m-${suffix}`,
    { kind: 'documents', documentIds: [`w-d-${suffix}`] }, ['c1']);
  await aModelChoice(t);
  await aRun(t, `w-run-${suffix}`, `w-r-${suffix}`,
    [{ key: `w-d-${suffix}`, clause: 'c1' }], userId);
  return { userId };
}

describe('the lease', () => {
  it('claims a queued cell, promotes the run, and opens the finding — in one transaction', async () => {
    await withPg(async t => {
      await seedOneCell(t, 'lease');
      const { gateway } = fakeGateway();
      const leased = await leaseCell(workerDeps(t, gateway).db, workerDeps(t, gateway), 'w#1');

      expect(leased?.cell.clause_id).toBe('c1');
      expect(leased?.cell.state).toBe('leased');
      expect(leased?.cell.leased_by).toBe('w#1');
      // `attempts` increments ON LEASE, not on failure: a worker that dies
      // without reporting still consumes one, or a cell that crashes the
      // worker is retried forever.
      expect(leased?.cell.attempts).toBe(1);

      const r = await run(t, 'w-run-lease');
      expect(r.state).toBe('running');
      expect(r.started_at).not.toBeNull();
      // The heartbeat starts the moment a worker touches the run. Until then
      // it is NULL, and the reaper leaves a run with no heartbeat alone.
      expect(r.heartbeat_at).not.toBeNull();
      expect((await finding(t, 'w-r-lease', 'w-d-lease', 'c1')).status).toBe('running');
      expect(await events(t, 'w-run-lease')).toEqual(['finding.running']);
      await assertStatesAgree(t);
    });
  });

  it('claims nothing when there is nothing to claim', async () => {
    await withPg(async t => {
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      expect(await leaseCell(deps.db, deps, 'w#1')).toBeNull();
    });
  });

  it('does not claim a cell whose run has been asked to stop', async () => {
    await withPg(async t => {
      await seedOneCell(t, 'cancelled');
      await t.query(
        "update run set cancel_requested_at = now(), state = 'cancelling' where id = $1",
        ['w-run-cancelled']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      expect(await leaseCell(deps.db, deps, 'w#1')).toBeNull();
    });
  });

  it('does not claim a cell that has spent every attempt', async () => {
    await withPg(async t => {
      await seedOneCell(t, 'spent');
      await t.query('update run_cell set attempts = 3 where run_id = $1', ['w-run-spent']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      expect(await leaseCell(deps.db, deps, 'w#1')).toBeNull();
    });
  });
});

describe('the two concurrency tiers (P26)', () => {
  it('holds a run to its own snapshotted concurrency', async () => {
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-conc');
      await aDocument(t, 'w-d-conc', 'w-m-conc');
      await aReview(t, 'w-r-conc', 'w-m-conc',
        { kind: 'documents', documentIds: ['w-d-conc'] },
        Array.from({ length: 40 }, (_, i) => `c${i + 1}`));
      await aModelChoice(t);
      await aRun(t, 'w-run-conc', 'w-r-conc',
        Array.from({ length: 40 }, (_, i) => ({ key: 'w-d-conc', clause: `c${i + 1}` })),
        userId, 3);

      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      for (let i = 0; i < 3; i++) expect(await leaseCell(deps.db, deps, `w#${i}`)).not.toBeNull();
      // The fourth is refused: the run's own bound, read at LEASE time.
      expect(await leaseCell(deps.db, deps, 'w#4')).toBeNull();
    });
  });

  it('a forty-cell run and a three-cell retry: the retry gets a slot', async () => {
    // §9's own sentence, as a test. The per-run bound is what makes the
    // workspace ceiling shareable: without it the forty-cell run would take
    // every slot and the retry would wait for it to finish.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-share');
      await aDocument(t, 'w-d-big', 'w-m-share');
      await aDocument(t, 'w-d-small', 'w-m-share');
      await aReview(t, 'w-r-big', 'w-m-share',
        { kind: 'documents', documentIds: ['w-d-big'] },
        Array.from({ length: 40 }, (_, i) => `c${i + 1}`));
      await aReview(t, 'w-r-small', 'w-m-share',
        { kind: 'documents', documentIds: ['w-d-small'] }, ['c1', 'c2', 'c3']);
      await aModelChoice(t);
      await aRun(t, 'w-run-big', 'w-r-big',
        Array.from({ length: 40 }, (_, i) => ({ key: 'w-d-big', clause: `c${i + 1}` })),
        userId, 3);
      await aRun(t, 'w-run-small', 'w-r-small',
        [1, 2, 3].map(i => ({ key: 'w-d-small', clause: `c${i}` })), userId, 3);

      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      const leased: string[] = [];
      for (let i = 0; i < 6; i++) {
        const cellLeased = await leaseCell(deps.db, deps, `w#${i}`);
        if (cellLeased) leased.push(cellLeased.cell.run_id);
      }
      expect(leased.filter(id => id === 'w-run-big')).toHaveLength(3);
      expect(leased.filter(id => id === 'w-run-small')).toHaveLength(3);
    });
  });

  it('holds the whole workspace to API_WORKSPACE_RUN_CONCURRENCY', async () => {
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-ws');
      await aDocument(t, 'w-d-ws', 'w-m-ws');
      await aReview(t, 'w-r-ws', 'w-m-ws',
        { kind: 'documents', documentIds: ['w-d-ws'] },
        Array.from({ length: 10 }, (_, i) => `c${i + 1}`));
      await aModelChoice(t);
      await aRun(t, 'w-run-ws', 'w-r-ws',
        Array.from({ length: 10 }, (_, i) => ({ key: 'w-d-ws', clause: `c${i + 1}` })),
        userId, 32);

      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway, { workspaceRunConcurrency: 2 });
      expect(await leaseCell(deps.db, deps, 'w#1')).not.toBeNull();
      expect(await leaseCell(deps.db, deps, 'w#2')).not.toBeNull();
      expect(await leaseCell(deps.db, deps, 'w#3')).toBeNull();
    });
  });
});

describe('one cell, end to end', () => {
  it('writes the model s answer, closes the cell and settles the run', async () => {
    await withPg(async t => {
      await seedOneCell(t, 'e2e');
      const { gateway, log } = fakeGateway();
      const deps = workerDeps(t, gateway);

      expect(await runOneStep(deps, 'w#1', [MODEL])).toBe(true);

      const f = await finding(t, 'w-r-e2e', 'w-d-e2e', 'c1');
      expect(f.status, f.error ?? '').toBe('done');
      expect(f.summary).toBe('The break notice period is six months.');
      expect(f.risk_level).toBe('Medium');
      // The citation was REPAIRED against the document's own text and
      // carries the page derived from its `[Page N]` marker — the one place
      // a page number is produced.
      expect(f.citations).toEqual([
        { quote: 'six months', documentId: 'w-d-e2e', page: 1 },
      ]);

      expect((await cell(t, 'w-run-e2e', 'c1')).state).toBe('done');
      const r = await run(t, 'w-run-e2e');
      expect(r.state).toBe('succeeded');
      expect(r.finished_at).not.toBeNull();
      expect(await events(t, 'w-run-e2e'))
        .toEqual(['finding.running', 'finding.done', 'run.finished']);

      // The call carried the PERSON who asked for the run, not a service
      // identity — the gateway's log is what answers "on whose behalf has
      // privileged text been processed".
      expect(log.infer).toHaveLength(1);
      expect(log.infer[0]).toMatchObject({
        purpose: 'review.clause',
        workspaceId: WS,
        modelChoiceId: 'test-model',
      });
      expect(typeof log.infer[0].actorUserId).toBe('string');
      expect(log.infer[0].actorUserId).not.toBe('');
      await assertStatesAgree(t);
    });
  });

  it('writes provider and jurisdiction from WHAT THE GATEWAY SAID, once', async () => {
    // §6.5, S26. A firm that changes its allowlist must not silently rewrite
    // where a review it ran last March was processed.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-prov');
      await aDocument(t, 'w-d-prov', 'w-m-prov');
      await aReview(t, 'w-r-prov', 'w-m-prov',
        { kind: 'documents', documentIds: ['w-d-prov'] }, ['c1', 'c2']);
      await aModelChoice(t);
      await aRun(t, 'w-run-prov', 'w-r-prov',
        [{ key: 'w-d-prov', clause: 'c1' }, { key: 'w-d-prov', clause: 'c2' }], userId);

      const UK = { bloc: 'UK' as const, region: 'uksouth', label: 'UK South' };
      const US = { bloc: 'US' as const, region: 'eastus', label: 'East US' };
      const first = fakeGateway({ provider: 'anthropic', jurisdiction: UK });
      await runOneStep(workerDeps(t, first.gateway), 'w#1', [MODEL]);
      expect(await run(t, 'w-run-prov')).toMatchObject({
        provider: 'anthropic', model: 'test-model',
      });
      // The WHOLE jurisdiction, region and all — a firm must not be able to
      // believe it is UK-only while privileged text is processed in a US
      // region, and the bloc alone cannot answer that.
      expect((await run(t, 'w-run-prov')).jurisdiction).toEqual(UK);

      // The configuration has since changed and the second cell is answered
      // by a different provider. The run keeps what it was told FIRST.
      const second = fakeGateway({ provider: 'openai', jurisdiction: US });
      await runOneStep(workerDeps(t, second.gateway), 'w#1', [MODEL]);
      expect(await run(t, 'w-run-prov')).toMatchObject({ provider: 'anthropic' });
      expect((await run(t, 'w-run-prov')).jurisdiction).toEqual(UK);
      await assertStatesAgree(t);
    });
  });

  it('turns a model failure into an error FINDING and keeps the run going', async () => {
    // `extractClause` returns one Finding and never rejects. A worker that
    // let an extractor's failure kill a run would turn one bad cell into a
    // lost review.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-err');
      await aDocument(t, 'w-d-err', 'w-m-err');
      await aReview(t, 'w-r-err', 'w-m-err',
        { kind: 'documents', documentIds: ['w-d-err'] }, ['c1', 'c2']);
      await aModelChoice(t);
      await aRun(t, 'w-run-err', 'w-r-err',
        [{ key: 'w-d-err', clause: 'c1' }, { key: 'w-d-err', clause: 'c2' }], userId);

      // 400, not 502: a 502 is retryable and is now PARKED rather than
      // recorded (see the rate-limit cases above). This case is about a
      // failure that is final, which is the one a card has to show.
      const failing = fakeGateway({ status: 400 });
      await runOneStep(workerDeps(t, failing.gateway), 'w#1', [MODEL]);
      const bad = await finding(t, 'w-r-err', 'w-d-err', 'c1');
      expect(bad.status).toBe('error');
      expect(bad.error).toBeTruthy();
      expect((await cell(t, 'w-run-err', 'c1')).state).toBe('error');
      // The run is still live: one bad cell is one bad cell.
      expect((await run(t, 'w-run-err')).state).toBe('running');

      const ok = fakeGateway();
      await runOneStep(workerDeps(t, ok.gateway), 'w#1', [MODEL]);
      expect((await finding(t, 'w-r-err', 'w-d-err', 'c2')).status).toBe('done');
      // …and the run SUCCEEDS with one error in it. `succeeded` means every
      // cell reached a terminal state, not that every cell found something:
      // a cell in `error` is a finding a person can retry.
      expect((await run(t, 'w-run-err')).state).toBe('succeeded');
      expect(await events(t, 'w-run-err')).toContain('finding.error');
      await assertStatesAgree(t);
    });
  });

  it('PARKS a rate-limited cell instead of failing it, and finishes it after the wait', async () => {
    // FOUND BY RUNNING IT. A 200-cell review against the real stack met the
    // gateway's own rate limiter: 140 cells answered 429, and every one
    // became a permanent error finding for a condition that cleared inside a
    // minute. 429 and 5xx are the two failures a retry genuinely fixes, and
    // the browser's client has always retried them.
    await withPg(async t => {
      await seedOneCell(t, 'ratelimited');
      const limited = fakeGateway({ status: 429 });
      await runOneStep(workerDeps(t, limited.gateway), 'w#1', [MODEL]);

      const parked = await cell(t, 'w-run-ratelimited', 'c1');
      // Still `leased`, with NO holder and a lease in the future — which is
      // exactly the shape the claim query already understands as "not yet".
      expect(parked.state).toBe('leased');
      expect(parked.leased_by).toBeNull();
      expect(parked.attempts).toBe(1);
      expect(parked.last_error).toMatch(/attempt 1 of 3/);

      // The FINDING is still `running`, not `error`: something is still going
      // to answer this clause, and a red card that a later attempt would
      // overwrite is a wrong answer shown for thirty seconds.
      const f = await finding(t, 'w-r-ratelimited', 'w-d-ratelimited', 'c1');
      expect(f.status).toBe('running');
      expect(f.error).toBeNull();
      // No terminal event was appended.
      expect(await events(t, 'w-run-ratelimited')).toEqual(['finding.running']);
      // The run is NOT finished: a parked cell is live work.
      expect((await run(t, 'w-run-ratelimited')).state).toBe('running');

      // Nothing may claim it until the wait is over…
      const deps = workerDeps(t, limited.gateway);
      expect(await leaseCell(deps.db, deps, 'w#2')).toBeNull();
      // …and when it is, the next attempt succeeds and the run finishes.
      await t.query("update run_cell set lease_expires_at = now() - interval '1 second' "
        + 'where run_id = $1', ['w-run-ratelimited']);
      const ok = fakeGateway();
      await runOneStep(workerDeps(t, ok.gateway), 'w#2', [MODEL]);
      expect((await finding(t, 'w-r-ratelimited', 'w-d-ratelimited', 'c1')).status).toBe('done');
      expect((await run(t, 'w-run-ratelimited')).state).toBe('succeeded');
      await assertStatesAgree(t);
    });
  });

  it('gives up on a rate-limited cell once its attempts are spent, and says so', async () => {
    // The bound still holds. §9: a cell that exhausts its attempts becomes an
    // error carrying its last error text — a finding a person can retry by
    // hand, never a cell that quietly never finishes.
    await withPg(async t => {
      await seedOneCell(t, 'giveup');
      await t.query('update run_cell set attempts = 2 where run_id = $1', ['w-run-giveup']);
      const limited = fakeGateway({ status: 429 });
      await runOneStep(workerDeps(t, limited.gateway), 'w#1', [MODEL]);

      const spent = await cell(t, 'w-run-giveup', 'c1');
      expect(spent.state).toBe('error');
      expect(spent.attempts).toBe(3);
      const f = await finding(t, 'w-r-giveup', 'w-d-giveup', 'c1');
      expect(f.status).toBe('error');
      expect(f.error).toBeTruthy();
      expect((await run(t, 'w-run-giveup')).state).toBe('succeeded');
      await assertStatesAgree(t);
    });
  });

  it('does NOT park a failure a retry cannot fix', async () => {
    // A 400 or a 401 is not the gateway being busy. Parking one would spend
    // three attempts and thirty seconds each on a request that will never
    // succeed, and delay the error the reader has to act on.
    await withPg(async t => {
      await seedOneCell(t, 'permanent');
      const refused = fakeGateway({ status: 400 });
      await runOneStep(workerDeps(t, refused.gateway), 'w#1', [MODEL]);
      expect((await cell(t, 'w-run-permanent', 'c1')).state).toBe('error');
      expect((await finding(t, 'w-r-permanent', 'w-d-permanent', 'c1')).status).toBe('error');
      await assertStatesAgree(t);
    });
  });

  it('refuses a cell whose model is not on the allowlist rather than guessing', async () => {
    // `extractClause` treats an unknown capability as "cannot", which is the
    // right default for a browser whose list has not loaded and the wrong
    // one here: every scan would report "the model doesn't support image
    // input" whatever model was chosen.
    await withPg(async t => {
      await seedOneCell(t, 'unknownmodel');
      const { gateway } = fakeGateway({ models: [] });
      await runOneStep(workerDeps(t, gateway), 'w#1', []);
      const f = await finding(t, 'w-r-unknownmodel', 'w-d-unknownmodel', 'c1');
      expect(f.status).toBe('error');
      expect(f.error).toMatch(/not on the gateway's allowlist/);
      await assertStatesAgree(t);
    });
  });

  it('resolves capabilities from the allowlist rather than defaulting them', () => {
    const settings = { modelChoiceId: 'test-model', concurrency: 5 };
    expect(withCapabilities(settings, [MODEL])).toMatchObject({
      modelSupportsImages: true,
      modelSupportsStructuredOutput: true,
      modelContextLength: 128_000,
    });
    expect(() => withCapabilities({ modelChoiceId: 'gone', concurrency: 5 }, [MODEL]))
      .toThrow(/allowlist/);
  });

  it('abandons quietly when the lease has been taken by another worker', async () => {
    // The write path re-reads the lease. A write onto a cell this process no
    // longer owns is the second writer this whole design exists to prevent.
    await withPg(async t => {
      await seedOneCell(t, 'stolen');
      const { gateway } = fakeGateway({
        content: () => {
          // Between the lease and the write, another worker takes it.
          return JSON.stringify({
            summary: 'stale', citations: [], risk_level: 'Low', risk_analysis: 'x',
          });
        },
      });
      const deps = workerDeps(t, gateway);
      const leased = await leaseCell(deps.db, deps, 'w#1');
      expect(leased).not.toBeNull();
      await t.query(
        "update run_cell set leased_by = 'someone-else' where run_id = $1", ['w-run-stolen']);

      const { writeCellResult } = await import('../src/run/worker.ts');
      const result = await writeCellResult(deps, leased!, {
        finding: { clauseId: 'c1', status: 'done', summary: 'stale', citations: [] } as never,
        envelope: null,
        modelChoiceId: 'test-model',
      }, 'w#1');
      expect(result).toBe('abandoned');
      // NOTHING was written: the finding is still whatever the other worker
      // will leave on it.
      expect((await finding(t, 'w-r-stolen', 'w-d-stolen', 'c1')).summary).toBeNull();
      await assertStatesAgree(t);
    });
  });
});

describe('the collection path is a different function, and never a fallback', () => {
  it('synthesises across the ordered members, keyed by the COLLECTION', async () => {
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-col');
      await aDocument(t, 'w-d-base', 'w-m-col',
        '[Page 1]\nThe term is ten years from 1 January 2020.\n\n');
      await aDocument(t, 'w-d-var', 'w-m-col',
        '[Page 1]\nThe term is extended to fifteen years.\n\n');
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('w-col', $1, 'w-m-col', 'Lease and DoV', 'w-d-base', '["w-d-var"]'::jsonb, now())`,
        [WS]);
      await aReview(t, 'w-r-col', 'w-m-col',
        { kind: 'collection', collectionId: 'w-col', documentIds: ['w-d-base', 'w-d-var'] },
        ['c1']);
      await aModelChoice(t);
      await aRun(t, 'w-run-col', 'w-r-col', [{ key: 'w-col', clause: 'c1' }], userId);

      const { gateway, log } = fakeGateway({
        content: () => JSON.stringify({
          trail: [
            { document: 1, effect: 'Sets a ten-year term.',
              citations: [{ quote: 'ten years', document: 1 }] },
            { document: 2, effect: 'Extends it to fifteen.',
              citations: [{ quote: 'fifteen years', document: 2 }] },
          ],
          net_position: 'The term is fifteen years from 1 January 2020.',
        }),
      });
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);

      // The COLLECTION extractor was called, not the document one.
      expect(log.infer[0]).toMatchObject({ purpose: 'review.collection_clause' });
      const rows = await t.query<{ findings_key: string; status: string; net_position: unknown }>(
        'select findings_key, status, net_position from finding where review_id = $1',
        ['w-r-col']);
      expect(rows).toHaveLength(1);
      expect(rows[0].findings_key).toBe('w-col');
      expect(rows[0].status).toBe('done');
      // A NET POSITION starts UNCONFIRMED, exactly as a finding starts
      // unchecked: it is synthesised text no document contains.
      expect(rows[0].net_position).toMatchObject({ state: 'unconfirmed' });
      await assertStatesAgree(t);
    });
  });

  it('errors the cell rather than falling back when the collection record is gone', async () => {
    // `handleRetryCell`'s rule: falling back to `extractClause` would
    // replace a synthesis with a one-document answer, on screen
    // indistinguishable from a correct re-run.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-nocol');
      await aDocument(t, 'w-d-nocol', 'w-m-nocol');
      await aReview(t, 'w-r-nocol', 'w-m-nocol',
        { kind: 'collection', collectionId: 'w-gone', documentIds: ['w-d-nocol'] }, ['c1']);
      await aModelChoice(t);
      await aRun(t, 'w-run-nocol', 'w-r-nocol', [{ key: 'w-gone', clause: 'c1' }], userId);

      const { gateway, log } = fakeGateway();
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);
      const f = await finding(t, 'w-r-nocol', 'w-gone', 'c1');
      expect(f.status).toBe('error');
      expect(f.error).toMatch(/no longer exists/);
      // …and NO model call was made. A fallback would have produced a
      // confident answer here.
      expect(log.infer).toHaveLength(0);
      await assertStatesAgree(t);
    });
  });
});

describe('the worker cannot touch a human s judgement', () => {
  it('leaves a disposition untouched across a whole cell, and holds no grant to change that', async () => {
    // The BEHAVIOURAL half. It passes with or without the grant — which is
    // exactly why `workerGrants.pg.test.ts` asks the database instead, and
    // why `caps.test.ts` reads the migration. All three together are the
    // claim; this one alone would be the test that cannot fail.
    await withPg(async t => {
      const { userId } = await seedOneCell(t, 'disp');
      await t.query(
        `insert into finding_disposition (review_id, findings_key, clause_id, workspace_id,
                                          state, by_user_id, at, changed_count)
         values ($1, $2, 'c1', $3, 'verified', $4, now(), 1)`,
        ['w-r-disp', 'w-d-disp', WS, userId]);

      const { gateway } = fakeGateway();
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);

      const rows = await t.query<{ state: string; changed_count: number; version: string }>(
        'select state, changed_count, version from finding_disposition where review_id = $1',
        ['w-r-disp']);
      expect(rows[0]).toMatchObject({ state: 'verified', changed_count: 1 });
      expect(Number(rows[0].version)).toBe(1);
      // …and the finding itself DID move, so the assertion above is not
      // passing over a worker that did nothing at all.
      expect((await finding(t, 'w-r-disp', 'w-d-disp', 'c1')).status).toBe('done');
      await assertStatesAgree(t);
    });
  });
});

describe('a process reclaims the leases it left behind, and nobody else s', () => {
  it('expires its OWN orphaned lease at startup and leaves another host s alone', async () => {
    // Without this, "a run survives a worker restart and completes" is true
    // and takes ten minutes — `API_RUN_LEASE_MS` is long because a single
    // clause against a slow model may legitimately take that long. Ten
    // minutes of no progress reads to anybody watching as a run that is
    // stuck, which is the one state the heartbeat exists to rule out.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'w-m-orphan');
      await aDocument(t, 'w-d-orphan', 'w-m-orphan');
      await aReview(t, 'w-r-orphan', 'w-m-orphan',
        { kind: 'documents', documentIds: ['w-d-orphan'] }, ['c1', 'c2']);
      await aModelChoice(t);
      await aRun(t, 'w-run-orphan', 'w-r-orphan',
        [{ key: 'w-d-orphan', clause: 'c1' }, { key: 'w-d-orphan', clause: 'c2' }], userId);

      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      // `workerDeps` stamps `test-worker`; the claim adds a slot suffix.
      await leaseCell(deps.db, deps, `${deps.workerId}#1`);
      // …and a cell held by a DIFFERENT host, which may still be running.
      await t.query(
        `update run_cell set state = 'leased', leased_by = 'api-other-host#1',
                             lease_expires_at = now() + interval '10 minutes'
          where run_id = 'w-run-orphan' and clause_id = 'c2'`);

      expect(await releaseOwnOrphanedLeases(deps)).toBe(1);

      const rows = await t.query<{ clause_id: string; leased_by: string | null; live: boolean }>(
        `select clause_id, leased_by, lease_expires_at > now() as live
           from run_cell where run_id = 'w-run-orphan' order by clause_id`);
      // Mine: released, and immediately claimable again.
      expect(rows[0]).toMatchObject({ clause_id: 'c1', leased_by: null, live: false });
      // Theirs: untouched. Stealing it would put two writers on one finding.
      expect(rows[1]).toMatchObject({ clause_id: 'c2', leased_by: 'api-other-host#1', live: true });

      expect((await leaseCell(deps.db, deps, `${deps.workerId}#1`))?.cell.clause_id).toBe('c1');
    });
  });
});

/**
 * n2: an idle worker does not talk to the gateway.
 *
 * `allowlistOf(deps.gateway)` ran BEFORE `runOneStep`, inside
 * `while (running)`. With `runPollMs = 1000` and `runWorkers = 2` an idle
 * process issued two `GET /v1/models` per second, forever, against the very
 * gateway whose rate limiter this stage documents as the binding constraint
 * — and during an outage it also wrote two stderr lines a second,
 * indefinitely. The allowlist is only needed once there is a cell to run.
 */
describe('the gateway is asked for its allowlist only when there is work', () => {
  it('does not fetch the allowlist when there is nothing to claim', async () => {
    await withPg(async t => {
      const { gateway, log } = fakeGateway();
      // No run, no cells: `leaseCell` returns null.
      expect(await runOneStep(workerDeps(t, gateway), 'w#1', () => allowlistOf(gateway)))
        .toBe(false);
      expect(log.models).toBe(0);
    });
  });

  it('fetches it once a cell IS claimed, so the model is still checked before the call', async () => {
    await withPg(async t => {
      await seedOneCell(t, 'allow');
      const { gateway, log } = fakeGateway();
      expect(await runOneStep(workerDeps(t, gateway), 'w#1', () => allowlistOf(gateway)))
        .toBe(true);
      expect(log.models).toBe(1);
      expect(log.infer).toHaveLength(1);
    });
  });
});
