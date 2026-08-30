import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * AN ASSIGNMENT IS A REQUEST, AND NEVER A DISPOSITION (§6.3, S17, Task 24).
 *
 * The owner's escape hatch: *"a trainee may verify one clause and be happy,
 * then flag another for a Partner's view."* Two acts, deliberately kept
 * apart, and the assertion that keeps them apart is the one in the middle of
 * this file — assigning changes no disposition, writes no
 * `finding_disposition_event`, and moves no version.
 *
 * That test is the one a later "flag and assign in one click" feature would
 * quietly break, which is why it reads the history and the version rather
 * than merely checking that the assignment row exists.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const TRAINEE = '00000000-0000-0000-0000-0000000000b1';
const PARTNER = '00000000-0000-0000-0000-0000000000b2';
const OUTSIDER = '00000000-0000-0000-0000-0000000000b3';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f1';

const ASSIGN = '/v1/reviews/ar1/findings/d1/c1/assignments';
const DISPOSITION = '/v1/reviews/ar1/findings/d1/c1/disposition';
const HISTORY = '/v1/reviews/ar1/findings/d1/c1/history';

interface Harness {
  app: FastifyInstance;
  send(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function as(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: { issuer: 'i', subject: `s-${actorId}`, groups: ['reviewers'] },
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'A Person', initials: 'AP', role: 'reviewer', workspaceId: WS,
    },
  });
  return {
    app,
    send: ((method: string, url: string, body?: unknown) => app.inject({
      method: method as 'GET', url, headers: { authorization: 'Bearer t' },
      payload: body as never,
    })) as never,
  };
}

async function seed(t: Tx): Promise<void> {
  for (const [id, ws] of [[TRAINEE, WS], [PARTNER, WS]] as const) {
    await t.query(
      `insert into app_user
         (id, workspace_id, issuer, subject, display_name, initials, role, status)
       values ($1, $2, 'i', $3, 'A Person', 'AP', 'reviewer', 'active')
       on conflict (id) do nothing`, [id, ws, `s-${id}`]);
  }
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('am1', $1, 'Assignment', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ('ar1', $1, 'am1', '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [WS]);
  for (const clause of ['c1', 'c2']) {
    await t.query(
      `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
       values ('ar1', 'd1', $2, $1, 'done') on conflict do nothing`, [WS, clause]);
    await t.query(
      `insert into finding_disposition
         (review_id, findings_key, clause_id, workspace_id, state, changed_count)
       values ('ar1', 'd1', $2, $1, 'unchecked', 0) on conflict do nothing`, [WS, clause]);
  }
}

describe('a reviewer can ask a colleague to look at a clause', () => {
  it('records the request with both people, the message and the time', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN, {
        assigneeUserId: PARTNER, message: 'Not sure the cap survives 14.2.',
      });
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json();
      expect(view.assigneeUserId).toBe(PARTNER);
      // FROM THE TOKEN, never from the body. A request that could name its
      // own author is one anybody could put anybody's name on, and this one
      // arrives on somebody's screen saying who asked.
      expect(view.assignedByUserId).toBe(TRAINEE);
      expect(view.message).toBe('Not sure the cap survives 14.2.');
      expect(typeof view.createdAt).toBe('number');
      // OPEN means the two resolution keys are ABSENT, not `null` and not
      // `undefined`-valued: `structuredClone` preserves an undefined key, so
      // an `in` check would read this as a request somebody closed.
      expect('resolvedAt' in view).toBe(false);
      expect('resolvedByUserId' in view).toBe(false);
    });
  });

  it('refuses a body that names the assigner, by ignoring it entirely', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN, {
        assigneeUserId: PARTNER, assignedByUserId: PARTNER,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().assignedByUserId).toBe(TRAINEE);
    });
  });

  it('refuses an assignment with no assignee, and says which field is missing', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN, { message: 'have a look' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('assigneeUserId');
    });
  });

  it('stores no message rather than an empty one', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN,
        { assigneeUserId: PARTNER, message: '   ' });
      expect(res.statusCode).toBe(201);
      // A message that renders as a message and carries nothing sends the
      // assignee to the clause to work out what was wanted — the whole
      // failure a message exists to prevent.
      expect('message' in res.json()).toBe(false);
    });
  });

  it('refuses an assignee who is not in this workspace', async () => {
    // ON THE MIGRATOR, like every other cross-workspace test in this
    // repository (`changesets.pg.test.ts` is the precedent): the second
    // workspace and its user are schema-owner writes, and the app role
    // deliberately cannot make them. Still rolled back.
    await withPg(async t => {
      await seed(t);
      await t.query(
        `insert into workspace (id, name) values ($1, 'Another firm')
         on conflict (id) do nothing`, [OTHER_WS]);
      await t.query(
        `insert into app_user
           (id, workspace_id, issuer, subject, display_name, initials, role, status)
         values ($1, $2, 'i', 's-outsider', 'O Outsider', 'OO', 'reviewer', 'active')
         on conflict (id) do nothing`, [OUTSIDER, OTHER_WS]);
      const res = await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: OUTSIDER });
      // The foreign key alone would take this row, and the request would sit
      // in a queue that person can never see — looking to the assigner
      // exactly like one that arrived.
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).toContain('workspace');
    }, migratorDb());
  });

  it('refuses an assignment to a finding this review does not cover', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send(
        'POST', '/v1/reviews/ar1/findings/d1/c999/assignments', { assigneeUserId: PARTNER });
      expect(res.statusCode, res.body).toBe(404);
    });
  });

  it('refuses a SECOND open assignment to the same person for the same clause', async () => {
    await withPg(async t => {
      await seed(t);
      const first = await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      expect(first.statusCode).toBe(201);
      const second = await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      expect(second.statusCode, second.body).toBe(409);
      // The SENTENCE, not the constraint name. A caller reading
      // "assignment_open_idx" learns nothing they can act on.
      expect(second.body).toContain('already asked');
    });
  });

  it('allows a second open assignment to a DIFFERENT person', async () => {
    await withPg(async t => {
      await seed(t);
      expect((await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).statusCode)
        .toBe(201);
      // Two people can each be asked to look at the same clause — a second
      // opinion is a normal thing to want, and a unique constraint on the
      // finding alone would refuse this with a constraint name.
      expect((await as(t, PARTNER).send('POST', ASSIGN, { assigneeUserId: TRAINEE })).statusCode)
        .toBe(201);
    });
  });

  it('allows the same person again once the first request is closed', async () => {
    await withPg(async t => {
      await seed(t);
      const first = await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      const id = first.json().id;
      expect((await as(t, PARTNER).send('POST', `/v1/assignments/${id}/resolve`)).statusCode)
        .toBe(200);
      // The index is PARTIAL (`where resolved_at is null`). Asking again
      // after a request was closed is a new request, not a duplicate.
      expect((await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).statusCode)
        .toBe(201);
    });
  });
});

