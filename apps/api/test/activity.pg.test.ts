import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MatterActivityPage } from '@lexprompt/core';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * THE FEED READS THREE RECORDS THAT ALREADY EXIST (S22).
 *
 * A disposition change comes from `finding_disposition_event`, an audited
 * act from `audit_event`, and a run from `run`. What must never appear is a
 * fourth: an `activity` table would be a second account of what happened,
 * free to drift from the records it claims to describe.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000fe';
const TRAINEE = '00000000-0000-0000-0000-0000000000e1';
const PARTNER = '00000000-0000-0000-0000-0000000000e2';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-activity',
  groups: ['reviewers'],
};

const SNAPSHOT = {
  name: 'Lease review',
  clauses: [{ id: 'c1', title: 'Liability cap' }, { id: 'c2', title: 'Governing law' }],
};

async function aUser(t: Tx, id: string, subject: string): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [id, WS, subject]);
}

async function aMatterAndReview(t: Tx, matterId: string, reviewId: string): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now()) on conflict (id) do nothing`, [matterId, WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, $4::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [reviewId, WS, matterId, JSON.stringify(SNAPSHOT)]);
}

async function aDisposition(
  t: Tx, reviewId: string, clauseId: string, to: string, by: string,
  cause: 'human' | 'rerun_reset' = 'human', at = 'now()',
): Promise<void> {
  await t.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, reason,
        cause, by_user_id, at)
     values ($1, 'd1', $2, $3, 'unchecked', $4, $5, $6, $7, ${at})`,
    [reviewId, clauseId, WS, to, to === 'rejected' ? 'The cap is uncapped.' : null, cause, by]);
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

