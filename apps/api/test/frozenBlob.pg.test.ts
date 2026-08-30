import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { seedFindingRows } from './helpers/seedFindings.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Review } from '../src/db/rows.ts';
import {
  describeDiscrepancies, readFindingsBlob, reconcileFindings,
} from '../src/findings/reconcile.ts';

/**
 * `review.findings` IS FROZEN, NOT DROPPED (Task 22, P18) — and the
 * reconciler that reads it still works.
 *
 * ## What this file replaces
 *
 * It was `shadowWrite.pg.test.ts`, and it proved P17: the `finding`,
 * `finding_disposition` and `note` rows were written in the SAME transaction
 * as the findings blob, so the two could not diverge even under a crash.
 * That was the whole of Part 3A's safety argument — there was never only one
 * copy of a judgement inside the change that altered it.
 *
 * The shadow writer is deleted with the blob write it shadowed. Most of what
 * was here went with it, and that is right: those tests drove
 * `writeFindingRows`, which no longer exists, and the claims they made about
 * a verification arriving in a PUT body are claims about a request the route
 * now REFUSES. Each surviving claim moved to where the thing it is about
 * lives —
 *
 *  - a verification's own instant, and one event per real change:
 *    `dispositionRoutes.pg.test.ts`;
 *  - the re-run reset clearing a disposition and a net position in one
 *    transaction: `rerunReset.pg.test.ts`;
 *  - a stale save being refused, and a body carrying findings being refused:
 *    `reviews.pg.test.ts`;
 *  - a finding's shape as a reader sees it: `findingsRead.pg.test.ts`.
 *
 * ## What is here
 *
 * The two things that are only true from Task 22 onward:
 *
 *  1. **The freeze is real**, asked of the database as the role a request
 *     runs as. `revoke update (findings)` against a table-level grant is a
 *     NO-OP in Postgres — no error, no warning — so this is the assertion
 *     that tells a freeze that froze something from one that did not.
 *  2. **`reconcileFindings` still answers**, over a blob written before the
 *     freeze, and can still FIND something. It is the one tool for a future
 *     doubt about the migration and it works for exactly as long as the
 *     column exists (interface note 11).
 *
 * ## The window this closes
 *
 * A review created after the freeze has real rows and an empty blob, and
 * `reconcileFindings` correctly calls every one of its findings "a row the
 * blob no longer has". That is not a loss; it is what a frozen backup looks
 * like once the record has moved on. **The reconciler answers "did the shred
 * lose anything?" as at the moment of the freeze**, which is why Task 26
 * runs it over the whole corpus once, now.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-frozen',
  groups: ['reviewers'],
};

const PARTNER = '00000000-0000-0000-0000-0000000000b1';
const TRAINEE = '00000000-0000-0000-0000-0000000000b2';

async function aUser(t: Tx, id: string, name: string): Promise<string> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, $4, 'XX', 'reviewer', 'active') on conflict (id) do nothing`,
    [id, WS, `sub-${id}`, name]);
  return id;
}

async function aMatterAndDocuments(t: Tx): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('sm1', $1, 'Brookvale', now(), now())`, [WS]);
  for (const id of ['d1', 'd2']) {
    await t.query(
      `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                             byte_size, mime, blob_key, role, added_at)
       values ($1, $2, 'matter', 'sm1', $3, 'pdf', 'x', 'parsed', 4, 'application/pdf', $4,
               'standalone', now())`,
      [id, WS, `${id}.pdf`, `workspace/${WS}/document/${id}`]);
  }
}

const SNAPSHOT = { id: 'v1', name: 'Lease', clauses: [{ id: 'c1', title: 'Break' }] };
const TARGET = { kind: 'documents' as const, documentIds: ['d1', 'd2'] };

const finding = (over: Record<string, unknown> = {}) => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4 }],
  verification: { state: 'unchecked' },
  notes: [],
  ...over,
});

/**
 * A review as it existed BEFORE the freeze: a real blob in the column, and
 * rows built from it.
 *
 * The review row is INSERTed directly rather than PUT, and both halves of
 * that are the point. `update review set findings = …` is refused for the
 * app role by migration 010 — the freeze biting — and the route has carried
 * no findings since Task 14. An INSERT still may, deliberately (010's own
 * note): the verb that could destroy a pre-migration backup is UPDATE, and a
 * suite that reconciles the frozen blob has to be able to construct one.
 */