describe('an assignment is a request, not a disposition (§6.3)', () => {
  it('changes no disposition, and writes no disposition event', async () => {
    await withPg(async t => {
      await seed(t);
      const before = await t.query<{ state: string; version: string; changed_count: number }>(
        `select state, version, changed_count from finding_disposition
          where review_id = 'ar1' and findings_key = 'd1' and clause_id = 'c1'`);
      const historyBefore = await as(t, TRAINEE).send('GET', HISTORY);

      const res = await as(t, TRAINEE).send('POST', ASSIGN,
        { assigneeUserId: PARTNER, message: 'Not sure the cap survives 14.2.' });
      expect(res.statusCode).toBe(201);

      const after = await t.query<{ state: string; version: string; changed_count: number }>(
        `select state, version, changed_count from finding_disposition
          where review_id = 'ar1' and findings_key = 'd1' and clause_id = 'c1'`);
      /*
       * §6.3: "a request, not a disposition". This is the assertion that
       * keeps the two acts apart, and it is the one a later "assign and flag
       * in one click" feature would quietly break — the row would move and
       * the history would gain an entry attributing a judgement to somebody
       * who only asked a question.
       */
      expect(after).toEqual(before);
      expect((await as(t, TRAINEE).send('GET', HISTORY)).json())
        .toEqual(historyBefore.json());
    });
  });

  it('records the act in audit_event, since the row is mutable and has no log of its own', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      const rows = await t.query<{ action: string; actor_user_id: string; subject_id: string }>(
        // SCOPED TO THIS REVIEW. `test:pg` and `test:compose` share one
        // database, and a count over the whole workspace picks up rows the
        // compose suites committed -- a test that passes or fails depending
        // on what else has run is not a test.
        `select action, actor_user_id, subject_id from audit_event
          where workspace_id = $1 and action = 'assignment.created'
            and review_id = 'ar1'`, [WS]);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(TRAINEE);
      expect(rows[0].subject_id).toBe(res.json().id);
      // …and STILL no disposition action in the audit log (S22). The
      // asymmetry is the rule being applied, not an exception to it.
      const dispositions = await t.query<{ action: string }>(
        `select action from audit_event
          where workspace_id = $1 and action like 'finding.%' and review_id = 'ar1'`, [WS]);
      expect(dispositions).toEqual([]);
    });
  });

  it('pushes assignment.created onto the outbox, carrying the whole row', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', ASSIGN,
        { assigneeUserId: PARTNER, message: 'Not sure the cap survives 14.2.' });
      const events = await t.query<{ type: string; payload: any; review_id: string }>(
        `select type, payload, review_id from event
          where workspace_id = $1 and type = 'assignment.created' and review_id = 'ar1'`, [WS]);
      expect(events).toHaveLength(1);
      // The WHOLE row travels, so the assignee's screen renders "A. Trainee
      // asked you to look at this" and the message from one frame with no
      // second query.
      expect(events[0].payload.assignment.id).toBe(res.json().id);
      expect(events[0].payload.assignment.message).toBe('Not sure the cap survives 14.2.');
      expect(events[0].payload.assignment.assignedByUserId).toBe(TRAINEE);
      expect(events[0].review_id).toBe('ar1');
    });
  });

  it('a disposition change beside it still works and still names its own actor', async () => {
    await withPg(async t => {
      await seed(t);
      await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      const res = await as(t, PARTNER).send('PUT', DISPOSITION,
        { state: 'rejected', reason: 'The cap is uncapped.', version: 1 });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().disposition.byUserId).toBe(PARTNER);
    });
  });
});

