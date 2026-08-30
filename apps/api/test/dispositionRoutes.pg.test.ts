import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn, workerDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * TASK 15: DISPOSITIONS AND NOTES — THE ONLY WRITERS ARE PEOPLE.
 *
 * The title is the rule. What this suite has to prove is not that the routes
 * store things; it is that there is NO PATH by which anything other than a
 * person's request produces a `finding_disposition` — and that the last
 * defence of that is Postgres rather than this code, which is why the final
 * describe attempts the writes as the role the engine actually runs as.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const HUMAN = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-disposition-routes',
  groups: ['reviewers'],
};

async function aUser(t: Tx, id: string, subject: string): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [id, WS, subject]);
}

async function aFinding(t: Tx, clauseId = 'c1', findingsKey = 'd1'): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('m1', $1, 'Brookvale', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ('r1', $1, 'm1', '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ('r1', $2, $3, $1, 'done') on conflict do nothing`, [WS, findingsKey, clauseId]);
  await t.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     values ('r1', $2, $3, $1, 'unchecked', 0) on conflict do nothing`,
    [WS, findingsKey, clauseId]);
}

interface Harness {
  app: FastifyInstance;
  send(method: 'PUT' | 'POST' | 'GET', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
  ok(method: 'PUT' | 'POST' | 'GET', url: string, body?: unknown): Promise<any>;
}

function harness(t: Tx, actorId = HUMAN): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'H Human', initials: 'HH', role: 'reviewer', workspaceId: WS,
    },
  });
  const send = (method: 'PUT' | 'POST' | 'GET', url: string, body?: unknown) =>
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

const DISPOSITION = '/v1/reviews/r1/findings/d1/c1/disposition';
const NOTES = '/v1/reviews/r1/findings/d1/c1/notes';
const HISTORY = '/v1/reviews/r1/findings/d1/c1/history';

describe('a disposition is a person s request, refused when stale', () => {
  it('stores it and answers with BOTH the row and the event that produced it', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);

      const result = await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      expect(result.disposition).toMatchObject({
        reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
        state: 'verified', byUserId: HUMAN, changedCount: 1, version: 2,
      });
      // §8: the event travels with the row, so `fromState` is on hand at
      // first render without a second query, and Stage 4's "was Rejected"
      // needs no new mechanism.
      expect(result.event).toMatchObject({
        fromState: 'unchecked', toState: 'verified', cause: 'human', byUserId: HUMAN,
      });
      expect(typeof result.disposition.at).toBe('number');
      await h.app.close();
    });
  });

  it('REFUSES a stale version with 409 carrying the current row, and applies nothing', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aUser(t, OTHER, 's-other');
      await aFinding(t);
      const h = harness(t);

      await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      // A second writer still holding version 1 — another tab, another
      // person. P25: this is REFUSED, never merged and never retried.
      const res = await h.send('PUT', DISPOSITION, {
        state: 'rejected', reason: 'The cap is in schedule 6.', version: 1,
      });
      expect(res.statusCode, 'a stale disposition write was APPLIED').toBe(409);
      // `current` is a top-level key on the envelope (`registerErrorEnvelope`),
      // and it is the SAME wire shape the success path answers with — not the
      // store's row. Stage 4 renders this value; one fact, one shape.
      expect(res.json().current).toMatchObject({ state: 'verified', version: 2, byUserId: HUMAN });

      const stored = await t.query<{ state: string; changed_count: number }>(
        'select state, changed_count from finding_disposition');
      expect(stored[0]).toMatchObject({ state: 'verified', changed_count: 1 });
      await h.app.close();
    });
  });

  it('REFUSES a rejection with no reason, naming the field', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('PUT', DISPOSITION, { state: 'rejected', version: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/reason/);
      expect(await t.query("select 1 from finding_disposition_event")).toEqual([]);
      await h.app.close();
    });
  });

  it('REFUSES a key naming no finding with 404, and creates no row on the fly', async () => {
    // A disposition on a finding that does not exist is a judgement about
    // nothing.
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('PUT', '/v1/reviews/r1/findings/d1/c-nope/disposition',
        { state: 'verified', version: 1 });
      expect(res.statusCode).toBe(404);
      expect(await t.query(
        "select 1 from finding_disposition where clause_id = 'c-nope'")).toEqual([]);
      expect(await t.query("select 1 from finding where clause_id = 'c-nope'")).toEqual([]);
      await h.app.close();
    });
  });

  it('REFUSES a cause in the body — a request is always a person', async () => {
    /*
     * `rerun_reset` is the one cause the database lets move a disposition
     * without a person behind it (`rerun_reset_only_unchecks`). A body field
     * that could name it would be a way for a client to write a history row
     * that lies about why a judgement moved.
     */
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('PUT', DISPOSITION,
        { state: 'unchecked', version: 1, cause: 'rerun_reset' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/cause/);
      await h.app.close();
    });
  });

  it('REFUSES a body that states its own actor or instant', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aUser(t, OTHER, 's-other');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('PUT', DISPOSITION,
        { state: 'verified', version: 1, byUserId: OTHER });
      expect(res.statusCode).toBe(400);
      await h.app.close();
    });
  });

  it('attributes to the AUTHENTICATED actor, not to whoever the body names', async () => {
    // The positive half of the refusal above: the name on the judgement is
    // the token's, always.
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aUser(t, OTHER, 's-other');
      await aFinding(t);
      const h = harness(t, OTHER);
      const result = await h.ok('PUT', DISPOSITION, { state: 'flagged', version: 1 });
      expect(result.disposition.byUserId).toBe(OTHER);
      expect(result.event.byUserId).toBe(OTHER);
      await h.app.close();
    });
  });

  it('refuses a finding in another workspace with 404, not 403', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const { app } = buildTestApi({
        principal: PRINCIPAL,
        db: dbOn(t),
        actor: {
          id: HUMAN, displayName: 'H', initials: 'H', role: 'reviewer',
          workspaceId: '00000000-0000-0000-0000-0000000000ff',
        },
      });
      const res = await app.inject({
        method: 'PUT', url: DISPOSITION, headers: { authorization: 'Bearer t' },
        payload: { state: 'verified', version: 1 } as never,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});

describe('a note is a person s remark about the clause', () => {
  it('stores it with the server s actor and instant, and answers 201 with the note', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('POST', NOTES, { text: '  Checked against the deed.  ' });
      expect(res.statusCode).toBe(201);
      const note = res.json();
      expect(note).toMatchObject({
        findingId: 'd1::c1', text: 'Checked against the deed.', byUserId: HUMAN,
      });
      expect(typeof note.at).toBe('number');
      expect(note.id).toBeTruthy();
      await h.app.close();
    });
  });

  it('REFUSES an empty note', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      expect((await h.send('POST', NOTES, { text: '   ' })).statusCode).toBe(400);
      expect(await t.query('select 1 from note')).toEqual([]);
      await h.app.close();
    });
  });

  it('is NOT touched by a disposition change', async () => {
    // "A note is a person's remark about the clause, not a component of
    // their judgement on one answer."
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      await h.ok('POST', NOTES, { text: 'Still relevant.' });
      await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      await h.ok('PUT', DISPOSITION,
        { state: 'rejected', reason: 'Wrong clause.', version: 2 });
      expect(await t.query('select 1 from note')).toHaveLength(1);
      await h.app.close();
    });
  });

  it('REFUSES a note on a finding that does not exist', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('POST', '/v1/reviews/r1/findings/d9/c1/notes', { text: 'x' });
      expect(res.statusCode).toBe(404);
      expect(await t.query('select 1 from note')).toEqual([]);
      await h.app.close();
    });
  });
});

describe('the history exists, and nothing renders it yet (P28)', () => {
  it('answers every move of one finding s disposition, newest first', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      await h.ok('PUT', DISPOSITION, { state: 'verified', version: 1 });
      await h.ok('PUT', DISPOSITION,
        { state: 'rejected', reason: 'The cap is in schedule 6.', version: 2 });

      const { events } = await h.ok('GET', HISTORY);
      expect(events.map((e: { toState: string }) => e.toState)).toEqual(['rejected', 'verified']);
      expect(events[0]).toMatchObject({
        fromState: 'verified', toState: 'rejected', cause: 'human',
        reason: 'The cap is in schedule 6.', byUserId: HUMAN,
      });
      // A verified move carries no reason at all — absent, not null, because
      // a reason on anything but a rejection is DROPPED when it is stored.
      expect('reason' in events[1]).toBe(false);
      await h.app.close();
    });
  });

  it('is not reachable from the browser in Stage 3 — no caller exists', async () => {
    // P28, asserted rather than remembered. The route is here so Stage 4's
    // history panel inherits a tested endpoint; a caller arriving early is
    // half of an attribution surface.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.join(import.meta.dirname, '../../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    expect(files.length, 'the walk found nothing, so this guard proves nothing')
      .toBeGreaterThan(120);
    const CALLS_HISTORY = /\/history['"`]|\/history\b/;
    expect(CALLS_HISTORY.test('apiGet(`/v1/reviews/${id}/findings/${k}/${c}/history`)')).toBe(true);
    expect(files.filter(f => CALLS_HISTORY.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(root, f))).toEqual([]);
  });
});

