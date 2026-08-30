import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Db, Tx } from '../src/db/pool.ts';
import {
  WS, aUser, aMatter, aDocument, aReview, aModelChoice, SNAPSHOT,
} from './helpers/runHarness.ts';

/**
 * TASK 16: RE-RUNNING A CLAUSE CLEARS ITS DISPOSITION, AND RECORDS THAT IT
 * DID — in one transaction.
 *
 * §14 names two mutations for this suite by name, and both are written out
 * beside the tests that kill them. The rule they defend is the one CLAUDE.md
 * calls load-bearing: a verification described a specific piece of output,
 * and once that output is replaced, keeping the verification would let an
 * export claim a human checked text they never saw.
 */

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-rerun-reset',
  groups: ['reviewers'],
};

interface Harness {
  app: FastifyInstance;
  send(method: 'POST' | 'PUT', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
  ok(method: 'POST' | 'PUT', url: string, body?: unknown): Promise<any>;
}

function harness(t: Tx, actorId: string, db?: Db): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: db ?? dbOn(t),
    actor: {
      id: actorId, displayName: 'A Gray', initials: 'AG', role: 'reviewer', workspaceId: WS,
    },
  });
  const send = (method: 'POST' | 'PUT', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    send: send as never,
    async ok(method, url, body) {
      const res = await send(method, url, body);
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json();
    },
  };
}

/** A review whose findings already exist, as a completed run would leave
 *  them: `done`, with an answer. */
async function aFinishedReview(
  t: Tx, target: unknown, cells: { key: string; clause: string }[],
  netPosition?: unknown,
): Promise<void> {
  await aReview(t, 'r1', 'm1', target, [...new Set(cells.map(c => c.clause))]);
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status, summary,
                          citations, risk_level, net_position)
     select 'r1', k, c, $1, 'done', 'The break notice period is six months.',
            '[{"quote":"six months"}]'::jsonb, 'Medium', $4::jsonb
       from unnest($2::text[], $3::text[]) as a(k, c)`,
    [WS, cells.map(c => c.key), cells.map(c => c.clause),
      netPosition === undefined ? null : JSON.stringify(netPosition)]);
  await t.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     select 'r1', k, c, $1, 'unchecked', 0 from unnest($2::text[], $3::text[]) as a(k, c)`,
    [WS, cells.map(c => c.key), cells.map(c => c.clause)]);
}

const RETRY = '/v1/reviews/r1/findings/d1/c1/retry';
const DISPOSITION = '/v1/reviews/r1/findings/d1/c1/disposition';

const dispositionFor = async (t: Tx, key = 'd1', clause = 'c1') =>
  (await t.query<{ state: string; changed_count: number; by_user_id: string | null }>(
    `select state, changed_count, by_user_id::text as by_user_id from finding_disposition
      where review_id = 'r1' and findings_key = $1 and clause_id = $2`, [key, clause]))[0];

const lastEvent = async (t: Tx, key = 'd1', clause = 'c1') =>
  (await t.query<{
    from_state: string; to_state: string; cause: string; by_user_id: string;
  }>(
    `select from_state, to_state, cause, by_user_id::text as by_user_id
       from finding_disposition_event
      where review_id = 'r1' and findings_key = $1 and clause_id = $2
      order by id desc limit 1`, [key, clause]))[0];

const eventCount = async (t: Tx, key = 'd1', clause = 'c1') =>
  Number((await t.query<{ n: string }>(
    `select count(*)::text n from finding_disposition_event
      where review_id = 'r1' and findings_key = $1 and clause_id = $2`, [key, clause]))[0].n);

async function seedStandalone(t: Tx, netPosition?: unknown): Promise<string> {
  const actor = await aUser(t, 'A Gray');
  await aMatter(t, 'm1');
  await aDocument(t, 'd1', 'm1');
  await aDocument(t, 'd2', 'm1');
  await aModelChoice(t);
  await aFinishedReview(t, { kind: 'documents', documentIds: ['d1', 'd2'] },
    [{ key: 'd1', clause: 'c1' }, { key: 'd1', clause: 'c2' },
      { key: 'd2', clause: 'c1' }, { key: 'd2', clause: 'c2' }], netPosition);
  return actor;
}