async function aPreFreezeReview(
  t: Tx, blob: unknown, target: unknown = TARGET,
): Promise<void> {
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids, target,
                         findings, model_id, started_at)
     values ('sr1', $1, 'sm1', $2::jsonb, '["d1","d2"]'::jsonb, $3::jsonb, $4::jsonb,
             'test/model', now())`,
    [WS, JSON.stringify(SNAPSHOT), JSON.stringify(target), JSON.stringify(blob)]);
  await seedFindingRows(t, 'sr1', WS, target, blob, PARTNER);
}

interface Harness {
  app: FastifyInstance;
  raw(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: { id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS },
  });
  return {
    app,
    raw: (method, url, body) => app.inject({
      method, url, headers: { authorization: 'Bearer t' }, payload: body as never,
    }) as never,
  };
}

/* ------------------------------------------------------------------ *
 *  1. The freeze is real                                              *
 * ------------------------------------------------------------------ */

describe('no application role can UPDATE review.findings', () => {
  it('refuses the app role, and allows it every other column — the pairing is the test', async () => {
    /*
     * THE ASSERTION THAT TELLS A FREEZE FROM A NO-OP.
     *
     * `revoke update (findings) on review from lexprompt_app` does NOTHING
     * when the role holds a table-level UPDATE, which 002 granted: Postgres
     * keeps table privileges in `relacl` and column privileges in `attacl`,
     * and a column-level revoke only removes from the second. No error and
     * no warning. So 010 revokes the table-level grant and names every
     * column but `findings` — and this attempts both halves, because a
     * refusal with no paired success would also be what a `review` table
     * that did not exist produced.
     */
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      await aPreFreezeReview(t, { d1: { c1: finding() } });
      // INSIDE A NESTED `tx` — which `pool.ts` turns into a SAVEPOINT. A
      // permission error aborts the whole transaction otherwise, and every
      // statement after it comes back "current transaction is aborted",
      // including the paired success below. That would still have failed,
      // but for the wrong reason and with a message pointing nowhere.
      await expect(t.tx(tt =>
        tt.query("update review set findings = '{}'::jsonb where id = 'sr1'")))
        .rejects.toThrow(/permission denied/i);
      await expect(t.query("update review set model_id = 'another' where id = 'sr1'"))
        .resolves.toBeDefined();
    });
  });

  it('says so in the catalogue too, for every column and both roles', async () => {
    /*
     * The same fact read from `pg_attribute` rather than by attempting it —
     * the reading that would notice a grant made to a role `lexprompt_app`
     * INHERITS from, which an attempted statement cannot distinguish from a
     * direct one.
     *
     * Asserted as the WHOLE SET rather than as one column, so a `review`
     * column added by a later migration without its grant fails here by
     * name rather than at run time in front of a reviewer.
     */
    const rows = await migratorDb().query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_attribute a
        where a.attrelid = 'review'::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('lexprompt_app', a.attrelid, a.attnum, 'update')
        order by a.attnum`);
    const updatable = rows.map(r => r.column_name);
    expect(updatable).toEqual([
      'id', 'workspace_id', 'matter_id', 'playbook_snapshot', 'playbook_version_id',
      'document_ids', 'target', 'model_id', 'started_at', 'completed_at', 'cancelled_at',
      'created_by_user_id', 'version',
    ]);
    expect(updatable, 'the freeze is a no-op').not.toContain('findings');

    // The worker holds `select on review` and nothing more (005), so it has
    // no UPDATE of its own to revoke. Paired with a column it CAN read, so a
    // query that always answered `false` would fail here.
    const worker = await migratorDb().query<{ upd: boolean; sel: boolean }>(
      `select has_column_privilege('lexprompt_worker', 'review', 'findings', 'update') as upd,
              has_column_privilege('lexprompt_worker', 'review', 'target', 'select') as sel`);
    expect(worker[0]).toEqual({ upd: false, sel: true });
  });

  it('leaves the blob byte-identical across a whole-review save', async () => {
    // The observable form of the two above: a save that touches the record
    // does not touch the backup. `version` is read alongside the checksum
    // because a browser holds that token — a write that bumped it would make
    // the next save from a live tab fail as stale with no visible cause.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const blob = { d1: { c1: finding({
        verification: { state: 'verified', byUserId: PARTNER, at: 1_700_000_040_000 },
      }) } };
      await aPreFreezeReview(t, blob);
      const read = async () => (await t.query<{ md5: string }>(
        "select md5(findings::text) md5 from review where id = 'sr1'"))[0].md5;
      const before = await read();
      expect(before).toMatch(/^[0-9a-f]{32}$/);

      const h = harness(t, PARTNER);
      const current = (await h.raw('GET', '/v1/reviews/sr1')).json() as Review;
      const res = await h.raw('PUT', '/v1/reviews/sr1', {
        id: 'sr1', matterId: 'sm1', playbookSnapshot: SNAPSHOT,
        documentIds: ['d1', 'd2'], target: TARGET, modelId: 'test/model',
        startedAt: 1_700_000_000_000, createdByUserId: '',
        completedAt: 1_700_000_090_000, version: current.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await read()).toBe(before);
      await h.app.close();
    });
  });
});

