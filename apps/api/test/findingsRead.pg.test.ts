import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import { reconcileFindings, describeDiscrepancies } from '../src/findings/reconcile.ts';
import { seedFindingRows } from './helpers/seedFindings.ts';
import { setDisposition } from '../src/dispositions/service.ts';
import { readFindings } from '../src/findings/read.ts';

/**
 * TASK 14: FINDINGS ARE READ FROM ROWS.
 *
 * What this suite has to prove is not "the query returns rows". It is that
 * the SHAPE a caller sees is the shape `types.ts` declares — including every
 * absence that means something different from a null — and that the two
 * failures this flip could reintroduce cannot happen:
 *
 *  - a findings read that FAILED rendering as a review that found nothing
 *    (the founding defect, wearing this stage's clothes), and
 *  - a collection review's findings keyed by one of its documents rather
 *    than by the collection (R-C1; six defects in sub-project C).
 */

const WS = '00000000-0000-0000-0000-000000000001';
const HUMAN = '00000000-0000-0000-0000-0000000000a1';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-findings-read',
  groups: ['reviewers'],
};

async function aHuman(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 'the-human-read', 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [HUMAN, WS]);
}

async function aMatter(t: Tx): Promise<void> {
  await aHuman(t);
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('m1', $1, 'Brookvale', now(), now()) on conflict (id) do nothing`, [WS]);
}

async function aDocument(t: Tx, id: string): Promise<void> {
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', 'm1', $3, 'pdf', 'x', 'parsed', 4, 'application/pdf', $4,
             'standalone', now())`,
    [id, WS, `${id}.pdf`, `workspace/${WS}/document/${id}`]);
}

async function aCollection(t: Tx, id: string, base: string): Promise<void> {
  await t.query(
    `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                             varies_document_ids, created_at)
     values ($1, $2, 'm1', 'Lease and variations', $3, '[]'::jsonb, now())`,
    [id, WS, base]);
}

const SNAPSHOT = {
  id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'Lease',
  systemPrompt: 's', formatPrompt: 'f', changeSummary: '', publishedAt: 1,
  publishedByUserId: 'u1', schemaVersion: 7,
  clauses: [{ id: 'c1', title: 'Break', extractPrompt: 'What is the break right?' }],
};

const finding = (over: Record<string, unknown> = {}) => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4, clauseRef: '14.2' }],
  verification: { state: 'unchecked' },
  notes: [],
  ...over,
});

/**
 * TASK 22: NO `findings` KEY. The route refuses a body carrying any, because
 * the blob is frozen and each finding is its own row. The rows these tests
 * read are seeded by `seedFindingRows` — the state a finished run leaves
 * behind — rather than by a PUT that the shadow writer used to shred.
 */
const REVIEW = (over: Record<string, unknown> = {}) => ({
  id: 'r1', matterId: 'm1',
  playbookSnapshot: SNAPSHOT,
  documentIds: ['d1'],
  target: { kind: 'documents', documentIds: ['d1'] },
  modelId: 'test/model',
  startedAt: 1_700_000_000_000,
  createdByUserId: '',
  ...over,
});

const DOCS_TARGET = { kind: 'documents' as const, documentIds: ['d1'] };

/** Creates the review, then plants its findings AS ROWS. Two writes, because
 *  they are two writes in the product: a review record is created by one
 *  request and its findings are written by the run. */
