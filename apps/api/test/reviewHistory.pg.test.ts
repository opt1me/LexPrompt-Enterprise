import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ReviewHistory } from '@lexprompt/core';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { clauseTitles, toReviewHistoryEvent } from '../src/routes/history.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * THE REVIEW'S WHOLE HISTORY (§6.3.1's fourth requirement).
 *
 * *"Reconstruct what this report would have said on the day it was signed"*
 * is a question only the history can answer — the current row answers only
 * *as of right now*, and as of Stage 4 that row is mutable by anybody in the
 * workspace at any time.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';
const TRAINEE = '00000000-0000-0000-0000-0000000000c1';
const PARTNER = '00000000-0000-0000-0000-0000000000c2';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-review-history',
  groups: ['reviewers'],
};

/** A snapshot naming `c1` and `c2`, and deliberately NOT `c-removed`. */
const SNAPSHOT = {
  clauses: [
    { id: 'c1', title: 'Liability cap' },
    { id: 'c2', title: 'Governing law' },
  ],
};

async function aUser(t: Tx, id: string, subject: string): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [id, WS, subject]);
}

async function aReview(t: Tx, reviewId: string, workspaceId = WS): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now()) on conflict (id) do nothing`,
    [`m-${reviewId}`, workspaceId]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, $4::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`,
    [reviewId, workspaceId, `m-${reviewId}`, JSON.stringify(SNAPSHOT)]);
}