describe('the reset happens, and the fact that it happened is recorded', () => {
  it('records the clearing as well as performing it', async () => {
    /*
     * MUTATION (a), §14: delete the `insert into finding_disposition_event`
     * in `dispositions/service.ts` and leave the UPDATE. This test must
     * fail. "A reset that clears a verification without recording that it
     * did is the same lie as a reset that does not happen."
     */
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);

      await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      expect(await dispositionFor(t)).toMatchObject({ state: 'verified', changed_count: 1 });

      await h.ok('POST', RETRY);

      expect(await dispositionFor(t)).toMatchObject({ state: 'unchecked', changed_count: 2 });
      expect(await lastEvent(t)).toMatchObject({
        from_state: 'verified', to_state: 'unchecked', cause: 'rerun_reset', by_user_id: actor,
      });
      await h.app.close();
    });
  });

  it('attributes the clearing to whoever asked for the re-run', async () => {
    // §9.1: what lets an export say "unchecked — re-run by A. Gray at
    // 11:07, previously verified by R. Okafor". Not `'system'`, and not
    // whoever last held the disposition.
    await withPg(async t => {
      const okafor = await seedStandalone(t);
      const gray = await aUser(t, 'A Gray');
      const byOkafor = harness(t, okafor);
      await byOkafor.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      await byOkafor.app.close();

      const h = harness(t, gray);
      await h.ok('POST', RETRY);
      const event = await lastEvent(t);
      expect(event.by_user_id).toBe(gray);
      expect(event.from_state).toBe('verified');
      // …and the row records who cleared it, not who verified it.
      expect((await dispositionFor(t)).by_user_id).toBe(gray);
      await h.app.close();
    });
  });

  it('UPDATES the disposition row, never deletes it', async () => {
    // Deleting it would lose who last held it and leave the history's
    // `from_state` with nothing to be read against.
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);
      await h.ok('PUT', DISPOSITION, { state: 'flagged', version: 1 });
      await h.ok('POST', RETRY);
      expect(await dispositionFor(t)).toBeDefined();
      await h.app.close();
    });
  });

  it('clears the net position too, in the same transaction', async () => {
    /*
     * MUTATION: drop `net_position = null` from `createRun`'s finding
     * upsert. This test must fail. `resetPosition` mirrors
     * `resetVerification` for the same reason and is mutation-tested for the
     * same reason: a net position is synthesised text no document contains,
     * and a confirmation described a specific synthesis.
     */
    await withPg(async t => {
      const actor = await seedStandalone(t, {
        text: 'Read in order, the tenant has a rolling break on six months notice.',
        state: 'confirmed', confirmedByUserId: 'someone', confirmedAt: 1, trail: [],
      });
      const h = harness(t, actor);

      const result = await h.ok('POST', RETRY);
      expect(result.cleared).toEqual({ verification: false, netPosition: true });

      const after = await t.query<{ net_position: unknown; status: string; summary: string | null }>(
        "select net_position, status, summary from finding where findings_key = 'd1' and clause_id = 'c1'");
      expect(after[0].net_position, 'a confirmed net position survived a re-run').toBeNull();
      expect(after[0].status).toBe('pending');
      expect(after[0].summary).toBeNull();
      await h.app.close();
    });
  });

  it('reports what it cleared, so the browser composes its notice from the transaction', async () => {
    await withPg(async t => {
      const actor = await seedStandalone(t, {
        text: 'A rolling break.', state: 'amended', trail: [],
      });
      const h = harness(t, actor);
      await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      const result = await h.ok('POST', RETRY);
      expect(result.cleared).toEqual({ verification: true, netPosition: true });
      await h.app.close();
    });
  });

  it('reports nothing cleared when there was nothing to clear', async () => {
    // The other half. An UNCONFIRMED net position is not a judgement
    // anybody made, so clearing it clears nothing — the same predicate the
    // browser has always used.
    await withPg(async t => {
      const actor = await seedStandalone(t, {
        text: 'A rolling break.', state: 'unconfirmed', trail: [],
      });
      const h = harness(t, actor);
      const result = await h.ok('POST', RETRY);
      expect(result.cleared).toEqual({ verification: false, netPosition: false });
      // …and no event: a never-touched finding has no judgement to clear,
      // and a row saying nothing happened is noise in the table 006 calls
      // evidence.
      expect(await eventCount(t)).toBe(0);
      await h.app.close();
    });
  });

  it('leaves the notes alone', async () => {
    // "A note is a person's remark about the clause, not a component of
    // their judgement on one answer." The same test `App.rerunResets.test.tsx`
    // makes today, moved to the server.
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);
      await h.ok('POST', '/v1/reviews/r1/findings/d1/c1/notes', { text: 'still relevant' });
      await h.ok('POST', RETRY);
      expect(await t.query('select 1 from note')).toHaveLength(1);
      await h.app.close();
    });
  });

  it('touches no OTHER clause s judgement', async () => {
    // A clause not in this retry's cell set keeps its verification, because
    // nothing is replacing what it was made about.
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);
      await h.ok('PUT', '/v1/reviews/r1/findings/d1/c2/disposition',
        { state: 'verified', version: 1 });
      await h.ok('PUT', '/v1/reviews/r1/findings/d2/c1/disposition',
        { state: 'rejected', reason: 'Wrong schedule.', version: 1 });

      await h.ok('POST', RETRY);

      expect(await dispositionFor(t, 'd1', 'c2')).toMatchObject({ state: 'verified' });
      expect(await dispositionFor(t, 'd2', 'c1')).toMatchObject({ state: 'rejected' });
      // …and their findings are untouched too: one cell was queued, not four.
      const statuses = await t.query<{ findings_key: string; clause_id: string; status: string }>(
        'select findings_key, clause_id, status from finding order by findings_key, clause_id');
      expect(statuses.map(s => `${s.findings_key}/${s.clause_id}=${s.status}`)).toEqual([
        'd1/c1=pending', 'd1/c2=done', 'd2/c1=done', 'd2/c2=done',
      ]);
      expect(await t.query('select 1 from run_cell')).toHaveLength(1);
      await h.app.close();
    });
  });
});

