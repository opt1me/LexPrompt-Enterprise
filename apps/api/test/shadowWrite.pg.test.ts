import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Review } from '../src/db/rows.ts';
import { describeDiscrepancies, reconcileFindings } from '../src/findings/reconcile.ts';

/**
 * The shadow writer (P17): the `finding`, `finding_disposition` and `note`
 * rows are written in the SAME transaction as the findings blob, so the two
 * cannot diverge even under a crash — and `reconcileFindings` is what proves
 * it, key by key, after every kind of write a browser performs.
 *
 * This is the task's whole reason for existing. Task 6 built rows for every
 * review that existed; without this they would go stale the moment anybody
 * verified anything, and the flip in Task 14 would read a stale answer with
 * this application's full authority.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-shadow',
  groups: ['reviewers'],
};

/** The reviewer these bodies attribute their judgements to. A real
 *  `app_user`, because a verification and a note are rows now and their author
 *  is a foreign key. */
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

const finding = (over: Record<string, unknown> = {}) => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4 }],
  verification: { state: 'unchecked' },
  notes: [],
  ...over,
});

const REVIEW = (over: Record<string, unknown> = {}) => ({
  id: 'sr1',
  matterId: 'sm1',
  playbookSnapshot: SNAPSHOT,
  documentIds: ['d1', 'd2'],
  target: { kind: 'documents', documentIds: ['d1', 'd2'] },
  findings: { d1: { c1: finding() } },
  modelId: 'test/model',
  startedAt: 1_700_000_000_000,
  createdByUserId: '',
  ...over,
});

interface Harness {
  app: FastifyInstance;
  put(body: unknown): Promise<Review>;
  raw(body: unknown): Promise<{ statusCode: number; json(): any; body: string }>;
}

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: { id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS },
  });
  const inject = (body: unknown) => app.inject({
    method: 'PUT', url: '/v1/reviews/sr1',
    headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    async put(body) {
      const res = await inject(body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Review;
    },
    raw: body => inject(body) as never,
  };
}

const eventCount = async (t: Tx, key: string, clause: string): Promise<number> =>
  Number((await t.query<{ n: string }>(
    `select count(*)::text n from finding_disposition_event
     where review_id = 'sr1' and findings_key = $1 and clause_id = $2`, [key, clause]))[0].n);

describe('the rows stay equal to the blob, through every kind of write', () => {
  it('leaves the rows equal to the blob after every kind of write', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aUser(t, TRAINEE, 'T Trainee');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);

      const verified = finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_009_000 } });
      const netPosition = {
        proposed: 'A rolling break on six months notice.', state: 'unconfirmed',
        trail: [{ documentId: 'd1', kind: 'original', effect: 'Grants it.', citations: [] }],
      };

      const writes: Record<string, unknown>[] = [
        // initialSave — a run that has produced nothing yet.
        { findings: { d1: { c1: finding({ status: 'pending', citations: [], summary: undefined }) },
          d2: { c1: finding({ status: 'pending', citations: [] }) } } },
        // midRunSave — one cell finished, with a risk level and a truncation.
        { findings: {
          d1: { c1: finding({ riskLevel: 'High', riskAnalysis: 'Uncapped.', truncated: true }) },
          d2: { c1: finding({ status: 'running' }) } } },
        // verifySave — a person recorded a judgement.
        { findings: { d1: { c1: verified }, d2: { c1: finding() } } },
        // a rejection, with its reason.
        { findings: { d1: { c1: finding({ verification: { state: 'rejected', byUserId: TRAINEE,
          at: 1_700_000_010_000, reason: 'The cap is in the sixth schedule.' } }) },
        d2: { c1: finding() } } },
        // noteSave.
        { findings: { d1: { c1: finding({ verification: { state: 'rejected', byUserId: TRAINEE,
          at: 1_700_000_010_000, reason: 'The cap is in the sixth schedule.' },
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked against the deed.',
          byUserId: PARTNER, at: 1_700_000_011_000 }] }) },
        d2: { c1: finding() } } },
        // a net position, and a position outcome.
        { findings: { d1: { c1: finding({ netPosition, positionOutcome: 'deviates',
          positionRationale: 'The firm requires a cap.' }) }, d2: { c1: finding() } } },
        // rerunSave — the clause was re-run, so the verification is cleared
        // and the net position with it.
        { findings: { d1: { c1: finding({ summary: 'A second answer.' }) }, d2: { c1: finding() } } },
        // clauseRemovedSave — the whole d2 key goes.
        { findings: { d1: { c1: finding({ summary: 'A second answer.' }) } } },
        // …and an empty findings map, which is what a review whose clauses
        // were all removed looks like.
        { findings: {} },
      ];

      let version: number | undefined;
      for (const [i, write] of writes.entries()) {
        const saved = await h.put({ ...REVIEW(write), ...(version ? { version } : {}) });
        version = saved.version;
        const found = await reconcileFindings(t, 'sr1');
        expect(found, `write ${i}:\n${describeDiscrepancies(found)}`).toEqual([]);
      }
      await h.app.close();
    });
  });

  it('appends no history row when a whole-review save repeats an unchanged verification', async () => {
    // The debounced saver writes the WHOLE record every two seconds during a
    // run. A translation that appended an event each time would fill the
    // history with a hundred identical rows and make the one real change
    // unfindable.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const verified = finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_009_000 } });

      const first = await h.put(REVIEW({ findings: { d1: { c1: verified } } }));
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);

      // Three autosaves that change only the summary of another cell.
      let version = first.version;
      for (const summary of ['a', 'b', 'c']) {
        const saved = await h.put({
          ...REVIEW({ findings: { d1: { c1: verified },
            d2: { c1: finding({ summary }) } } }), version });
        version = saved.version;
      }
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);
      await h.app.close();
    });
  });
});

