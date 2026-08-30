import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
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
      ];

      let version: number | undefined;
      for (const [i, write] of writes.entries()) {
        const saved = await h.put({ ...REVIEW(write), ...(version ? { version } : {}) });
        version = saved.version;
        const found = await reconcileFindings(t, 'sr1');
        expect(found, `write ${i}:\n${describeDiscrepancies(found)}`).toEqual([]);
      }

      // THE ONE KIND OF WRITE AFTER WHICH THE TWO NO LONGER AGREE — and it
      // is Task 14's ruling rather than a defect (`findings/write.ts` has
      // the long form): a body that omits a key is a body that is BEHIND,
      // so the ROW stays and it is the blob that has lost something. This
      // used to be two more entries in the list above ("clauseRemovedSave"
      // and an empty findings map) and they reconciled clean only because
      // the shadow writer deleted the rows to match.
      //
      // Asserted here rather than deleted, because "the rows stay equal to
      // the blob after every kind of write" stops being the whole truth at
      // exactly this point, and a reader of this suite has to be told where.
      const dropped = await h.put({
        ...REVIEW({ findings: { d1: { c1: finding({ summary: 'A second answer.' }) } } }),
        version,
      });
      expect(dropped.version).toBeGreaterThan(version!);
      const after = await reconcileFindings(t, 'sr1');
      expect(after.map(d => `${d.key}/${d.field}`).sort(),
        describeDiscrepancies(after)).toEqual(['d2/c1/disposition', 'd2/c1/finding']);
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

describe('a key the body no longer carries is KEPT, judgement, history and all', () => {
  /*
   * CHANGED TWICE, and both changes are rulings rather than repairs — so the
   * history of this assertion is worth reading before editing it again.
   *
   * It first asserted `eventCount(t, 'd2', 'c1') === 0`: the finding, its
   * disposition AND its history all cascading away when a save stopped
   * carrying the key. Migration 009 took the history out of that cascade,
   * because 006 calls that table "INSERT-only to every application role,
   * which is what makes it evidence rather than a claim" and a transitive
   * DELETE is a delete.
   *
   * TASK 14 TAKES THE REST OF IT OUT, and the reason is that the sentence
   * 005 justified the delete with — "a key absent from the blob is a
   * judgement that no longer exists in the record of truth either" — stops
   * being true the moment the reader flips. From this task on the ROWS are
   * the record of truth, so a body that omits a key is not a body saying the
   * key is gone; it is a body that is BEHIND. Part 3A's own gate named the
   * window: "a run started via the new route produces rows that the next
   * browser save would delete." `findings/write.ts` carries the full form.
   *
   * The next test is the other half, unchanged: deleting the whole REVIEW
   * still takes everything, because that is a whole-record deletion somebody
   * asked for.
   */
  it('keeps the finding, its disposition and its history when a save omits the key', async () => {
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

      const keys = await t.query<{ findings_key: string }>(
        'select findings_key from finding order by findings_key');
      expect(keys.map(k => k.findings_key)).toEqual(['d1', 'd2']);
      // The judgement survives — this is the assertion the ruling is about.
      expect((await t.query<{ state: string }>(
        "select state from finding_disposition where findings_key = 'd2'"))[0].state)
        .toBe('flagged');
      expect(await eventCount(t, 'd2', 'c1')).toBe(1);
      // …and the key the body DID carry is untouched by any of this.
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);
      expect((await t.query<{ state: string }>(
        "select state from finding_disposition where findings_key = 'd1'"))[0].state)
        .toBe('verified');
      await h.app.close();
    });
  });

  it('and the whole review going takes the history with it, which is the one deletion that should', async () => {
    // The other half of the rule above: the history is not immortal, it is
    // just not something a per-key shadow write may remove. A deleted review
    // is a deliberate, whole-record deletion by somebody who asked for it,
    // and that is the case 005's justification actually covers.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      await h.put(REVIEW({ findings: {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: PARTNER,
          at: 1_700_000_030_000 } }) },
      } }));
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);

      await t.query("delete from review where id = 'sr1'");
      expect(await t.query('select 1 from finding_disposition_event')).toEqual([]);
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

/**
 * M4: A VERIFICATION CARRYING A REASON WROTE A HISTORY ROW ON EVERY
 * AUTOSAVE.
 *
 * `readCell` kept `reason` for ANY state; `setDisposition` drops a reason on
 * anything but `rejected`. `writeDisposition` then compared the undropped
 * blob value against the dropped stored one — `null === 'look at this'`,
 * false, forever. So a body carrying `{ state: 'flagged', reason: '…' }`
 * called `setDisposition` again on every whole-review save: `changed_count +
 * 1`, `version + 1`, and one more row in the INSERT-only evidence table.
 * The browser debounces one save roughly every two seconds during a run, so
 * a five-minute run produced about 150 spurious rows on that one clause and
 * the real change became unfindable — the exact outcome that function's own
 * docstring says it was designed to prevent.
 *
 * `reconcileFindings` compared `disposition.reason` for every state too, so
 * it reported a discrepancy on that key that no number of saves could clear:
 * the reconciliation that PROVES the shadow write is correct was
 * permanently red for such a review.
 *
 * The shipped browser's `applyVerification` drops the reason, so this was
 * not reachable from today's UI. It was one hand-written `PUT
 * /v1/reviews/:id` away — and Stage 3's whole premise is that the API is the
 * contract, not the browser.
 */