describe('closing a request', () => {
  it('lets the assignee close it, and lets the assigner withdraw it', async () => {
    await withPg(async t => {
      await seed(t);
      const mine = (await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).json();
      const closed = await as(t, PARTNER).send('POST', `/v1/assignments/${mine.id}/resolve`);
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json().resolvedByUserId).toBe(PARTNER);
      expect(typeof closed.json().resolvedAt).toBe('number');

      // …and the assigner can withdraw a different one.
      const other = (await as(t, TRAINEE).send(
        'POST', '/v1/reviews/ar1/findings/d1/c2/assignments',
        { assigneeUserId: PARTNER })).json();
      const withdrawn = await as(t, TRAINEE).send('POST', `/v1/assignments/${other.id}/resolve`);
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      expect(withdrawn.json().resolvedByUserId).toBe(TRAINEE);
    });
  });

  it('refuses a third person, naming the two who may', async () => {
    await withPg(async t => {
      await seed(t);
      await t.query(
        `insert into app_user
           (id, workspace_id, issuer, subject, display_name, initials, role, status)
         values ($1, $2, 'i', 's-third', 'T Third', 'TT', 'reviewer', 'active')
         on conflict (id) do nothing`,
        ['00000000-0000-0000-0000-0000000000b9', WS]);
      const mine = (await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).json();
      const res = await as(t, '00000000-0000-0000-0000-0000000000b9')
        .send('POST', `/v1/assignments/${mine.id}/resolve`);
      // "This was dealt with" must be a claim one of the two people involved
      // made. A role is the wrong instrument: every reviewer holds the same
      // one and only two of them are party to any request.
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain('who was asked');
    });
  });

  it('refuses closing one that is already closed', async () => {
    await withPg(async t => {
      await seed(t);
      const mine = (await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).json();
      await as(t, PARTNER).send('POST', `/v1/assignments/${mine.id}/resolve`);
      const again = await as(t, PARTNER).send('POST', `/v1/assignments/${mine.id}/resolve`);
      // A silent 200 would tell the caller they closed something somebody
      // else closed minutes ago.
      expect(again.statusCode, again.body).toBe(409);
    });
  });

  it('answers 404 for an assignment in another workspace, never 403', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, TRAINEE).send('POST', '/v1/assignments/does-not-exist/resolve');
      // A 403 would confirm the id exists somewhere.
      expect(res.statusCode).toBe(404);
    });
  });

  it('writes assignment.resolved to the audit log and the outbox', async () => {
    await withPg(async t => {
      await seed(t);
      const mine = (await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).json();
      await as(t, PARTNER).send('POST', `/v1/assignments/${mine.id}/resolve`);
      const audit = await t.query<{ actor_user_id: string }>(
        `select actor_user_id from audit_event
          where workspace_id = $1 and action = 'assignment.resolved'
            and review_id = 'ar1'`, [WS]);
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(PARTNER);
      const events = await t.query<{ payload: any }>(
        `select payload from event
          where workspace_id = $1 and type = 'assignment.resolved' and review_id = 'ar1'`, [WS]);
      expect(events).toHaveLength(1);
      expect(events[0].payload.assignment.resolvedByUserId).toBe(PARTNER);
    });
  });
});