describe('THE GRANT IS THE GUARANTEE: the engine s role cannot write either table', () => {
  /*
   * The behavioural test — "a mid-run verification survives fifteen later
   * cells" — passes with or without this, which is why the plan names it as
   * a test that cannot fail. This one can: it attempts the writes AS
   * `lexprompt_worker`, the role the run worker really connects as, and a
   * grant added by a future convenience (`grant all on all tables …`) would
   * turn it red.
   */
  const AS_WORKER = [
    `insert into finding_disposition (review_id, findings_key, clause_id, workspace_id, state,
       changed_count) values ('r1', 'd1', 'c1', '${WS}', 'verified', 1)`,
    `update finding_disposition set state = 'verified' where review_id = 'r1'`,
    `select state from finding_disposition where review_id = 'r1'`,
    `insert into finding_disposition_event (review_id, findings_key, clause_id, workspace_id,
       from_state, to_state, cause, by_user_id, at)
       values ('r1', 'd1', 'c1', '${WS}', 'unchecked', 'verified', 'human', '${HUMAN}', now())`,
    `insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
       values ('n-worker', 'r1', 'd1', 'c1', '${WS}', 'x', '${HUMAN}', now())`,
  ];

  it('is refused every one of them, as the role the engine really runs as', async () => {
    const worker = workerDb();
    for (const sql of AS_WORKER) {
      await expect(worker.query(sql), sql.split('\n')[0]).rejects.toThrow(/permission denied/i);
    }
  });

  it('and every one of them is a WELL-FORMED statement, so none is refused for a typo', async () => {
    // The sanity check the refusals above need. A statement with a
    // misspelled column is refused by the app role too, and would make the
    // grant test pass for the wrong reason. `prepare` parses and plans
    // without executing.
    await withPg(async t => {
      for (const [n, sql] of AS_WORKER.entries()) {
        await expect(t.query(`prepare grant_gate_${n} as ${sql}`), sql.split('\n')[0])
          .resolves.toBeDefined();
      }
    });
  });
});