async function aReviewWith(
  t: Tx, h: Harness, blob: unknown, over: Record<string, unknown> = {},
): Promise<any> {
  const review = REVIEW(over);
  const saved = await h.put('/v1/reviews/r1', review);
  await seedFindingRows(t, 'r1', WS, review.target, blob, HUMAN);
  return saved;
}

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  put(url: string, body: unknown): Promise<any>;
  raw(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: HUMAN, displayName: 'H Human', initials: 'HH', role: 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'PUT', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    async get(url) {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    async put(url, body) {
      const res = await inject('PUT', url, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

const read = (h: Harness) => h.get('/v1/reviews/r1/findings');

describe('the findings route assembles three tables into the shape every caller expects', () => {
  it('returns a verification from the disposition, and unchecked when nobody has touched it', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });

      // Nobody has touched it: `changed_count = 0`, so the reading is
      // `unchecked()` and it names nobody. §6.3.
      const before = await read(h);
      expect(before.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
      expect('byUserId' in before.findings.d1.c1.verification).toBe(false);

      // A real judgement, written through the one writer of the table.
      await t.query(
        `update finding_disposition set state = 'verified', by_user_id = $1,
                at = to_timestamp(1700000009), changed_count = 1, version = version + 1
          where review_id = 'r1' and findings_key = 'd1' and clause_id = 'c1'`, [HUMAN]);

      const after = await read(h);
      expect(after.findings.d1.c1.verification).toEqual({
        state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000,
      });
      await h.app.close();
    });
  });

  it('assembles a standalone finding with no netPosition key at all', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      const f = (await read(h)).findings.d1.c1;
      // `toEqual` cannot see the difference between an absent key and an
      // `undefined` one, and `structuredClone` — how the browser's own
      // snapshots are taken — preserves the second. `in` is the assertion
      // that means what this is about.
      expect('netPosition' in f).toBe(false);
      expect('positionOutcome' in f).toBe(false);
      expect('truncatedDocuments' in f).toBe(false);
      expect('edited' in f).toBe(false);
      expect('authError' in f).toBe(false);
      expect('truncated' in f).toBe(false);
      expect('noContent' in f).toBe(false);
      await h.app.close();
    });
  });

  it('assembles a collection finding under the COLLECTION key, not a document id', async () => {
    // R-C1 restated at the client/server boundary. Six defects in
    // sub-project C came from getting this wrong once.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      await aCollection(t, 'col-1', 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { 'col-1': { c1: finding({ netPosition: {
        text: 'Read in order, the tenant has a rolling break on six months notice.',
        state: 'unconfirmed', trail: [],
      } }) } }, {
        documentIds: ['d1', 'd2'],
        target: { kind: 'collection', collectionId: 'col-1', documentIds: ['d1', 'd2'] },
      });
      const page = await read(h);
      expect(Object.keys(page.findings)).toEqual(['col-1']);
      expect(page.findings['col-1'].c1.netPosition.state).toBe('unconfirmed');
      await h.app.close();
    });
  });

  it('carries notes with their author and instant, in order, and none for a finding with none', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: {
        c1: finding({ notes: [
          { id: 'n2', findingId: 'd1::c1', text: 'Second.', byUserId: HUMAN, at: 1_700_000_020_000 },
          { id: 'n1', findingId: 'd1::c1', text: 'First.', byUserId: HUMAN, at: 1_700_000_010_000 },
        ] }),
      } });
      const notes = (await read(h)).findings.d1.c1.notes;
      expect(notes.map((n: { text: string }) => n.text)).toEqual(['First.', 'Second.']);
      expect(notes[0]).toEqual({
        id: 'n1', findingId: 'd1::c1', text: 'First.', byUserId: HUMAN, at: 1_700_000_010_000,
      });
      await h.app.close();
    });
  });

  it('carries the disposition version, which is what a write has to state', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      expect((await read(h)).dispositionVersions).toEqual({ d1: { c1: 1 } });
      await t.query(
        `update finding_disposition set state = 'flagged', by_user_id = $1, at = now(),
                changed_count = 1, version = version + 1 where review_id = 'r1'`, [HUMAN]);
      expect((await read(h)).dispositionVersions).toEqual({ d1: { c1: 2 } });
      await h.app.close();
    });
  });

  it('does NOT synthesise an assigneeId (P24)', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding({
        verification: { state: 'flagged', byUserId: HUMAN, at: 1_700_000_009_000 },
      }) } });
      expect('assigneeId' in (await read(h)).findings.d1.c1.verification).toBe(false);
      await h.app.close();
    });
  });

  it('does not multiply a finding across its notes', async () => {
    // The lateral aggregate rather than a plain join: three notes must not
    // produce three findings, which a join would and which would be
    // invisible in a shape check that only looked at one of them.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding({ notes: [
        { id: 'n1', findingId: 'd1::c1', text: 'a', byUserId: HUMAN, at: 1 },
        { id: 'n2', findingId: 'd1::c1', text: 'b', byUserId: HUMAN, at: 2 },
        { id: 'n3', findingId: 'd1::c1', text: 'c', byUserId: HUMAN, at: 3 },
      ] }) } });
      const page = await read(h);
      expect(Object.keys(page.findings.d1)).toEqual(['c1']);
      expect(page.findings.d1.c1.notes).toHaveLength(3);
      await h.app.close();
    });
  });
});