async function anEvent(
  t: Tx, reviewId: string, clauseId: string,
  from: string, to: string, by: string, workspaceId = WS,
): Promise<void> {
  // A rejection carries a reason or the database refuses it
  // (`event_reason_on_reject`) — the same rule `setDisposition` states in
  // words. The fixture obeys it rather than working around it.
  await t.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, reason,
        cause, by_user_id, at)
     values ($1, 'd1', $2, $3, $4, $5, $6, 'human', $7, now())`,
    [reviewId, clauseId, workspaceId, from, to,
      to === 'rejected' ? 'The cap is uncapped.' : null, by]);
}

function harness(t: Tx, workspaceId = WS): FastifyInstance {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: TRAINEE, displayName: 'A Trainee', initials: 'AT', role: 'reviewer', workspaceId,
    },
  });
  return app;
}

const get = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: 'Bearer t' } });

describe('a review s whole disposition history', () => {
  it('returns every change, OLDEST first, with the clause it belongs to', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aUser(t, PARTNER, 's-partner');
      await aReview(t, 'rh1');
      await anEvent(t, 'rh1', 'c1', 'unchecked', 'verified', TRAINEE);
      await anEvent(t, 'rh1', 'c1', 'verified', 'rejected', PARTNER);
      await anEvent(t, 'rh1', 'c2', 'unchecked', 'flagged', TRAINEE);
      const app = harness(t);

      const res = await get(app, '/v1/reviews/rh1/history');
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as ReviewHistory;
      // A chronology reads FORWARD. The per-finding panel reads backward,
      // and both are right for their reader.
      expect(page.events.map(e => [e.fromState, e.toState])).toEqual([
        ['unchecked', 'verified'],
        ['verified', 'rejected'],
        ['unchecked', 'flagged'],
      ]);
      expect(page.events.map(e => e.clauseTitle))
        .toEqual(['Liability cap', 'Liability cap', 'Governing law']);
      // Both people are named, not just the caller — this is the surface a
      // firm reconstructs a contested clause from.
      expect(new Set(page.events.map(e => e.byUserId))).toEqual(new Set([TRAINEE, PARTNER]));
      expect(page.hasMore).toBe(false);
      expect('nextCursor' in page).toBe(false);
      await app.close();
    });
  });

  it('pages rather than returning a year of history in one response', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aReview(t, 'rh2');
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await anEvent(t, 'rh2', 'c1', 'unchecked', 'verified', TRAINEE);
      }
      const app = harness(t);

      const first = (await get(app, '/v1/reviews/rh2/history?limit=2')).json() as ReviewHistory;
      expect(first.events).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe(first.events[1]!.id);

      const second = (await get(app,
        `/v1/reviews/rh2/history?limit=2&after=${first.nextCursor}`)).json() as ReviewHistory;
      expect(second.events).toHaveLength(2);
      // The cursor is an event id on an insert-only table, so the boundary
      // cannot shift under a reader the way an offset into a mutable list
      // can — the pages do not overlap and nothing is skipped.
      expect(second.events.map(e => e.id)).not.toContain(first.events[1]!.id);
      expect(second.events[0]!.id).toBeGreaterThan(first.events[1]!.id);

      const last = (await get(app,
        `/v1/reviews/rh2/history?limit=2&after=${second.nextCursor}`)).json() as ReviewHistory;
      expect(last.events).toHaveLength(1);
      expect(last.hasMore).toBe(false);
      await app.close();
    });
  });

  it('refuses a review in another workspace rather than returning an empty history', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aReview(t, 'rh3');
      await anEvent(t, 'rh3', 'c1', 'unchecked', 'verified', TRAINEE);
      // The review is real and has a history; the CALLER is somewhere else.
      // Stated as the actor's workspace rather than by planting a second
      // firm's review, so the assertion is about the route's predicate and
      // not about how the fixture was seeded.
      const app = harness(t, OTHER_WS);

      // An empty history is indistinguishable from a review nobody has
      // touched. 404, the same shape `readFindings` already takes, and
      // scoped by workspace so the id's existence elsewhere is not
      // confirmed.
      const res = await get(app, '/v1/reviews/rh3/history');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      expect(res.body).not.toContain('"events"');
      await app.close();
    });
  });

  it('names a clause that is no longer in the playbook, rather than dropping the row', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aReview(t, 'rh4');
      await anEvent(t, 'rh4', 'c-removed', 'unchecked', 'verified', TRAINEE);
      const app = harness(t);

      const page = (await get(app, '/v1/reviews/rh4/history')).json() as ReviewHistory;
      // A clause removed from a later playbook version still had judgements
      // made about it. Dropping the row would make the history quietly
      // shorter than what happened — the blank-CSV-cell defect on the one
      // surface whose whole purpose is completeness.
      expect(page.events).toHaveLength(1);
      expect(page.events[0]!.clauseId).toBe('c-removed');
      // ABSENT, not `clauseTitle: undefined`: `structuredClone` preserves an
      // undefined-valued key, so an `in` check would read "unnamed" as
      // "named, with nothing".
      expect('clauseTitle' in page.events[0]!).toBe(false);
      await app.close();
    });
  });

  it('reads only THIS review s events, and only this workspace s', async () => {
    // AS THE MIGRATOR, and only this case: `finding_disposition_event`
    // references `workspace(id)`, the dev database holds exactly one
    // workspace, and the app role holds no insert on `workspace` — so the
    // second firm this case needs cannot be planted as the app role at all.
    // Everything is still inside `withPg`'s rollback. The other cases stay
    // on the app role, which is what a request actually runs as.
    await withPg(async t => {
      await t.query(
        `insert into workspace (id, name) values ($1, 'Another firm')
         on conflict (id) do nothing`, [OTHER_WS]);
      await aUser(t, TRAINEE, 's-trainee');
      await aReview(t, 'rh5');
      await aReview(t, 'rh6');
      await anEvent(t, 'rh5', 'c1', 'unchecked', 'verified', TRAINEE);
      await anEvent(t, 'rh6', 'c1', 'unchecked', 'rejected', TRAINEE);
      // The same review id, in another firm. Drop `workspace_id = $2` from
      // `readReviewDispositionEvents` and this row joins the answer — with
      // nothing else failing, because the route's own review lookup is
      // scoped and would still have found the review.
      await t.query(
        `insert into finding_disposition_event
           (review_id, findings_key, clause_id, workspace_id, from_state, to_state, reason,
            cause, by_user_id, at)
         values ('rh5', 'd1', 'c1', $1, 'unchecked', 'flagged', null, 'human', $2, now())`,
        [OTHER_WS, TRAINEE]);
      const app = harness(t);

      const page = (await get(app, '/v1/reviews/rh5/history')).json() as ReviewHistory;
      expect(page.events.map(e => e.toState)).toEqual(['verified']);
      await app.close();
    }, migratorDb());
  });

  it('answers a page for a review nobody has touched, rather than a 404', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aReview(t, 'rh7');
      const app = harness(t);
      const page = (await get(app, '/v1/reviews/rh7/history')).json() as ReviewHistory;
      // The other side of the 404 above, and the reason it has to be scoped
      // rather than driven by emptiness: "nothing has happened here" is a
      // real and different answer from "this is not yours".
      expect(page.events).toEqual([]);
      expect(page.hasMore).toBe(false);
      await app.close();
    });
  });
});

/**
 * The absence, asserted on the OBJECT rather than over HTTP.
 *
 * The case above that checks `'clauseTitle' in event` reads `res.json()`,
 * and `JSON.stringify` drops an undefined-valued key on the way out — so
 * over HTTP, `clauseTitle: title` and `...(title ? {clauseTitle} : {})` are
 * indistinguishable, and the mutation that replaces the second with the
 * first passed. `structuredClone`, which is how a record crosses every other
 * boundary in this system, PRESERVES it.
 */
describe('the shape itself, not the shape JSON survived', () => {
  const titles = new Map([['c1', 'Liability cap']]);
  const row = {
    id: 7, from_state: 'unchecked' as const, to_state: 'verified' as const, reason: null,
    cause: 'human' as const, by_user_id: TRAINEE, at: new Date(1_756_000_000_000),
    findings_key: 'd1', clause_id: 'c-removed',
  };

  it('leaves clauseTitle ABSENT on the object for a clause the snapshot does not name', () => {
    const event = toReviewHistoryEvent(row, titles);
    expect('clauseTitle' in event).toBe(false);
    expect(Object.keys(structuredClone(event))).not.toContain('clauseTitle');
    // The positive half, so a mapper that never set the key at all would
    // fail here rather than pass both.
    expect(toReviewHistoryEvent({ ...row, clause_id: 'c1' }, titles).clauseTitle)
      .toBe('Liability cap');
  });

  it('reads clause titles out of a snapshot, and survives one shaped differently', () => {
    expect(clauseTitles({ clauses: [{ id: 'a', title: 'A' }] }).get('a')).toBe('A');
    // A history with unnamed clauses is worth far more than a 500.
    for (const bad of [null, undefined, {}, { clauses: 'x' }, { clauses: [null, 3] },
      { clauses: [{ id: 'a' }] }, { clauses: [{ id: 'a', title: '' }] }]) {
      expect(clauseTitles(bad).size).toBe(0);
    }
  });
});