const feed = async (app: FastifyInstance, url: string): Promise<MatterActivityPage> =>
  (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer t' } }))
    .json() as MatterActivityPage;

describe('a matter s activity, from three records', () => {
  it('reads a disposition change from finding_disposition_event, not from audit_event',
    async () => {
      await withPg(async t => {
        await aUser(t, TRAINEE, 's-trainee');
        await aUser(t, PARTNER, 's-partner');
        await aMatterAndReview(t, 'am1', 'ar1');
        await aDisposition(t, 'ar1', 'c1', 'rejected', PARTNER);
        const app = harness(t);

        const page = await feed(app, '/v1/matters/am1/activity');
        expect(page.rows.some(r => r.kind === 'rejected' && r.byUserId === PARTNER)).toBe(true);
        expect(page.rows[0]!.source).toBe('disposition');
        expect(page.rows[0]!.clauseTitle).toBe('Liability cap');
        expect(page.rows[0]!.reviewName).toBe('Lease review');

        // S22's absence, asserted rather than assumed: the same act must not
        // be in the audit log too, or the feed shows it twice and an auditor
        // reconciling two logs finds a discrepancy that is really a
        // duplicate.
        const audits = await t.query(
          "select 1 from audit_event where action like 'finding%' or action like '%disposition%'");
        expect(audits).toHaveLength(0);
        await app.close();
      });
    });

  it('names both people in a contested finding, not just the local one', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aUser(t, PARTNER, 's-partner');
      await aMatterAndReview(t, 'am2', 'ar2');
      await aDisposition(t, 'ar2', 'c1', 'verified', TRAINEE, 'human', "now() - interval '1 min'");
      await aDisposition(t, 'ar2', 'c1', 'rejected', PARTNER);
      const app = harness(t);

      const page = await feed(app, '/v1/matters/am2/activity');
      const capped = page.rows.filter(r => r.clauseTitle === 'Liability cap');
      expect(new Set(capped.map(r => r.byUserId))).toEqual(new Set([TRAINEE, PARTNER]));
      await app.close();
    });
  });

  it('reads an audited act and a run, in one ordered list with the dispositions', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aMatterAndReview(t, 'am3', 'ar3');
      await t.query(
        `insert into audit_event (workspace_id, actor_user_id, action, subject_type, subject_id,
                                  matter_id)
         values ($1, $2, 'document.added', 'document', 'd1', 'am3')`, [WS, TRAINEE]);
      await t.query(
        `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency,
                          started_at)
         values ('run-a3', 'ar3', $1, 'succeeded', $2, 4, now())`, [WS, TRAINEE]);
      await aDisposition(t, 'ar3', 'c2', 'flagged', TRAINEE);
      const app = harness(t);

      const page = await feed(app, '/v1/matters/am3/activity');
      expect(new Set(page.rows.map(r => r.source))).toEqual(
        new Set(['disposition', 'audit', 'run']));
      // ONE statement, ordered in SQL. Three queries merged in TypeScript
      // would apply the limit after the merge, which reads the whole of
      // every source.
      for (let i = 1; i < page.rows.length; i++) {
        expect(page.rows[i - 1]!.at).toBeGreaterThanOrEqual(page.rows[i]!.at);
      }
      await app.close();
    });
  });

  it('every entry carries a finite timestamp, rather than being dated now', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aMatterAndReview(t, 'am4', 'ar4');
      // A queued run has no `started_at`. `coalesce(started_at, created_at)`
      // is what keeps it in the feed with a real instant instead of a null
      // that would sort first and render as 1970.
      await t.query(
        `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
         values ('run-a4', 'ar4', $1, 'queued', $2, 4)`, [WS, TRAINEE]);
      const app = harness(t);

      const page = await feed(app, '/v1/matters/am4/activity');
      expect(page.rows).toHaveLength(1);
      expect(page.rows.every(r => Number.isFinite(r.at) && r.at > 0)).toBe(true);
      await app.close();
    });
  });

  it('scopes to the matter, and to the workspace', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aMatterAndReview(t, 'am5', 'ar5');
      await aMatterAndReview(t, 'am6', 'ar6');
      await aDisposition(t, 'ar5', 'c1', 'verified', TRAINEE);
      await aDisposition(t, 'ar6', 'c1', 'rejected', TRAINEE);
      const app = harness(t);

      const page = await feed(app, '/v1/matters/am5/activity');
      expect(page.rows.map(r => r.kind)).toEqual(['verified']);

      // …and a caller from another firm gets 404, never an empty feed:
      // "nothing has happened here" and "this is not yours" are different
      // facts, and only the first is an answer.
      const foreign = harness(t, OTHER_WS);
      const res = await foreign.inject({
        method: 'GET', url: '/v1/matters/am5/activity',
        headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('"rows"');
      await app.close();
      await foreign.close();
    });
  });

  it('carries a re-run s cause, so the browser cannot flatten it', async () => {
    await withPg(async t => {
      await aUser(t, TRAINEE, 's-trainee');
      await aMatterAndReview(t, 'am7', 'ar7');
      await aDisposition(t, 'ar7', 'c1', 'unchecked', TRAINEE, 'rerun_reset');
      const app = harness(t);

      const page = await feed(app, '/v1/matters/am7/activity');
      // §6.3: a re-run is not a person un-verifying something, and the fact
      // that tells them apart is the cause. Dropping it here would make the
      // two indistinguishable downstream with nothing failing.
      expect(page.rows[0]).toMatchObject({ kind: 'unchecked', cause: 'rerun_reset' });
      await app.close();
    });
  });

  it('names a clause the playbook no longer holds by its id, rather than dropping the row',
    async () => {
      await withPg(async t => {
        await aUser(t, TRAINEE, 's-trainee');
        await aMatterAndReview(t, 'am8', 'ar8');
        await aDisposition(t, 'ar8', 'c-removed', 'verified', TRAINEE);
        const app = harness(t);

        const page = await feed(app, '/v1/matters/am8/activity');
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]!.clauseId).toBe('c-removed');
        expect('clauseTitle' in page.rows[0]!).toBe(false);
        await app.close();
      });
    });
});