describe('empty is not broken, at the new load path', () => {
  it('answers 404 for a review this workspace does not have, never an empty findings map', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t);
      const res = await h.raw('GET', '/v1/reviews/nope/findings');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/no such review/i);
      await h.app.close();
    });
  });

  it('answers an EMPTY map for a review that genuinely has no findings yet', async () => {
    // The other half, so the 404 above cannot be read as "any empty answer
    // is refused". A review created but never run has no findings, and that
    // is a fact rather than a failure.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await h.put('/v1/reviews/r1', REVIEW());
      expect(await read(h)).toMatchObject({ findings: {}, dispositionVersions: {} });
      await h.app.close();
    });
  });
});

describe('the review record itself no longer carries the blob to a reader', () => {
  it('omits findings from GET /v1/reviews/:id — absent, never an empty object', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      const review = await h.get('/v1/reviews/r1');
      expect('findings' in review).toBe(false);
      await h.app.close();
    });
  });

  it('serves the LISTING s findings from rows too, so position health cannot read a stale blob', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      // A judgement recorded in the ROWS and nowhere in the blob — which is
      // exactly what a disposition written through its own route is.
      await t.query(
        `update finding_disposition set state = 'verified', by_user_id = $1,
                at = to_timestamp(1700000009), changed_count = 1, version = version + 1
          where review_id = 'r1'`, [HUMAN]);
      const listed = await h.get('/v1/matters/m1/reviews');
      expect(listed[0].findings.d1.c1.verification.state).toBe('verified');
      await h.app.close();
    });
  });

  it('and the rows still reconcile against a blob that HAS one — the pre-freeze case', async () => {
    /*
     * TASK 22 CHANGED WHAT THIS CAN ASSERT, AND SAYING SO IS THE POINT.
     *
     * It used to save a review THROUGH the blob and check that the rows the
     * shadow writer produced agreed with it. The route refuses a body with
     * findings now and the column is frozen, so a review created today has
     * rows and an EMPTY blob — which `reconcileFindings` correctly reports
     * as "a row the blob no longer has". That is not a loss; it is what a
     * frozen backup looks like once the record has moved on.
     *
     * So the fixture plants the pre-freeze shape directly — a blob written
     * by a migrator-era INSERT, with rows built from it — and asserts what
     * the reconciler is FOR: that a review carrying a real blob still
     * reconciles clean against its rows, key by key and field by field.
     * That is the question P18 keeps the column to answer, and Task 26 asks
     * it once over the whole corpus.
     */
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      const blob = { d1: { c1: finding({
        verification: { state: 'rejected', reason: 'Wrong clause.', byUserId: HUMAN,
          at: 1_700_000_009_000 },
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked.', byUserId: HUMAN, at: 5 }],
      }) } };
      // THE REVIEW ROW IS INSERTED DIRECTLY, blob and all, because there is
      // no longer any other way to produce one. `update review set findings`
      // is refused for the app role by migration 010 — the freeze biting in
      // a test is the freeze working — and the route has never carried the
      // blob since Task 14. An INSERT still may, which is deliberate (010's
      // own note): the verb that could destroy a pre-migration backup is
      // UPDATE, and a suite that reconciles the frozen blob has to be able
      // to construct one.
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids,
                             target, findings, model_id, started_at)
         values ('r1', $1, 'm1', $2::jsonb, '["d1"]'::jsonb, $3::jsonb, $4::jsonb,
                 'test/model', now())`,
        [WS, JSON.stringify(SNAPSHOT), JSON.stringify(DOCS_TARGET), JSON.stringify(blob)]);
      await seedFindingRows(t, 'r1', WS, DOCS_TARGET, blob, HUMAN);

      const stored = (await t.query<{ findings: unknown }>(
        "select findings from review where id = 'r1'"))[0].findings as
        Record<string, Record<string, unknown>>;
      const rows = (await read(h)).findings;
      expect(rows).toEqual(stored);
      const found = await reconcileFindings(t, 'r1');
      expect(found, describeDiscrepancies(found)).toEqual([]);
      await h.app.close();
    });
  });
});

describe('a stale whole-review save can no longer destroy an authoritative row', () => {
  /*
   * TASK 14'S RULING ON `writeFindingRows`'s DELETE, and TASK 22 CLOSED IT
   * FROM THE OTHER END.
   *
   * The delete was correct while the blob was the record of truth and was
   * not correct afterwards, because a body that omits a key is a body that
   * is BEHIND — which is precisely what Part 3A's gate named as the window
   * Task 14 closed ("a run started via the new route produces rows that the
   * next browser save would delete"). Task 22 removed the whole path: a
   * whole-review save carries no findings, and one that tries is refused.
   *
   * Both halves are asserted, because the second does not make the first
   * redundant. `writeFindingRows` is deleted, but the rows are still there
   * for a route to delete, and the route that saves a review is the one that
   * would.
   */
  it('keeps a finding, its disposition AND its history when a save omits the key', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      const h = harness(t);
      const target = { kind: 'documents' as const, documentIds: ['d1', 'd2'] };
      const first = await h.put('/v1/reviews/r1', REVIEW({ documentIds: ['d1', 'd2'], target }));
      await seedFindingRows(t, 'r1', WS, target, {
        d1: { c1: finding() },
        d2: { c1: finding({ verification: { state: 'verified', byUserId: HUMAN,
          at: 1_700_000_030_000 } }) },
      }, HUMAN);
      expect(await t.query("select 1 from finding where review_id = 'r1'")).toHaveLength(2);

      // The stale save: the same review again, saying nothing about findings
      // — which is now the ONLY thing a whole-review save can say about them.
      await h.put('/v1/reviews/r1', {
        ...REVIEW({ documentIds: ['d1', 'd2'], target }),
        version: first.version,
      });

      const keys = await t.query<{ findings_key: string }>(
        "select findings_key from finding where review_id = 'r1' order by findings_key");
      expect(keys.map(k => k.findings_key)).toEqual(['d1', 'd2']);
      const disposition = await t.query<{ state: string }>(
        "select state from finding_disposition where findings_key = 'd2'");
      expect(disposition[0]?.state, 'a lawyer s verification was destroyed by a stale save')
        .toBe('verified');
      // …and the reader still sees it, which is the fact a person would act on.
      expect((await read(h)).findings.d2.c1.verification.state).toBe('verified');
      await h.app.close();
    });
  });

  it('REFUSES a save that carries findings, rather than accepting and ignoring them', async () => {
    /*
     * THE HALF THAT PROTECTS AN OLD TAB. Accept-and-ignore is the wrong
     * answer and it is the shape of half the defects on CLAUDE.md's list: a
     * client that believes it saved sixty findings and did not. The way it
     * would happen is ordinary — a browser left open across a deploy, still
     * running the code that put the whole review on the wire.
     */
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      const first = await h.put('/v1/reviews/r1', REVIEW());
      await seedFindingRows(t, 'r1', WS, DOCS_TARGET, { d1: { c1: finding({
        verification: { state: 'verified', byUserId: HUMAN, at: 1_700_000_030_000 },
      }) } }, HUMAN);

      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        version: first.version,
        findings: { d1: { c1: finding({ verification: { state: 'unchecked' } }) } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/findings are no longer saved with the review/i);
      expect(res.json().error.message).toMatch(/reload the page/i);

      // NOTHING was written — not the findings it tried to send, and not the
      // review either. A refusal that half-applied would be worse than an
      // accept-and-ignore.
      expect((await read(h)).findings.d1.c1.verification.state).toBe('verified');
      const version = (await h.get('/v1/reviews/r1')).version;
      expect(version).toBe(first.version);
      await h.app.close();
    });
  });

  it('ACCEPTS an empty findings object, which claims nothing', async () => {
    // The other side of the refusal, so it cannot be read as "any `findings`
    // key is refused". A caller with nothing to say about findings is not
    // making a claim about them.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      const res = await h.raw('PUT', '/v1/reviews/r1', { ...REVIEW(), findings: {} });
      expect(res.statusCode, res.body).toBe(200);
      await h.app.close();
    });
  });
});

/* ------------------------------------------------------------------ *
 *  STAGE 4 §8: the read carries the disposition AND the event that     *
 *  produced it — so "was Rejected" needs no second query.              *
 * ------------------------------------------------------------------ */

/** A second person, so an override is an override rather than one person
 *  changing their own mind. Every collaborative claim in Stage 4 needs
 *  two. */
const PARTNER = '00000000-0000-0000-0000-0000000000a2';

async function aPartner(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 'the-partner-read', 'R Okafor', 'RO', 'partner', 'active')
     on conflict (id) do nothing`, [PARTNER, WS]);
}