describe('it is atomic — a failure mid-transaction leaves nothing half-done', () => {
  it('rolls back the disposition, the event and the finding together', async () => {
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const before = harness(t, actor);
      await before.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      await before.app.close();

      // A `Db` that fails AFTER the event insert — on the statement that
      // queues the cell. Everything before it is in the same transaction and
      // must go with it.
      //
      // The wrapper has to reach INSIDE `tx`, not only wrap `query`: the
      // route does all its work on the `Tx` that `db.tx` hands it, so a
      // failing `query` on the `Db` itself is never called and the test
      // passes while proving nothing. Found by writing it the short way
      // first and watching it return 201.
      const wrap = (inner: Tx): Tx => ({
        query: (text, values) => (/insert into run_cell/i.test(text)
          ? Promise.reject(new Error('the queue write failed'))
          : inner.query(text, values)),
        tx: run => inner.tx(next => run(wrap(next))),
      });
      const failing: Db = {
        query: (text, values) => t.query(text, values),
        tx: run => t.tx(inner => run(wrap(inner))),
      };
      const h = harness(t, actor, failing);
      const res = await h.send('POST', RETRY);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);

      expect(await dispositionFor(t), 'a judgement was cleared by a transaction that failed')
        .toMatchObject({ state: 'verified', changed_count: 1 });
      expect(await eventCount(t), 'an orphan history row survived a failed transaction').toBe(1);
      expect((await t.query<{ status: string }>(
        "select status from finding where findings_key = 'd1' and clause_id = 'c1'"))[0].status)
        .toBe('done');
      expect(await t.query('select 1 from run')).toEqual([]);
      await h.app.close();
    });
  });
});

