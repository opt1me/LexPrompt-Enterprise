import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import { reconcileFindings, describeDiscrepancies } from '../src/findings/reconcile.ts';

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

const REVIEW = (over: Record<string, unknown> = {}) => ({
  id: 'r1', matterId: 'm1',
  playbookSnapshot: SNAPSHOT,
  documentIds: ['d1'],
  target: { kind: 'documents', documentIds: ['d1'] },
  findings: { d1: { c1: finding() } },
  modelId: 'test/model',
  startedAt: 1_700_000_000_000,
  createdByUserId: '',
  ...over,
});

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
      await h.put('/v1/reviews/r1', REVIEW());

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
      await h.put('/v1/reviews/r1', REVIEW());
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
      await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2'],
        target: { kind: 'collection', collectionId: 'col-1', documentIds: ['d1', 'd2'] },
        findings: { 'col-1': { c1: finding({ netPosition: {
          text: 'Read in order, the tenant has a rolling break on six months notice.',
          state: 'unconfirmed', trail: [],
        } }) } },
      }));
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
      await h.put('/v1/reviews/r1', REVIEW({ findings: { d1: {
        c1: finding({ notes: [
          { id: 'n2', findingId: 'd1::c1', text: 'Second.', byUserId: HUMAN, at: 1_700_000_020_000 },
          { id: 'n1', findingId: 'd1::c1', text: 'First.', byUserId: HUMAN, at: 1_700_000_010_000 },
        ] }),
      } } }));
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
      await h.put('/v1/reviews/r1', REVIEW());
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
      await h.put('/v1/reviews/r1', REVIEW({ findings: { d1: { c1: finding({
        verification: { state: 'flagged', byUserId: HUMAN, at: 1_700_000_009_000 },
      }) } } }));
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
      await h.put('/v1/reviews/r1', REVIEW({ findings: { d1: { c1: finding({ notes: [
        { id: 'n1', findingId: 'd1::c1', text: 'a', byUserId: HUMAN, at: 1 },
        { id: 'n2', findingId: 'd1::c1', text: 'b', byUserId: HUMAN, at: 2 },
        { id: 'n3', findingId: 'd1::c1', text: 'c', byUserId: HUMAN, at: 3 },
      ] }) } } }));
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
      await h.put('/v1/reviews/r1', REVIEW({ findings: {} }));
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
      await h.put('/v1/reviews/r1', REVIEW());
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
      await h.put('/v1/reviews/r1', REVIEW());
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

  it('and the two agree on a review saved through the blob — P17 s reconciliation, at the read', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t);
      await h.put('/v1/reviews/r1', REVIEW({ findings: { d1: { c1: finding({
        verification: { state: 'rejected', reason: 'Wrong clause.', byUserId: HUMAN,
          at: 1_700_000_009_000 },
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked.', byUserId: HUMAN, at: 5 }],
      }) } } }));
      const blob = (await t.query<{ findings: unknown }>(
        "select findings from review where id = 'r1'"))[0].findings as
        Record<string, Record<string, unknown>>;
      const rows = (await read(h)).findings;
      expect(rows).toEqual(blob);
      const found = await reconcileFindings(t, 'r1');
      expect(found, describeDiscrepancies(found)).toEqual([]);
      await h.app.close();
    });
  });
});

describe('a stale whole-review save can no longer destroy an authoritative row', () => {
  /*
   * TASK 14'S RULING ON `writeFindingRows`'s DELETE. See the long form in
   * `findings/write.ts`: the delete was correct while the blob was the
   * record of truth and is not correct now, because a body that omits a key
   * is a body that is BEHIND — which is precisely what Part 3A's gate named
   * as the window this task closes ("a run started via the new route
   * produces rows that the next browser save would delete").
   */
  it('keeps a finding, its disposition AND its history when a save omits the key', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      const h = harness(t);
      const first = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2'],
        target: { kind: 'documents', documentIds: ['d1', 'd2'] },
        findings: {
          d1: { c1: finding() },
          d2: { c1: finding({ verification: { state: 'verified', byUserId: HUMAN,
            at: 1_700_000_030_000 } }) },
        },
      }));
      expect(await t.query('select 1 from finding')).toHaveLength(2);

      // The stale save: the same review, with d2 missing from the body.
      await h.put('/v1/reviews/r1', {
        ...REVIEW({
          documentIds: ['d1', 'd2'],
          target: { kind: 'documents', documentIds: ['d1', 'd2'] },
          findings: { d1: { c1: finding() } },
        }),
        version: first.version,
      });

      const keys = await t.query<{ findings_key: string }>(
        'select findings_key from finding order by findings_key');
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
});