/** Moves a disposition through the ONE writer of both tables, so the
 *  fixture cannot produce a current state whose history does not explain
 *  it — which is the property these assertions are about. */
async function move(
  t: Tx, clauseId: string,
  change: { state: string; reason?: string },
  cause: 'human' | 'rerun_reset',
  actor: string,
  at: number,
  expectedVersion: number,
): Promise<void> {
  await setDisposition(
    t, { reviewId: 'r1', findingsKey: 'd1', clauseId },
    change as never, cause, { id: actor, workspaceId: WS }, new Date(at), expectedVersion);
}

describe('the findings read carries the disposition and the event that produced it', () => {
  it('carries the disposition and the event that produced it', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aPartner(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });

      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c1', { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.' },
        'human', PARTNER, 1_700_000_020_000, 2);

      const d = (await read(h)).dispositions.d1.c1;
      expect(d.disposition.state).toBe('rejected');
      expect(d.disposition.changedCount).toBe(2);
      expect(d.disposition.byUserId).toBe(PARTNER);
      // "was Verified", with no second request. This is the whole of §8's
      // sentence about the read.
      expect(d.last.fromState).toBe('verified');
      expect(d.last.toState).toBe('rejected');
      expect(d.last.cause).toBe('human');
      expect(d.last.byUserId).toBe(PARTNER);
      expect(d.last.reason).toBe('The cap is uncapped in clause 14.2.');
      await h.app.close();
    });
  });

  it('gives a never-touched finding a disposition with no actor and NO last event', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      const d = (await read(h)).dispositions.d1.c1;
      expect(d.disposition.state).toBe('unchecked');
      expect(d.disposition.changedCount).toBe(0);
      // `in`, not `toEqual`: absence is the assertion, and `structuredClone`
      // preserves an undefined-valued key.
      expect('byUserId' in d.disposition).toBe(false);
      expect('at' in d.disposition).toBe(false);
      expect('last' in d).toBe(false);
      await h.app.close();
    });
  });

  it('leaves `last` ABSENT on the object itself, not merely absent after JSON', async () => {
    /*
     * THE MUTATION THIS EXISTS FOR, and it was found by trying it: setting
     * `last: undefined` on every entry passes every case above, because they
     * read through `app.inject` and `JSON.stringify` drops an
     * undefined-valued key on the way out. `structuredClone` — how a record
     * crosses every other boundary in this system, and how Part 4B's socket
     * payloads will be copied — PRESERVES it, so the guard has to be made
     * against the object this function actually returns.
     *
     * CLAUDE.md's rule, applied where it bites: *"`toEqual` does not
     * distinguish an absent key from an `undefined` one … a guard that looks
     * decorative in a test is load-bearing against real persisted data."*
     */
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      const page = await readFindings(dbOn(t), 'r1', WS);
      const d = page.dispositions.d1.c1;
      expect('last' in d).toBe(false);
      expect(Object.keys(d)).toEqual(['disposition']);
      // …and the same for the disposition's own absent actor and instant.
      expect('byUserId' in d.disposition).toBe(false);
      expect('at' in d.disposition).toBe(false);
      // The pair: a finding that HAS been moved does carry the key, so the
      // three assertions above are about absence rather than about the map
      // never being filled in.
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      const moved = (await readFindings(dbOn(t), 'r1', WS)).dispositions.d1.c1;
      expect('last' in moved).toBe(true);
      expect(moved.last!.toState).toBe('verified');
      await h.app.close();
    });
  });

  it('keeps changedCount on a disposition cleared BY HAND, which unchecked alone hides', async () => {
    // "Never touched" and "a person cleared this" are both `unchecked` and
    // are different facts. `Finding.verification` collapses them —
    // correctly, because neither is a judgement — so the difference has to
    // survive somewhere, and this is where.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c1', { state: 'unchecked' }, 'human', HUMAN, 1_700_000_020_000, 2);

      const page = await read(h);
      // The finding still reads as unchecked — nothing derives a judgement.
      expect(page.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
      const d = page.dispositions.d1.c1;
      expect(d.disposition.state).toBe('unchecked');
      expect(d.disposition.changedCount).toBe(2);
      expect(d.last.cause).toBe('human');
      expect(d.last.fromState).toBe('verified');
      await h.app.close();
    });
  });

  it('marks a disposition cleared by a re-run as a re-run, not as a person un-verifying', async () => {
    // §6.3: the two are different acts and the card must not flatten them.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c1', { state: 'unchecked' }, 'rerun_reset', HUMAN, 1_700_000_030_000, 2);

      const d = (await read(h)).dispositions.d1.c1;
      expect(d.disposition.state).toBe('unchecked');
      expect(d.disposition.changedCount).toBeGreaterThan(0);
      expect(d.last.cause).toBe('rerun_reset');
      expect(d.last.fromState).toBe('verified');
      await h.app.close();
    });
  });

  it('gives each finding ITS OWN latest event, never another clause s', async () => {
    // What `distinct on (review_id, findings_key, clause_id)` is for. A
    // grouping that lost the clause would put one clause's history on
    // another's card, with this application's full authority.
    await withPg(async t => {
      await aMatter(t);
      await aPartner(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, {
        d1: { c1: finding(), c2: finding({ clauseId: 'c2' }), c3: finding({ clauseId: 'c3' }) },
      });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c2', { state: 'flagged' }, 'human', PARTNER, 1_700_000_020_000, 1);
      // c3 is left alone, so the sweep has to produce two events and not
      // three — and must not hand c3 either of the other two.

      const d = (await read(h)).dispositions.d1;
      expect(d.c1.last.toState).toBe('verified');
      expect(d.c1.last.byUserId).toBe(HUMAN);
      expect(d.c2.last.toState).toBe('flagged');
      expect(d.c2.last.byUserId).toBe(PARTNER);
      expect('last' in d.c3).toBe(false);
      await h.app.close();
    });
  });

  it('keys a collection review s dispositions by the COLLECTION, not by a document', async () => {
    // R-C1 at the client/server boundary, on the map Stage 4 adds. Six
    // defects in sub-project C came from keying by document id directly.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      await aCollection(t, 'col-1', 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { 'col-1': { c1: finding() } }, {
        documentIds: ['d1', 'd2'],
        target: { kind: 'collection', collectionId: 'col-1', documentIds: ['d1', 'd2'] },
      });
      const page = await read(h);
      expect(Object.keys(page.dispositions)).toEqual(['col-1']);
      expect(page.dispositions['col-1'].c1.disposition.clauseId).toBe('c1');
      await h.app.close();
    });
  });

  it('reads one statement per review, not one per finding', async () => {
    // The mutation this exists for: rewrite the events lookup as a
    // per-finding query and watch this fail. Sixty clauses is sixty round
    // trips, and it is the shape that gets deleted later along with the
    // sentence it fed.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, {
        d1: {
          c1: finding(), c2: finding({ clauseId: 'c2' }), c3: finding({ clauseId: 'c3' }),
          c4: finding({ clauseId: 'c4' }), c5: finding({ clauseId: 'c5' }),
        },
      });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c2', { state: 'flagged' }, 'human', HUMAN, 1_700_000_011_000, 1);

      const issued: string[] = [];
      const counting = {
        query: (text: string, values?: unknown[]) => {
          issued.push(text);
          return t.query(text, values);
        },
        tx: (run: (tx: Tx) => Promise<unknown>) => t.tx(run),
      };
      await readFindings(counting as never, 'r1', WS);
      // Three: the review's version, the findings join, the latest-events
      // sweep. Five clauses, three statements.
      expect(issued).toHaveLength(3);
      expect(issued.filter(q => /finding_disposition_event/.test(q))).toHaveLength(1);
      await h.app.close();
    });
  });

  it('leaves Finding.verification exactly as it was — attribution rides beside, not inside', async () => {
    // P34. The natural mistake here is to enrich `Finding`, and `Finding` is
    // the domain shape three programs share.
    await withPg(async t => {
      await aMatter(t);
      await aPartner(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      await move(t, 'c1', { state: 'rejected', reason: 'Wrong clause.' },
        'human', PARTNER, 1_700_000_020_000, 2);

      const v = (await read(h)).findings.d1.c1.verification;
      expect(Object.keys(v).sort()).toEqual(['at', 'byUserId', 'reason', 'state']);
      expect('changedCount' in v).toBe(false);
      expect('fromState' in v).toBe(false);
      expect('last' in v).toBe(false);
      await h.app.close();
    });
  });

  it('never answers an event for a review this workspace cannot see', async () => {
    // The events sweep is a second statement over a table holding every
    // firm's judgements, so its own workspace predicate is asserted rather
    // than left to the repo-wide scanner alone.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await aReviewWith(t, h, { d1: { c1: finding() } });
      await move(t, 'c1', { state: 'verified' }, 'human', HUMAN, 1_700_000_010_000, 1);
      const other = await readFindings(dbOn(t), 'r1', '00000000-0000-0000-0000-0000000000ff')
        .catch((e: unknown) => e);
      expect((other as Error).message).toMatch(/no such review/i);
      await h.app.close();
    });
  });
});