describe('a verification in the body becomes a disposition, and exactly one event', () => {
  it('records the human s own instant, not the moment their browser autosaved', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aUser(t, TRAINEE, 'T Trainee');
      await aMatterAndDocuments(t);
      const h = harness(t, TRAINEE);
      // NOTE the actor: the trainee's browser is doing the saving, and the
      // judgement is the partner's. The row must name the partner.
      await h.put(REVIEW({ findings: { d1: { c1: finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_009_000 } }) } } }));

      const rows = await t.query<{ state: string; by_user_id: string; at: Date; changed_count: number }>(
        `select state, by_user_id::text as by_user_id, at, changed_count
         from finding_disposition where review_id = 'sr1'`);
      expect(rows[0].state).toBe('verified');
      expect(rows[0].by_user_id).toBe(PARTNER);
      expect(rows[0].at.getTime()).toBe(1_700_000_009_000);
      expect(rows[0].changed_count).toBe(1);

      const events = await t.query<{ from_state: string; to_state: string; cause: string; at: Date }>(
        "select from_state, to_state, cause, at from finding_disposition_event where clause_id = 'c1'");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from_state: 'unchecked', to_state: 'verified', cause: 'human' });
      expect(events[0].at.getTime()).toBe(1_700_000_009_000);
      await h.app.close();
    });
  });

  it('REFUSES a verification that names nobody, rather than attributing it to whoever saved', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const res = await h.raw(REVIEW({ findings: { d1: { c1: finding({
        verification: { state: 'verified', at: 1_700_000_009_000 } }) } } }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/is verified but names nobody/);
      // …and NOTHING was written, blob included: the shadow write is inside
      // the same transaction as the review upsert.
      expect(await t.query("select 1 from review where id = 'sr1'")).toEqual([]);
      await h.app.close();
    });
  });

  it('REFUSES a note whose author is not a user of this workspace', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const res = await h.raw(REVIEW({ findings: { d1: { c1: finding({
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'x', byUserId: 'u-human', at: 1 }] }) } } }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/who is not a user of this workspace/);
      expect(await t.query("select 1 from review where id = 'sr1'")).toEqual([]);
      await h.app.close();
    });
  });

  it('REFUSES a collection review keyed by one of its documents rather than the collection', async () => {
    // `findingsKeyFor` is the only place a findings key is decided, and this
    // is the shape of the six defects in sub-project C arriving as a request
    // body. Note what is NOT re-checked: anything outside the body. A
    // self-consistent review passes this forever, whatever else changes —
    // which is the distinction C1's permanently-unsavable review turned on.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const res = await h.raw(REVIEW({
        target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
        findings: { d1: { c1: finding() } },
      }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/keys its findings by the collection/);
      await h.app.close();
    });
  });

  it('writes no rows at all when the save is REFUSED as stale', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const first = await h.put(REVIEW({ findings: { d1: { c1: finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_009_000 } }) } } }));
      await h.put({ ...REVIEW({ findings: { d1: { c1: finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_009_000 } }) } } }),
      version: first.version });

      // A stale run save that would have cleared the verification.
      const res = await h.raw({ ...REVIEW({ findings: { d1: { c1: finding() } } }),
        version: first.version });
      expect(res.statusCode).toBe(409);
      const rows = await t.query<{ state: string }>(
        "select state from finding_disposition where review_id = 'sr1'");
      expect(rows[0].state).toBe('verified');
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);
      await h.app.close();
    });
  });
});