const NET_POSITION = '/v1/reviews/r1/findings/d1/c1/net-position';

describe('a net position is confirmed by a human, and by nothing else', () => {
  async function aPosition(t: Tx, state = 'unconfirmed'): Promise<void> {
    await t.query(
      `update finding set net_position = $1::jsonb
        where review_id = 'r1' and findings_key = 'd1' and clause_id = 'c1'`,
      [JSON.stringify({
        proposed: 'Read in order, the tenant has a rolling break on six months notice.',
        state,
        trail: [{ documentId: 'd1', kind: 'original', effect: 'Grants the break.', citations: [] }],
      })]);
  }

  it('runs confirmPosition on the SERVER, with the server s actor and instant', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      await aPosition(t);
      const h = harness(t);

      const before = Date.now();
      const result = await h.ok('PUT', NET_POSITION, { action: 'confirm', version: 1 });
      expect(result.netPosition).toMatchObject({ state: 'confirmed', byUserId: HUMAN });
      expect(result.netPosition.at).toBeGreaterThanOrEqual(before);
      // The TRAIL survives untouched: confirming does not change what the
      // documents were read to say, only that a person has now looked.
      expect(result.netPosition.trail).toHaveLength(1);
      expect(result.version).toBe(2);
      await h.app.close();
    });
  });

  it('amends it with the person s own words, which is a STRONGER claim', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      await aPosition(t);
      const h = harness(t);
      const result = await h.ok('PUT', NET_POSITION,
        { action: 'amend', text: 'The break is on three months notice.', version: 1 });
      expect(result.netPosition).toMatchObject({
        state: 'confirmed', amended: 'The break is on three months notice.', byUserId: HUMAN,
      });
      // `proposed` is KEPT, so the trail can show what changed between the
      // model's synthesis and the human's correction.
      expect(result.netPosition.proposed).toMatch(/rolling break/);
      await h.app.close();
    });
  });

  it('REFUSES a body that states the position itself', async () => {
    /*
     * The whole reason the body carries an ACTION. A body carrying a
     * `NetPosition` could say `state: 'confirmed'` with anybody's name on
     * it — and a net position is synthesised text no document contains,
     * which makes it the output where a false confirmation costs most.
     */
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      await aPosition(t);
      const h = harness(t);
      for (const body of [
        { action: 'confirm', version: 1, state: 'confirmed' },
        { action: 'confirm', version: 1, byUserId: OTHER },
        { action: 'confirm', version: 1, at: 1 },
        { action: 'amend', text: 'x', version: 1, amended: 'y' },
      ]) {
        const res = await h.send('PUT', NET_POSITION, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await t.query<{ net_position: { state: string } }>(
        "select net_position from finding where clause_id = 'c1'"))[0].net_position.state)
        .toBe('unconfirmed');
      await h.app.close();
    });
  });

  it('REFUSES an empty amendment — a person amending writes every word', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      await aPosition(t);
      const h = harness(t);
      expect((await h.send('PUT', NET_POSITION,
        { action: 'amend', text: '   ', version: 1 })).statusCode).toBe(400);
      await h.app.close();
    });
  });

  it('REFUSES a clause with no synthesised position — absent is not unconfirmed', async () => {
    // A standalone finding has none at all, and confirming one that does
    // not exist would manufacture a synthesis nobody produced.
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      const h = harness(t);
      const res = await h.send('PUT', NET_POSITION, { action: 'confirm', version: 1 });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/no synthesised position/);
      await h.app.close();
    });
  });

  it('REFUSES a stale version, so a re-run cannot be confirmed out from under', async () => {
    await withPg(async t => {
      await aUser(t, HUMAN, 's-human');
      await aFinding(t);
      await aPosition(t);
      const h = harness(t);
      await h.ok('PUT', NET_POSITION, { action: 'confirm', version: 1 });
      const res = await h.send('PUT', NET_POSITION,
        { action: 'amend', text: 'Something else.', version: 1 });
      expect(res.statusCode).toBe(409);
      expect((await t.query<{ net_position: { amended?: string } }>(
        "select net_position from finding where clause_id = 'c1'"))[0].net_position.amended)
        .toBeUndefined();
      await h.app.close();
    });
  });
});