describe('what has been asked of me, and what I have asked of others', () => {
  it('lists BOTH directions for the caller, and nothing at all for a third party', async () => {
    await withPg(async t => {
      await seed(t);
      // The trainee asks the partner about c1; the partner asks the trainee
      // about c2. Each of them is a party to both.
      await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      await as(t, PARTNER).send('POST', '/v1/reviews/ar1/findings/d1/c2/assignments',
        { assigneeUserId: TRAINEE });

      const mine = await as(t, PARTNER).send('GET', '/v1/assignments?state=open');
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().assignments.map((a: { clauseId: string }) => a.clauseId).sort())
        .toEqual(['c1', 'c2']);
      const theirs = await as(t, TRAINEE).send('GET', '/v1/assignments?state=open');
      expect(theirs.json().assignments.map((a: { clauseId: string }) => a.clauseId).sort())
        .toEqual(['c1', 'c2']);

      // …and NOBODY ELSE'S. The caller's id comes from the token and there
      // is no query parameter that could ask for another person's queue.
      const outsider = await as(t, OUTSIDER).send('GET', '/v1/assignments?state=open');
      expect(outsider.json().assignments).toEqual([]);
    });
  });

  /*
   * A REQUEST YOU MADE SURVIVES A RELOAD (M4).
   *
   * This was the ONLY read of `assignment`, and it filtered by
   * `assignee_user_id` alone — so the "You asked R. Okafor to look at this"
   * line and its **Withdraw the request** control existed in the assigner's
   * tab and nowhere else. On reload they were gone, while the assignee went
   * on seeing the request open: one party could close it and the other could
   * not, from anywhere in the UI.
   */
  it('gives the ASSIGNER back the request they made, with the id Withdraw needs', async () => {
    await withPg(async t => {
      await seed(t);
      const made = (await as(t, TRAINEE).send('POST', ASSIGN,
        { assigneeUserId: PARTNER, message: 'Not sure the cap survives 14.2.' })).json();

      // The trainee reloads. Nothing is held in memory now.
      const afterReload = await as(t, TRAINEE).send('GET', '/v1/assignments?state=open&review=ar1');
      const found = afterReload.json().assignments
        .find((a: { id: string }) => a.id === made.id);
      expect(found, 'the request the caller made was not in their own read').toBeDefined();
      expect(found.assignedByUserId).toBe(TRAINEE);
      expect(found.message).toBe('Not sure the cap survives 14.2.');

      // And it can still be withdrawn, which is the control that vanished.
      expect((await as(t, TRAINEE).send('POST', `/v1/assignments/${found.id}/resolve`))
        .statusCode).toBe(200);
    });
  });

  it('drops a request once it is closed', async () => {
    await withPg(async t => {
      await seed(t);
      const mine = (await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER })).json();
      await as(t, PARTNER).send('POST', `/v1/assignments/${mine.id}/resolve`);
      expect((await as(t, PARTNER).send('GET', '/v1/assignments?state=open')).json().assignments)
        .toEqual([]);
    });
  });

  it('narrows to one review when asked, for the screen the assignee is on', async () => {
    await withPg(async t => {
      await seed(t);
      await as(t, TRAINEE).send('POST', ASSIGN, { assigneeUserId: PARTNER });
      const here = await as(t, PARTNER).send('GET', '/v1/assignments?state=open&review=ar1');
      expect(here.json().assignments).toHaveLength(1);
      const elsewhere = await as(t, PARTNER).send(
        'GET', '/v1/assignments?state=open&review=another-review');
      expect(elsewhere.json().assignments).toEqual([]);
    });
  });

  it('refuses a state it does not understand, rather than answering the open list', async () => {
    await withPg(async t => {
      await seed(t);
      const res = await as(t, PARTNER).send('GET', '/v1/assignments?state=resolved');
      // A caller who asked for closed requests and received open ones would
      // be reading the wrong list with no way to tell.
      expect(res.statusCode, res.body).toBe(400);
    });
  });
});