describe('re-running a clause resets its verification and its net position, in the rows too', () => {
  it('clears the disposition and the net position, and records that it cleared', async () => {
    // The behaviour CLAUDE.md calls load-bearing and mutation-tests against
    // the blob, asserted here against the ROWS: an export that read the rows
    // must not be able to claim a human checked text they never saw.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);

      const confirmed = {
        proposed: 'A rolling break on six months notice.',
        state: 'confirmed', byUserId: PARTNER, at: 1_700_000_020_000,
        trail: [{ documentId: 'd1', kind: 'original', effect: 'Grants it.', citations: [] }],
      };
      const first = await h.put(REVIEW({ findings: { d1: { c1: finding({
        verification: { state: 'verified', byUserId: PARTNER, at: 1_700_000_021_000 },
        netPosition: confirmed,
      }) } } }));
      const before = await t.query<{ state: string; net: { state: string } }>(
        `select d.state, f.net_position as net from finding_disposition d
         join finding f on f.review_id = d.review_id and f.findings_key = d.findings_key
          and f.clause_id = d.clause_id where d.review_id = 'sr1'`);
      expect(before[0].state).toBe('verified');
      expect(before[0].net.state).toBe('confirmed');

      // The retry: `resetVerification` and `resetPosition` have run in the
      // browser, so the blob carries an unchecked verification and an
      // unconfirmed position over new text.
      await h.put({ ...REVIEW({ findings: { d1: { c1: finding({
        summary: 'A second, different answer.',
        netPosition: { proposed: 'A different synthesis.', state: 'unconfirmed', trail: [] },
      }) } } }), version: first.version });

      const after = await t.query<{ state: string; by_user_id: string | null; net: { state: string } }>(
        `select d.state, d.by_user_id::text as by_user_id, f.net_position as net
         from finding_disposition d
         join finding f on f.review_id = d.review_id and f.findings_key = d.findings_key
          and f.clause_id = d.clause_id where d.review_id = 'sr1'`);
      expect(after[0].state, 'a re-run left a verification standing over replaced text')
        .toBe('unchecked');
      expect(after[0].net.state, 'a re-run left a confirmed net position over a new synthesis')
        .toBe('unconfirmed');
      // …and the clearing is in the history, so a current state whose history
      // does not explain it cannot exist.
      const events = await t.query<{ from_state: string; to_state: string }>(
        `select from_state, to_state from finding_disposition_event
         where clause_id = 'c1' order by id`);
      expect(events).toEqual([
        { from_state: 'unchecked', to_state: 'verified' },
        { from_state: 'verified', to_state: 'unchecked' },
      ]);
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);
      await h.app.close();
    });
  });
});