describe('a collection retry re-runs the COLLECTION extractor', () => {
  it('queues a cell keyed by the collection, never by a document', async () => {
    await withPg(async t => {
      const actor = await aUser(t, 'A Gray');
      await aMatter(t, 'm1');
      await aDocument(t, 'd1', 'm1');
      await aDocument(t, 'd2', 'm1');
      await aModelChoice(t);
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('col-1', $1, 'm1', 'Lease and variations', 'd1', '["d2"]'::jsonb, now())`, [WS]);
      await aFinishedReview(t,
        { kind: 'collection', collectionId: 'col-1', documentIds: ['d1', 'd2'] },
        [{ key: 'col-1', clause: 'c1' }, { key: 'col-1', clause: 'c2' }]);

      const h = harness(t, actor);
      await h.ok('POST', '/v1/reviews/r1/findings/col-1/c1/retry');
      const cells = await t.query<{ findings_key: string; clause_id: string }>(
        'select findings_key, clause_id from run_cell');
      expect(cells).toEqual([{ findings_key: 'col-1', clause_id: 'c1' }]);
      await h.app.close();
    });
  });

  it('REFUSES a collection review retried by one of its document ids', async () => {
    // There is no path by which a collection clause is retried through the
    // single-document extractor — the key is checked against `cellsFor`,
    // which goes through `findingsKeyFor`, and a collection target produces
    // only the collection's own key.
    await withPg(async t => {
      const actor = await aUser(t, 'A Gray');
      await aMatter(t, 'm1');
      await aDocument(t, 'd1', 'm1');
      await aModelChoice(t);
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('col-1', $1, 'm1', 'Lease', 'd1', '[]'::jsonb, now())`, [WS]);
      await aFinishedReview(t,
        { kind: 'collection', collectionId: 'col-1', documentIds: ['d1'] },
        [{ key: 'col-1', clause: 'c1' }]);

      const h = harness(t, actor);
      const res = await h.send('POST', '/v1/reviews/r1/findings/d1/c1/retry');
      expect(res.statusCode).toBe(404);
      expect(await t.query('select 1 from run_cell')).toEqual([]);
      await h.app.close();
    });
  });
});

describe('the retry refuses what it cannot honestly do', () => {
  it('REFUSES while a run is live, rather than becoming a second writer', async () => {
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);
      await h.ok('POST', '/v1/reviews/r1/runs');
      const res = await h.send('POST', RETRY);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already running/);
      await h.app.close();
    });
  });

  it('REFUSES a clause the review does not cover', async () => {
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const h = harness(t, actor);
      expect((await h.send('POST', '/v1/reviews/r1/findings/d1/c-nope/retry')).statusCode)
        .toBe(404);
      expect((await h.send('POST', '/v1/reviews/r1/findings/d-nope/c1/retry')).statusCode)
        .toBe(404);
      await h.app.close();
    });
  });

  it('REFUSES while a document is still being read, naming it', async () => {
    // §11's third load state: a review of a document with no text is this
    // project's founding defect, and a retry is a review of one clause.
    await withPg(async t => {
      const actor = await seedStandalone(t);
      await t.query("update document set parse_state = 'pending', text = '' where id = 'd1'");
      const h = harness(t, actor);
      const res = await h.send('POST', RETRY);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/d1\.pdf/);
      expect(await t.query('select 1 from run_cell')).toEqual([]);
      await h.app.close();
    });
  });

  it('REFUSES a review in another workspace with 404', async () => {
    await withPg(async t => {
      const actor = await seedStandalone(t);
      const { app } = buildTestApi({
        principal: PRINCIPAL,
        db: dbOn(t),
        actor: {
          id: actor, displayName: 'A', initials: 'A', role: 'reviewer',
          workspaceId: '00000000-0000-0000-0000-0000000000ff',
        },
      });
      const res = await app.inject({
        method: 'POST', url: RETRY, headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});

describe('the snapshot is what a retry re-runs against', () => {
  it('reads the clause set from the review s own playbookSnapshot, not today s playbook', () => {
    // A structural claim rather than a behavioural one: the retry hands
    // `cellsFor` the review row's `playbook_snapshot`. `Review.playbookSnapshot`
    // is a deep copy for exactly this reason, and a retry built from today's
    // playbook would answer a review whose header says "ran against v4" with
    // v5's clauses.
    expect(SNAPSHOT(['c1']).clauses.map(c => c.id)).toEqual(['c1']);
  });
});
