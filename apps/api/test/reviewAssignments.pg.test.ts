import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssignmentView } from '@lexprompt/core';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * WHAT IS OUTSTANDING ON ONE REVIEW, WHOEVER WAS ASKED (Stage 5 Task 3).
 *
 * The question `GET /v1/assignments` deliberately does not answer. That one
 * is the caller's own queue and always will be; this one is scoped to a
 * review the caller can already read, and it returns requests between OTHER
 * people — which is the fact the assignee chip renders and which a third
 * reviewer currently has no way to learn at all.
 *
 * It carries NO ACTION and this suite asserts that: `resolve` still refuses
 * a third party, so what a bystander gains is information and not an
 * affordance on somebody else's act.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f1';
const TRAINEE = '00000000-0000-0000-0000-0000000000d1';
const PARTNER = '00000000-0000-0000-0000-0000000000d2';
const THIRD = '00000000-0000-0000-0000-0000000000d3';
const STRANGER = '00000000-0000-0000-0000-0000000000d4';

const REVIEW = 'rev-assignments';
const PATH = `/v1/reviews/${REVIEW}/assignments`;

interface Harness {
  app: FastifyInstance;
  send(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function as(t: Tx, actorId: string | null, workspaceId = WS): Harness {
  const { app } = buildTestApi({
    // `null` with no `principalError` is "no token at all" — `requireUser`
    // refuses before `verify` is ever called.
    principal: actorId === null
      ? null : { issuer: 'i', subject: `s-${actorId}`, groups: ['reviewers'] },
    db: dbOn(t),
    actor: {
      id: actorId ?? 'nobody', displayName: 'A Person', initials: 'AP',
      role: 'reviewer', workspaceId,
    },
  });
  return {
    app,
    send: ((method: string, url: string, body?: unknown) => app.inject({
      method: method as 'GET', url,
      ...(actorId === null ? {} : { headers: { authorization: 'Bearer t' } }),
      payload: body as never,
    })) as never,
  };
}

async function reviewAssignments(t: Tx, actorId: string): Promise<AssignmentView[]> {
  const res = await as(t, actorId).send('GET', PATH);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { assignments: AssignmentView[] }).assignments;
}

async function seed(t: Tx): Promise<void> {
  for (const id of [TRAINEE, PARTNER, THIRD]) {
    await t.query(
      `insert into app_user
         (id, workspace_id, issuer, subject, display_name, initials, role, status)
       values ($1, $2, 'i', $3, 'A Person', 'AP', 'reviewer', 'active')
       on conflict (id) do nothing`, [id, WS, `s-${id}`]);
  }
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('m-ra', $1, 'Assignments', now(), now())`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($2, $1, 'm-ra', '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())`, [WS, REVIEW]);
  for (const clause of ['A', 'B', 'C']) {
    await t.query(
      `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
       values ($2, 'd1', $1, $3, 'done')`, [clause, REVIEW, WS]);
  }
}

async function assign(
  t: Tx, id: string, clauseId: string, assignee: string, assigner: string,
  resolved = false,
): Promise<void> {
  await t.query(
    `insert into assignment
       (id, review_id, findings_key, clause_id, workspace_id,
        assignee_user_id, assigned_by_user_id, resolved_at, resolved_by_user_id)
     values ($1, $2, 'd1', $3, $4, $5, $6, $7, $8)`,
    [id, REVIEW, clauseId, WS, assignee, assigner,
      resolved ? new Date() : null, resolved ? assignee : null]);
}

describe('every open request on one review, whoever was asked', () => {
  it('lists every OPEN request on the review, whoever was asked', async () => {
    await withPg(async t => {
      await seed(t);
      // The trainee asks the partner about A; the partner asks the trainee
      // about B.
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      await assign(t, 'a-B', 'B', TRAINEE, PARTNER);
      const seen = await reviewAssignments(t, TRAINEE);
      expect(seen.map(a => a.clauseId).sort()).toEqual(['A', 'B']);
    });
  });

  it('answers a THIRD party, who is neither of the two people involved', async () => {
    await withPg(async t => {
      await seed(t);
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      // The whole point of this route. `GET /v1/assignments` tells this
      // reader nothing about it, correctly, because it is not their queue —
      // and so a third reviewer had no way at all to learn that a colleague
      // is already on this clause.
      const seen = await reviewAssignments(t, THIRD);
      expect(seen.map(a => a.clauseId)).toEqual(['A']);
      expect(seen[0].assigneeUserId).toBe(PARTNER);
      expect(seen[0].assignedByUserId).toBe(TRAINEE);
    });
  });

  it('offers that third party NO action on it', async () => {
    await withPg(async t => {
      await seed(t);
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      // Information, not an affordance. Stage 4's fix round had to impose
      // exactly this on the card, where a bystander was shown a live
      // Withdraw button for a request they had nothing to do with.
      const refused = await as(t, THIRD).send('POST', '/v1/assignments/a-A/resolve');
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.body).toMatch(/who was asked|who asked/i);
      // …and the request is still open, so the refusal is not a silent
      // success.
      expect((await reviewAssignments(t, THIRD)).map(a => a.id)).toEqual(['a-A']);
    });
  });

  it('drops a resolved request', async () => {
    await withPg(async t => {
      await seed(t);
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      await assign(t, 'a-B', 'B', PARTNER, TRAINEE, true);
      // A chip for a closed request would say somebody is looking at a
      // clause nobody is looking at.
      expect((await reviewAssignments(t, THIRD)).map(a => a.id)).toEqual(['a-A']);
    });
  });

  it('never crosses a workspace, and refuses rather than answering empty', async () => {
    await withPg(async t => {
      await seed(t);
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      await t.query(
        `insert into workspace (id, name) values ($1, 'Another firm')
         on conflict (id) do nothing`, [OTHER_WS]);
      await t.query(
        `insert into app_user
           (id, workspace_id, issuer, subject, display_name, initials, role, status)
         values ($1, $2, 'i', 's-stranger', 'S', 'SS', 'reviewer', 'active')
         on conflict (id) do nothing`, [STRANGER, OTHER_WS]);
      // 404, not an empty list: "nothing is outstanding here" and "this is
      // not yours" are different facts and only the first is an answer. A
      // 403 would confirm the id exists somewhere.
      const res = await as(t, STRANGER, OTHER_WS).send('GET', PATH);
      expect(res.statusCode).toBe(404);
      expect(res.json().assignments).toBeUndefined();
    }, migratorDb());
  });

  it('refuses an unauthenticated caller with 401 and not an empty list', async () => {
    await withPg(async t => {
      await seed(t);
      await assign(t, 'a-A', 'A', PARTNER, TRAINEE);
      const res = await as(t, null).send('GET', PATH);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('sign_in_required');
    });
  });
});
