import { describe, it, expect } from 'vitest';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { RunView } from '@lexprompt/core';

/**
 * Task 8: a run is a row and a queue of cells, CREATED AND RETURNED WITHOUT
 * EXECUTING.
 *
 * What this suite has to prove is not "a row was written" — it is that the
 * cells are the right cells, keyed the one way a findings key is ever
 * derived, and that the two refusals fire. A queue that creates the wrong
 * cells produces a review that is confidently incomplete, which is the shape
 * every defect on `CLAUDE.md`'s list has.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-runqueue',
  groups: ['reviewers'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

async function aMatter(t: Tx, id = 'rq-m1'): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now())`, [id, WS]);
}

async function aDocument(
  t: Tx, id: string, parseState: 'pending' | 'parsed' | 'failed' = 'parsed',
  matterId = 'rq-m1',
): Promise<void> {
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', $3, $4, 'pdf', '[Page 1]\nx\n\n', $5, 4, 'application/pdf', $6,
             'standalone', now())`,
    [id, WS, matterId, `${id}.pdf`, parseState, `workspace/${WS}/document/${id}`]);
}

const SNAPSHOT = (clauses: string[]) => ({
  id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'Lease',
  systemPrompt: 's', formatPrompt: 'f', changeSummary: '', publishedAt: 1,
  publishedByUserId: 'u1', schemaVersion: 7,
  clauses: clauses.map(id => ({ id, title: id, extractPrompt: `What about ${id}?` })),
});

async function aReview(
  t: Tx, id: string, target: unknown, clauses: string[], matterId = 'rq-m1',
): Promise<void> {
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids, target,
                         findings, model_id, started_at)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb, 'test/model', now())`,
    [id, WS, matterId, JSON.stringify(SNAPSHOT(clauses)),
      JSON.stringify((target as { documentIds?: string[] }).documentIds ?? []),
      JSON.stringify(target)]);
}

function harness(t: Tx, actorId: string) {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    raw: inject,
    async post(url: string): Promise<RunView> {
      const res = await inject('POST', url);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as RunView;
    },
    async get(url: string): Promise<RunView> {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as RunView;
    },
  };
}

async function cellsOf(t: Tx, runId: string): Promise<{ key: string; clause: string }[]> {
  const rows = await t.query<{ findings_key: string; clause_id: string }>(
    'select findings_key, clause_id from run_cell where run_id = $1 order by findings_key, clause_id',
    [runId]);
  return rows.map(r => ({ key: r.findings_key, clause: r.clause_id }));
}

describe('creating a run', () => {
  it('makes one cell per document x clause, keyed by document', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aDocument(t, 'rq-d2');
      await aReview(t, 'rq-r1', { kind: 'documents', documentIds: ['rq-d1', 'rq-d2'] },
        ['c1', 'c2', 'c3']);
      const h = harness(t, await aUser(t));

      const run = await h.post('/v1/reviews/rq-r1/runs');
      expect(run.state).toBe('queued');
      expect(run.cells).toEqual({
        total: 6, queued: 6, leased: 0, done: 0, error: 0, cancelled: 0,
      });
      expect(await cellsOf(t, run.id)).toEqual([
        { key: 'rq-d1', clause: 'c1' }, { key: 'rq-d1', clause: 'c2' },
        { key: 'rq-d1', clause: 'c3' },
        { key: 'rq-d2', clause: 'c1' }, { key: 'rq-d2', clause: 'c2' },
        { key: 'rq-d2', clause: 'c3' },
      ]);
    });
  });

  it('makes ONE cell per clause for a collection, keyed by the COLLECTION', async () => {
    // R-C1, and the six defects that came from keying by document id
    // directly. A collection review produces one position per clause however
    // many documents feed it; a cell per document would produce three
    // one-document answers where the review promises a synthesis.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-b1');
      await aDocument(t, 'rq-v1');
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('rq-col', $1, 'rq-m1', 'Lease and DoV', 'rq-b1', '["rq-v1"]'::jsonb, now())`,
        [WS]);
      await aReview(t, 'rq-r2',
        { kind: 'collection', collectionId: 'rq-col', documentIds: ['rq-b1', 'rq-v1'] },
        ['c1', 'c2']);
      const h = harness(t, await aUser(t));

      const run = await h.post('/v1/reviews/rq-r2/runs');
      expect(run.cells.total).toBe(2);
      expect(await cellsOf(t, run.id)).toEqual([
        { key: 'rq-col', clause: 'c1' }, { key: 'rq-col', clause: 'c2' },
      ]);
    });
  });

  it('seeds a pending finding per cell, so the reader has something to render', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r3', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1', 'c2']);
      const h = harness(t, await aUser(t));
      await h.post('/v1/reviews/rq-r3/runs');

      const findings = await t.query<{ findings_key: string; clause_id: string; status: string }>(
        'select findings_key, clause_id, status from finding where review_id = $1 '
        + 'order by clause_id', ['rq-r3']);
      expect(findings.map(f => [f.findings_key, f.clause_id, f.status]))
        .toEqual([['rq-d1', 'c1', 'pending'], ['rq-d1', 'c2', 'pending']]);
    });
  });

  it('appends exactly one run.started, carrying the cell count', async () => {
    // The count travels with the event because a partial run must never read
    // as a complete one: "12 of 40" is a fact a reader is entitled to, and a
    // state alone cannot carry it.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r4', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1', 'c2', 'c3']);
      const h = harness(t, await aUser(t));
      const run = await h.post('/v1/reviews/rq-r4/runs');

      const events = await t.query<{ type: string; payload: Record<string, unknown> }>(
        'select type, payload from event where run_id = $1 order by id', [run.id]);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run.started');
      expect(events[0].payload).toMatchObject({
        runId: run.id, reviewId: 'rq-r4', cells: 3, version: 1,
      });
    });
  });

  it('snapshots concurrency from workspace_setting, and does not track it afterwards', async () => {
    // P26. The reason it is a snapshot is the reason `playbook_snapshot` is:
    // an admin who lowers the firm's concurrency at noon must not
    // retroactively change the bound a run started at eleven executed under.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r5', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      await t.query(
        `insert into workspace_setting (workspace_id, concurrency) values ($1, 7)
         on conflict (workspace_id) do update set concurrency = 7`, [WS]);
      const h = harness(t, await aUser(t));
      const run = await h.post('/v1/reviews/rq-r5/runs');
      expect(run.concurrency).toBe(7);

      await t.query('update workspace_setting set concurrency = 2 where workspace_id = $1', [WS]);
      expect((await h.get(`/v1/runs/${run.id}`)).concurrency).toBe(7);
    });
  });

  it('takes the workspace s highest permitted concurrency without clamping it away', async () => {
    // `workspace_setting.concurrency` is bounded 1..20 by 001 and `run
    // .concurrency` 1..32 by 008, so every value an admin can set passes
    // through unchanged. The clamp in `snapshotConcurrency` is the belt
    // against the two bounds drifting apart later — it must not be biting
    // today, or an admin's 20 would silently become something else.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r6', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      await t.query(
        `insert into workspace_setting (workspace_id, concurrency) values ($1, 20)
         on conflict (workspace_id) do update set concurrency = 20`, [WS]);
      const h = harness(t, await aUser(t));
      expect((await h.post('/v1/reviews/rq-r6/runs')).concurrency).toBe(20);
    });
  });

  it('answers 404 for a review in another workspace, not an empty run', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('POST', '/v1/reviews/nope/runs');
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('the two refusals, both 409', () => {
  it('refuses a second run over a review that is already running', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r7', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      const h = harness(t, await aUser(t));
      await h.post('/v1/reviews/rq-r7/runs');

      const res = await h.raw('POST', '/v1/reviews/rq-r7/runs');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/already running/);
    });
  });

  it('lets a new run start once the last one has finished', async () => {
    // The refusal is about a LIVE run, not about the review ever having run.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r8', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      const h = harness(t, await aUser(t));
      const first = await h.post('/v1/reviews/rq-r8/runs');
      await t.query("update run set state = 'succeeded', finished_at = now() where id = $1",
        [first.id]);
      const second = await h.post('/v1/reviews/rq-r8/runs');
      expect(second.id).not.toBe(first.id);
    });
  });

  it('the database refuses a second live run even when the route s SELECT cannot see it', async () => {
    // The unique partial index in 008. The route's own check cannot close a
    // race between two requests arriving in the same millisecond; this is
    // what does. MUTATION: drop `run_one_live_per_review` and this fails.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r9', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      const userId = await aUser(t);
      const h = harness(t, userId);
      await h.post('/v1/reviews/rq-r9/runs');

      await expect(t.query(
        `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
         values ('rq-sneak', 'rq-r9', $1, 'queued', $2, 5)`, [WS, userId],
      )).rejects.toThrow(/run_one_live_per_review/);
    });
  });

  it('refuses a run over a document that has not finished being read, BY NAME', async () => {
    // §11's third load state, enforced rather than rendered around. A review
    // of a document with no text answers "the agreement is silent on this
    // point" for every clause — fluently, with nothing on the card to say
    // the text never arrived.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aDocument(t, 'rq-slow', 'pending');
      await aReview(t, 'rq-r10', { kind: 'documents', documentIds: ['rq-d1', 'rq-slow'] }, ['c1']);
      const h = harness(t, await aUser(t));

      const res = await h.raw('POST', '/v1/reviews/rq-r10/runs');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('rq-slow.pdf');
      expect(res.json().error.message).toMatch(/has not finished being read/);
      // NOTHING was started. A refusal that left half a queue behind would
      // be worse than the run it refused.
      expect(await t.query('select id from run where review_id = $1', ['rq-r10'])).toEqual([]);
    });
  });

  it('refuses a run over a document whose parse FAILED, with a different sentence', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-bad', 'failed');
      await aReview(t, 'rq-r11', { kind: 'documents', documentIds: ['rq-bad'] }, ['c1']);
      const h = harness(t, await aUser(t));

      const res = await h.raw('POST', '/v1/reviews/rq-r11/runs');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('rq-bad.pdf');
      expect(res.json().error.message).toMatch(/could not be read/);
      // The two states are DIFFERENT facts and must not share a sentence:
      // "wait a moment" and "this file is broken" send a person to two
      // different places.
      expect(res.json().error.message).not.toMatch(/has not finished being read/);
    });
  });

  it('refuses a review whose snapshot names no clause rather than queueing nothing', async () => {
    // A run with no cell would sit `queued` forever with nothing for a
    // worker to lease and no reason on screen.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r12', { kind: 'documents', documentIds: ['rq-d1'] }, []);
      const h = harness(t, await aUser(t));
      const res = await h.raw('POST', '/v1/reviews/rq-r12/runs');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/nothing to run/);
    });
  });
});

describe('reading a run back', () => {
  it('reports the cell breakdown, so a partial run cannot read as a complete one', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r13', { kind: 'documents', documentIds: ['rq-d1'] },
        ['c1', 'c2', 'c3', 'c4']);
      const h = harness(t, await aUser(t));
      const run = await h.post('/v1/reviews/rq-r13/runs');

      await t.query(
        "update run_cell set state = 'done' where run_id = $1 and clause_id in ('c1','c2')",
        [run.id]);
      await t.query(
        "update run_cell set state = 'error' where run_id = $1 and clause_id = 'c3'", [run.id]);

      const read = await h.get(`/v1/runs/${run.id}`);
      expect(read.cells).toEqual({
        total: 4, queued: 1, leased: 0, done: 2, error: 1, cancelled: 0,
      });
    });
  });

  it('leaves provider, model and jurisdiction ABSENT until the gateway has answered', async () => {
    // §6.5, and the absence is the claim: a queued run has not called
    // anything, so there is nothing true to put there. `provider: null` on
    // the wire would read as "processed nowhere".
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'rq-d1');
      await aReview(t, 'rq-r14', { kind: 'documents', documentIds: ['rq-d1'] }, ['c1']);
      const h = harness(t, await aUser(t));
      const run = await h.post('/v1/reviews/rq-r14/runs');
      expect('provider' in run).toBe(false);
      expect('model' in run).toBe(false);
      expect('jurisdiction' in run).toBe(false);
      expect('finishedAt' in run).toBe(false);
      expect('heartbeatAt' in run).toBe(false);
    });
  });

  it('answers 404 for a run in another workspace', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const res = await h.raw('GET', '/v1/runs/not-a-run');
      expect(res.statusCode).toBe(404);
    });
  });
});