/* ------------------------------------------------------------------ *
 *  2. The reconciliation still answers                                *
 * ------------------------------------------------------------------ */

class Rollback extends Error {}
function swallow(err: unknown): void { if (!(err instanceof Rollback)) throw err; }

describe('the reconciliation can still find something, over a pre-freeze blob', () => {
  const corrupt = async (t: Tx, sql: string, expected: RegExp): Promise<void> => {
    await t.query(sql);
    const found = await reconcileFindings(t, 'sr1');
    expect(found.length, describeDiscrepancies(found)).toBeGreaterThan(0);
    expect(describeDiscrepancies(found)).toMatch(expected);
  };

  it('names the key and the field for every kind of corruption', async () => {
    // A reconciliation that has never been shown to FIND something is a
    // reconciliation that returns []. This project has shipped a scanner
    // that matched nothing.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      await aPreFreezeReview(t, {
        d1: { c1: finding({
          verification: { state: 'verified', byUserId: PARTNER, at: 1_700_000_040_000 },
          notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked against the deed.',
            byUserId: PARTNER, at: 1_700_000_041_000 }],
          netPosition: { proposed: 'p', state: 'unconfirmed', trail: [] },
        }) },
        d2: { c1: finding({ summary: 'Another answer.' }) },
      });
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);

      await t.tx(tt => corrupt(tt, "update finding set summary = 'rewritten' where findings_key = 'd1'",
        /d1\/c1: summary/).then(() => { throw new Rollback(); })).catch(swallow);
      await t.tx(tt => corrupt(tt, 'update finding set net_position = null',
        /net_position/).then(() => { throw new Rollback(); })).catch(swallow);
      await t.tx(tt => corrupt(tt, "update finding set citations = '[]'::jsonb",
        /citations/).then(() => { throw new Rollback(); })).catch(swallow);
      await t.tx(tt => corrupt(tt, "update finding_disposition set state = 'flagged', reason = null"
        + " where findings_key = 'd1'", /d1\/c1: disposition\.state/)
        .then(() => { throw new Rollback(); })).catch(swallow);
      await t.tx(tt => corrupt(tt, "delete from note where id = 'n1'", /d1\/c1\/n1: note/)
        .then(() => { throw new Rollback(); })).catch(swallow);
      await t.tx(tt => corrupt(tt, "delete from finding where findings_key = 'd2'",
        /d2\/c1: finding/).then(() => { throw new Rollback(); })).catch(swallow);

      // …and after all that rolling back, they still agree.
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);
      // ON THE MIGRATOR CONNECTION, for one of the six corruptions: migration
      // 011 took `delete on finding` away from `lexprompt_app`, and a
      // corruption no application role can produce is still a corruption the
      // reconciler has to be able to name. The reconciler itself reads the
      // same rows whichever role asks.
    }, migratorDb());
  });

  it('finds a verification that landed on the WRONG KEY, which a count check cannot see', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aUser(t, TRAINEE, 'T Trainee');
      await aMatterAndDocuments(t);
      await aPreFreezeReview(t, {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: PARTNER,
          at: 1_700_000_050_000 } }) },
        d2: { c1: finding({ verification: { state: 'rejected', byUserId: TRAINEE,
          at: 1_700_000_051_000, reason: 'Wrong schedule.' } }) },
      });
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);

      await t.query(`
        update finding_disposition d
           set state = s.state, reason = s.reason, by_user_id = s.by_user_id, at = s.at
          from (select findings_key, state, reason, by_user_id, at from finding_disposition
                where review_id = 'sr1') s
         where d.review_id = 'sr1'
           and d.findings_key = case s.findings_key when 'd1' then 'd2' else 'd1' end`);
      // The count of non-unchecked dispositions is unchanged: two before,
      // two after. Only a key-by-key comparison sees this.
      expect((await t.query<{ n: string }>(
        "select count(*)::text n from finding_disposition where state <> 'unchecked'"))[0].n)
        .toBe('2');

      const found = await reconcileFindings(t, 'sr1');
      expect(describeDiscrepancies(found)).toMatch(/d1\/c1: disposition\.state/);
      expect(describeDiscrepancies(found)).toMatch(/d2\/c1: disposition\.state/);
    });
  });

  it('says a review created AFTER the freeze has a blob that no longer describes it', async () => {
    /*
     * NOT A DEFECT, AND THE REASON IT IS ASSERTED RATHER THAN LEFT IMPLICIT.
     *
     * From the freeze onward the rows move and the blob does not, so a
     * review created by a run has real findings and an empty backup — and
     * the reconciler says so, by key, in the words a reader needs. Anyone
     * who runs it over the corpus in six months will see a long list, and
     * the list means "these post-date the freeze", not "the migration lost
     * something".
     */
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids,
                             target, model_id, started_at)
         values ('sr1', $1, 'sm1', $2::jsonb, '["d1","d2"]'::jsonb, $3::jsonb, 'm', now())`,
        [WS, JSON.stringify(SNAPSHOT), JSON.stringify(TARGET)]);
      await seedFindingRows(t, 'sr1', WS, TARGET, { d1: { c1: finding() } }, PARTNER);

      const found = await reconcileFindings(t, 'sr1');
      expect(describeDiscrepancies(found)).toMatch(/d1\/c1: finding/);
      expect(describeDiscrepancies(found)).toMatch(/a row the blob no longer has/);
    });
  });
});

/* ------------------------------------------------------------------ *
 *  3. The blob reader refuses what it cannot read faithfully          *
 * ------------------------------------------------------------------ */

describe('readFindingsBlob refuses rather than reporting agreement it cannot vouch for', () => {
  /*
   * These were route tests (`writeFindingRows` refused a body it could not
   * store) and they are unit tests now, because the reader's ONLY caller is
   * the reconciler. The claim is unchanged and it matters more, not less: a
   * blob this cannot read must produce a REFUSAL naming the cell, never an
   * empty discrepancy list — "the rows and the blob agree" is exactly the
   * sentence that must not be said by accident.
   */
  it('refuses a verification that names nobody, rather than attributing it to anybody', () => {
    expect(() => readFindingsBlob(
      { d1: { c1: finding({ verification: { state: 'verified', at: 1 } }) } }, TARGET))
      .toThrow(/is verified but names nobody/);
  });

  it('refuses a rejection with no reason, which is a silent disagreement', () => {
    expect(() => readFindingsBlob(
      { d1: { c1: finding({
        verification: { state: 'rejected', byUserId: PARTNER, at: 1 } }) } }, TARGET))
      .toThrow(/rejected with no reason/);
  });

  it('refuses a collection review keyed by one of its documents rather than the collection', () => {
    // `findingsKeyFor` is the only place a findings key is decided, and this
    // is the shape of the six defects in sub-project C.
    expect(() => readFindingsBlob(
      { d1: { c1: finding() } },
      { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] }))
      .toThrow(/keys its findings by the collection/);
  });

  it('refuses a note that names no author', () => {
    expect(() => readFindingsBlob(
      { d1: { c1: finding({ notes: [{ id: 'n1', findingId: 'd1::c1', text: 'x', at: 1 }] }) } },
      TARGET)).toThrow(/names no author/);
  });

  it('…and READS a well-formed blob, which is what makes the refusals about the blob', () => {
    // THE SANITY CHECK. Without it, a reader that threw on everything would
    // pass all four above.
    const cells = readFindingsBlob({ d1: { c1: finding({
      verification: { state: 'verified', byUserId: PARTNER, at: 1 },
    }) } }, TARGET);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ findingsKey: 'd1', clauseId: 'c1' });
    expect(cells[0].verification).toMatchObject({ state: 'verified', byUserId: PARTNER });
  });
});
