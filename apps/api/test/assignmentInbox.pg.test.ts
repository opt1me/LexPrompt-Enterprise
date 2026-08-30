import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssignmentInboxPage } from '@lexprompt/core';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * THE CROSS-MATTER INBOX, AND THE CONTEXT AN ASSIGNEE NEEDS TO ACT.
 *
 * The pre-flight for this task was a run, not a belief: `GET
 * /v1/assignments?state=open` on the running stack answers `reviewId`,
 * `findingsKey`, `clauseId` and two user ids, and **no matter, no review
 * name and no clause title**. A cross-matter inbox rendered from that is
 * three opaque strings, which is why this projection exists.
 *
 * Every assertion here is about a fact the OLD shape could not carry, plus
 * the two that keep it honest: `capped` rather than a silently short page,
 * and a clause title read from the review's own SNAPSHOT rather than from
 * the playbook as it stands today.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f1';
const TRAINEE = '00000000-0000-0000-0000-0000000000c1';
const PARTNER = '00000000-0000-0000-0000-0000000000c2';
const STRANGER = '00000000-0000-0000-0000-0000000000c3';

interface Harness {
  app: FastifyInstance;
  send(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function as(t: Tx, actorId: string, workspaceId = WS, inboxLimit = 200): Harness {
  const { app } = buildTestApi({
    principal: { issuer: 'i', subject: `s-${actorId}`, groups: ['reviewers'] },
    db: dbOn(t),
    assignmentInboxLimit: inboxLimit,
    actor: {
      id: actorId, displayName: 'A Person', initials: 'AP', role: 'reviewer', workspaceId,
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

async function inboxOf(
  t: Tx, actorId: string, workspaceId = WS, inboxLimit = 200,
): Promise<AssignmentInboxPage> {
  const res = await as(t, actorId, workspaceId, inboxLimit)
    .send('GET', '/v1/assignments?state=open');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AssignmentInboxPage;
}

async function people(t: Tx): Promise<void> {
  for (const id of [TRAINEE, PARTNER]) {
    await t.query(
      `insert into app_user
         (id, workspace_id, issuer, subject, display_name, initials, role, status)
       values ($1, $2, 'i', $3, 'A Person', 'AP', 'reviewer', 'active')
       on conflict (id) do nothing`, [id, WS, `s-${id}`]);
  }
}

/**
 * A SECOND FIRM. Needs the MIGRATOR, like every other cross-workspace test
 * in this repository (`assignments.pg.test.ts` and `changesets.pg.test.ts`
 * are the precedents): a second workspace and its people are schema-owner
 * writes and the app role deliberately cannot make them. Still rolled back.
 */
async function otherFirm(t: Tx): Promise<void> {
  await t.query(
    `insert into workspace (id, name) values ($1, 'Another firm')
     on conflict (id) do nothing`, [OTHER_WS]);
  await t.query(
    `insert into app_user
       (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, 'A Person', 'AP', 'reviewer', 'active')
     on conflict (id) do nothing`, [STRANGER, OTHER_WS, `s-${STRANGER}`]);
}

/** One matter, one review with a named snapshot, one `done` finding. */
async function seedReview(
  t: Tx, key: string, matterName: string, snapshot: unknown, ws = WS,
): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, $3, now(), now())`, [`m-${key}`, ws, matterName]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, $4::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())`,
    [`r-${key}`, ws, `m-${key}`, JSON.stringify(snapshot)]);
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ($1, 'd1', 'c1', $2, 'done')`, [`r-${key}`, ws]);
}

async function assign(
  t: Tx, key: string, assignee: string, assigner: string, ws = WS, id = `a-${key}`,
  clauseId = 'c1',
): Promise<void> {
  await t.query(
    `insert into assignment
       (id, review_id, findings_key, clause_id, workspace_id,
        assignee_user_id, assigned_by_user_id)
     values ($1, $2, 'd1', $3, $4, $5, $6)`,
    [id, `r-${key}`, clauseId, ws, assignee, assigner]);
}

const NAMED = {
  id: 'p1', name: 'Lease playbook', clauses: [{ id: 'c1', title: 'Liability cap' }],
};

describe('the inbox answers across matters, and says what each request is about', () => {
  it('answers every open request addressed to me, across matters', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', { ...NAMED, name: 'Matter A review' });
      await seedReview(t, 'b', 'Matter B', { ...NAMED, name: 'Matter B review' });
      await assign(t, 'a', PARTNER, TRAINEE);
      await assign(t, 'b', PARTNER, TRAINEE);

      const page = await inboxOf(t, PARTNER);
      expect(page.items.map(i => i.matterName).sort()).toEqual(['Matter A', 'Matter B']);
      // THE FACTS THE OLD SHAPE COULD NOT CARRY. A matter, a review name and
      // a clause title, resolved server-side in the same statement.
      expect(page.items.map(i => i.reviewName).sort())
        .toEqual(['Matter A review', 'Matter B review']);
      expect(page.items.every(i => i.clauseTitle === 'Liability cap')).toBe(true);
      expect(page.items.every(i => i.matterId.startsWith('m-'))).toBe(true);
      // ...and the row itself is still the row, COMPOSED rather than
      // flattened: the socket carries `AssignmentView` and this carries the
      // same type inside it, so one shape does not come to mean two things.
      expect(page.items[0].assignment.assigneeUserId).toBe(PARTNER);
      expect(page.items[0].assignment.assignedByUserId).toBe(TRAINEE);
      expect(page.capped).toBe(false);
    });
  });

  it('names the clause from the review SNAPSHOT, not the playbook as it stands', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', NAMED);
      await assign(t, 'a', PARTNER, TRAINEE);
      // A LIVE playbook version, published after the review ran, with the
      // clause renamed. Joining it would rename history.
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
         values ('pb-live', $1, 'Lease playbook', now(), now(), 1)`, [WS]);
      await t.query(
        `insert into playbook_version
           (id, workspace_id, playbook_id, version_number, content, published_at)
         values ('pv-live', $1, 'pb-live', 1,
                 '{"clauses":[{"id":"c1","title":"Liability cap (revised)"}]}'::jsonb, now())`,
        [WS]);
      await t.query(
        "update playbook set current_version_id = 'pv-live' where id = 'pb-live'");

      const [item] = (await inboxOf(t, PARTNER)).items;
      expect(item.clauseTitle).toBe('Liability cap');
    });
  });

  it('omits clauseTitle rather than inventing one when the snapshot lost the clause', async () => {
    await withPg(async t => {
      await people(t);
      // The snapshot names a DIFFERENT clause; the assignment is about `c1`.
      await seedReview(t, 'a', 'Matter A',
        { id: 'p1', name: 'Lease playbook', clauses: [{ id: 'c9', title: 'Something else' }] });
      await assign(t, 'a', PARTNER, TRAINEE);

      const [item] = (await inboxOf(t, PARTNER)).items;
      // ABSENT, not undefined-valued: `structuredClone` preserves an
      // undefined-valued key and an `in` check would read it as a title.
      expect('clauseTitle' in item).toBe(false);
      // ...and the row survives with its id rather than being dropped: "a
      // clause this review no longer has" is a real request somebody still
      // has to answer.
      expect(item.assignment.clauseId).toBe('c1');
    });
  });

  it('omits reviewName rather than inventing one when the snapshot names none', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', { id: 'p1', clauses: [] });
      await assign(t, 'a', PARTNER, TRAINEE);
      const [item] = (await inboxOf(t, PARTNER)).items;
      expect('reviewName' in item).toBe(false);
      // The matter's name is NOT optional -- `matter.name` is `not null` --
      // so the row stays legible without it.
      expect(item.matterName).toBe('Matter A');
    });
  });

  it('answers only MY requests -- the assigner sees nothing of their own', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', NAMED);
      await seedReview(t, 'b', 'Matter B', NAMED);
      await assign(t, 'a', PARTNER, TRAINEE);
      await assign(t, 'b', PARTNER, TRAINEE);
      // A count of "assigned to me" that included what you asked of others
      // would tell you that you owe somebody an answer you do not owe.
      expect((await inboxOf(t, TRAINEE)).items).toHaveLength(0);
      expect((await inboxOf(t, PARTNER)).items).toHaveLength(2);
    });
  });

  it('never crosses a workspace, and never returns a resolved request', async () => {
    await withPg(async t => {
      await people(t);
      await otherFirm(t);
      await seedReview(t, 'a', 'Matter A', NAMED);
      await seedReview(t, 'z', 'Another firm s matter', NAMED, OTHER_WS);
      await assign(t, 'a', PARTNER, TRAINEE);
      await assign(t, 'z', STRANGER, STRANGER, OTHER_WS);
      // Resolved requests are GONE, not merely sorted last.
      await t.query(
        `insert into assignment
           (id, review_id, findings_key, clause_id, workspace_id, assignee_user_id,
            assigned_by_user_id, resolved_at, resolved_by_user_id)
         values ('a-closed', 'r-a', 'd1', 'c1', $1, $2, $3, now(), $2)`,
        [WS, PARTNER, TRAINEE]);

      const mine = await inboxOf(t, PARTNER);
      expect(mine.items.map(i => i.assignment.id)).toEqual(['a-a']);
      // Asserted from the OTHER side too, so this is about the predicate
      // rather than about who happened to be asked.
      const theirs = await inboxOf(t, STRANGER, OTHER_WS);
      expect(theirs.items.map(i => i.matterName)).toEqual(['Another firm s matter']);
    }, migratorDb());
  });

  it('reports capped rather than silently returning a short page', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', NAMED);
      for (const clause of ['c1', 'c2', 'c3']) {
        if (clause !== 'c1') {
          await t.query(
            `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
             values ('r-a', 'd1', $1, $2, 'done')`, [clause, WS]);
        }
        await assign(t, 'a', PARTNER, TRAINEE, WS, `a-${clause}`, clause);
      }
      const page = await inboxOf(t, PARTNER, WS, 2);
      expect(page.items).toHaveLength(2);
      expect(page.capped).toBe(true);
      // ...and the same data under a limit that fits is NOT capped, so the
      // flag is measured rather than always-on.
      expect((await inboxOf(t, PARTNER, WS, 3)).capped).toBe(false);
    });
  });

  it('leaves the review-scoped call answering exactly what it did', async () => {
    await withPg(async t => {
      await people(t);
      await seedReview(t, 'a', 'Matter A', NAMED);
      await assign(t, 'a', PARTNER, TRAINEE);
      const res = await as(t, TRAINEE).send('GET', '/v1/assignments?state=open&review=r-a');
      expect(res.statusCode, res.body).toBe(200);
      // BOTH DIRECTIONS, still -- the assigner reads back the request they
      // made, which is what the Withdraw control on the review screen needs.
      const body = res.json() as { assignments: { id: string }[] };
      expect(body.assignments.map(a => a.id)).toEqual(['a-a']);
      expect('items' in body).toBe(false);
    });
  });
});