describe('a reason on a state that does not take one settles, rather than repeating forever', () => {
  const flaggedWithReason = () => finding({ verification: {
    state: 'flagged', reason: 'look at this', byUserId: PARTNER, at: 1_700_000_009_000 } });

  it('writes ONE event for a flagged verification carrying a reason, however many saves follow', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);

      const first = await h.put(REVIEW({ findings: { d1: { c1: flaggedWithReason() } } }));
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);

      let version = first.version;
      for (const summary of ['a', 'b', 'c', 'd', 'e']) {
        const saved = await h.put({
          ...REVIEW({ findings: { d1: { c1: flaggedWithReason() },
            d2: { c1: finding({ summary }) } } }), version });
        version = saved.version;
      }
      // Six saves, one event. Before the fix this was six.
      expect(await eventCount(t, 'd1', 'c1')).toBe(1);
      const disposition = await t.query<{ state: string; reason: string | null; changed_count: number }>(
        "select state, reason, changed_count from finding_disposition where findings_key = 'd1'");
      expect(disposition[0]).toMatchObject({ state: 'flagged', reason: null, changed_count: 1 });
      await h.app.close();
    });
  });

  it('reconciles clean, rather than reporting a disposition.reason discrepancy forever', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      await h.put(REVIEW({ findings: { d1: { c1: flaggedWithReason() } } }));
      const found = await reconcileFindings(t, 'sr1');
      expect(found, describeDiscrepancies(found)).toEqual([]);
      await h.app.close();
    });
  });

  it('still keeps the reason on a REJECTED finding, which is the one state that takes one', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      await h.put(REVIEW({ findings: { d1: { c1: finding({ verification: {
        state: 'rejected', reason: 'The cap is in schedule 6.',
        byUserId: PARTNER, at: 1_700_000_009_000 } }) } } }));
      const disposition = await t.query<{ state: string; reason: string | null }>(
        "select state, reason from finding_disposition where findings_key = 'd1'");
      expect(disposition[0]).toEqual({ state: 'rejected', reason: 'The cap is in schedule 6.' });
      expect(await reconcileFindings(t, 'sr1')).toEqual([]);
      await h.app.close();
    });
  });
});

/**
 * n8: a save that changes nothing does not bump a finding's version.
 *
 * `version` is what an event carries so a client can drop a stale one, and
 * the browser autosaves the whole review roughly every two seconds while a
 * run is live. An unconditional `version = finding.version + 1` meant that
 * after one run a finding's version was dominated by saves that wrote the
 * identical row back — a version that moves when nothing moved says nothing.
 */
describe('an autosave that changes nothing leaves the version alone', () => {
  it('bumps a finding s version only when its content actually changed', async () => {
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const versionOf = async (): Promise<number> => Number((await t.query<{ version: string }>(
        "select version from finding where findings_key = 'd1' and clause_id = 'c1'"))[0].version);

      const first = await h.put(REVIEW({ findings: { d1: { c1: finding({ summary: 'six months' }) } } }));
      const before = await versionOf();

      // Two saves whose d1/c1 content is byte-identical.
      let version = first.version;
      for (const other of ['a', 'b']) {
        const saved = await h.put({
          ...REVIEW({ findings: { d1: { c1: finding({ summary: 'six months' }) },
            d2: { c1: finding({ summary: other }) } } }), version });
        version = saved.version;
      }
      expect(await versionOf()).toBe(before);

      // …and a real change still moves it.
      await h.put({
        ...REVIEW({ findings: { d1: { c1: finding({ summary: 'twelve months' }) } } }), version });
      expect(await versionOf()).toBe(before + 1);
      await h.app.close();
    });
  });
});

/**
 * n5: the upsert's own silent failure.
 *
 * `on conflict … do update … where finding.workspace_id = excluded.workspace_id`
 * performs NEITHER the insert nor the update when that predicate is false,
 * and Postgres reports success — a save that wrote nothing and said it
 * worked, which is the failure shape this whole file exists to prevent. The
 * row is unreachable in practice (review ids are unique), and it is refused
 * rather than trusted to stay that way.
 */
describe('a finding row that belongs to another workspace is refused, never silently skipped', () => {
  it('answers 400 naming the key rather than reporting a save that wrote nothing', async () => {
    // On the MIGRATOR connection, and only this test: reaching the state the
    // predicate guards needs a second workspace, and the app role holds no
    // insert grant on that table — which is itself why this is unreachable
    // in practice. What is under test is the service's refusal, not a
    // grant; every other test in this file runs as the app role.
    await withPg(async t => {
      await aUser(t, PARTNER, 'P Partner');
      await aMatterAndDocuments(t);
      const h = harness(t, PARTNER);
      const first = await h.put(REVIEW());

      // A second workspace, and this review's finding row moved into it —
      // the state the predicate exists for, reached the only way it can be.
      const other = '00000000-0000-0000-0000-0000000000ff';
      await t.query(
        "insert into workspace (id, name) values ($1, 'Other firm') on conflict (id) do nothing",
        [other]);
      await t.query(
        "update finding set workspace_id = $1 where review_id = 'sr1'", [other]);

      const res = await h.raw({ ...REVIEW(), version: first.version });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('d1/c1');
      expect(res.body).toMatch(/different workspace/);
      await h.app.close();
    }, migratorDb());
  });
});