describe('a key the body no longer carries leaves no orphan', () => {
  it('deletes the finding, its disposition and its history when a clause is removed', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const first = await h.put(REVIEW({ findings: {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: PARTNER,
          at: 1_700_000_030_000 } }) },
        d2: { c1: finding({ verification: { state: 'flagged', byUserId: PARTNER,
          at: 1_700_000_031_000 } }) },
      } }));
      expect(await t.query('select 1 from finding')).toHaveLength(2);

      await h.put({ ...REVIEW({ findings: { d1: { c1: finding({ verification: {
        state: 'verified', byUserId: PARTNER, at: 1_700_000_030_000 } }) } } }),
      version: first.version });

      const keys = await t.query<{ findings_key: string }>('select findings_key from finding');
      expect(keys.map(k => k.findings_key)).toEqual(['d1']);
      expect(await eventCount(t, 'd2', 'c1')).toBe(0);
      // …and the surviving key kept its own judgement and its own history.
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);
      expect((await t.query<{ state: string }>(
        "select state from finding_disposition where findings_key = 'd1'"))[0].state)
        .toBe('verified');
      await h.app.close();
    });
  });
});

describe('the reconciliation can find something', () => {
  const corrupt = async (t: Tx, sql: string, expected: RegExp): Promise<void> => {
    await t.query(sql);
    const found = await reconcileFindings(t, 'sr1');
    expect(found.length, describeDiscrepancies(found)).toBeGreaterThan(0);
    expect(describeDiscrepancies(found)).toMatch(expected);
  };

  it('names the key and the field for every kind of corruption', async () => {
    // A reconciliation that has never been shown to FIND something is a
    // reconciliation that returns []. This project has shipped a scanner that
    // matched nothing.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      await h.put(REVIEW({ findings: {
        d1: { c1: finding({
          verification: { state: 'verified', byUserId: PARTNER, at: 1_700_000_040_000 },
          notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked against the deed.',
            byUserId: PARTNER, at: 1_700_000_041_000 }],
          netPosition: { proposed: 'p', state: 'unconfirmed', trail: [] },
        }) },
        d2: { c1: finding({ summary: 'Another answer.' }) },
      } }));
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
      await h.app.close();
    });
  });

  it('finds a verification that landed on the WRONG KEY, which a count check cannot see', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aUser(t, TRAINEE, 'T Trainee');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      await h.put(REVIEW({ findings: {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: PARTNER,
          at: 1_700_000_050_000 } }) },
        d2: { c1: finding({ verification: { state: 'rejected', byUserId: TRAINEE,
          at: 1_700_000_051_000, reason: 'Wrong schedule.' } }) },
      } }));
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);

      await t.query(`
        update finding_disposition d
           set state = s.state, reason = s.reason, by_user_id = s.by_user_id, at = s.at
          from (select findings_key, state, reason, by_user_id, at from finding_disposition
                where review_id = 'sr1') s
         where d.review_id = 'sr1'
           and d.findings_key = case s.findings_key when 'd1' then 'd2' else 'd1' end`);
      // The count of non-unchecked dispositions is unchanged: two before, two
      // after. Only a key-by-key comparison sees this.
      expect((await t.query<{ n: string }>(
        "select count(*)::text n from finding_disposition where state <> 'unchecked'"))[0].n)
        .toBe('2');

      const found = await reconcileFindings(t, 'sr1');
      expect(describeDiscrepancies(found)).toMatch(/d1\/c1: disposition\.state/);
      expect(describeDiscrepancies(found)).toMatch(/d2\/c1: disposition\.state/);
      await h.app.close();
    });
  });
});

class Rollback extends Error {}
function swallow(err: unknown): void { if (!(err instanceof Rollback)) throw err; }
