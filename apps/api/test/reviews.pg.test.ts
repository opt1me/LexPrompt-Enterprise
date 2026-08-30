import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Review } from '../src/db/rows.ts';

/**
 * `reviews` end to end, against a real Postgres.
 *
 * Two things here that no other table's suite has to ask. First, the record
 * is enormous and mostly opaque jsonb, so what has to be proved is that it
 * comes back BYTE-FOR-BYTE — including the optional keys whose ABSENCE is a
 * different fact from their presence. Second, a stale write must be refused,
 * because the thing it would overwrite is a human's verification and nothing
 * else in this system can put one there.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-reviews',
  groups: ['reviewers'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

/**
 * The person whose judgements these fixtures carry, as a REAL `app_user` with
 * a fixed id.
 *
 * It used to be the string `HUMAN`, which was fine while a verification
 * and a note were fields inside an opaque jsonb blob. Stage 3 Task 7 makes
 * both of them ROWS whose author is a foreign key to `app_user`, so a
 * placeholder that resolves to nobody is now refused — by the shadow writer
 * with a sentence, and by Postgres with a constraint name if it were not. A
 * note is a person's remark; "somebody wrote this about your clause" with no
 * somebody is not one anybody can weigh.
 */
const HUMAN = '00000000-0000-0000-0000-0000000000a1';

async function aHuman(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 'the-human', 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [HUMAN, WS]);
}

async function aMatter(t: Tx, id = 'm1', ws = WS): Promise<void> {
  await aHuman(t);
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now())`, [id, ws]);
}

/** A published version for a review to point at. `review.playbook_version_id`
 *  is a FOREIGN KEY, so a review naming one that does not exist is refused —
 *  see the route's own note, and the case below that pins it. */
async function aVersion(t: Tx, id = 'v1', playbookId = 'p1', ws = WS): Promise<void> {
  await t.query(
    "insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)"
    + " values ($1, $2, 'Lease', now(), now(), 7) on conflict (id) do nothing", [playbookId, ws]);
  await t.query(
    "insert into playbook_version (id, workspace_id, playbook_id, version_number, content,"
    + " published_at) values ($1, $2, $3, 1, '{}'::jsonb, now())", [id, ws, playbookId]);
}

async function aDocument(t: Tx, id: string, matterId = 'm1', ws = WS): Promise<void> {
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', $3, $4, 'pdf', 'x', 'parsed', 4, 'application/pdf', $5, 'standalone', now())`,
    [id, ws, matterId, `${id}.pdf`, `workspace/${ws}/document/${id}`]);
}

const SNAPSHOT = {
  id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'Lease',
  systemPrompt: 's', formatPrompt: 'f', changeSummary: '', publishedAt: 1, publishedByUserId: 'u1',
  schemaVersion: 7,
  clauses: [{ id: 'c1', title: 'Break', extractPrompt: 'What is the break right?' }],
};

/** A finding carrying everything a real one does — a verification with its
 *  author and timestamp, citations, notes, a net position. */
const finding = (over: Record<string, unknown> = {}) => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4, clauseRef: '14.2' }],
  verification: { state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000 },
  notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Checked against the deed.',
    byUserId: HUMAN, at: 1_700_000_010_000 }],
  ...over,
});

const REVIEW = (over: Record<string, unknown> = {}) => ({
  id: 'r1', matterId: 'm1',
  playbookSnapshot: SNAPSHOT,
  playbookVersionId: 'v1',
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
  put(url: string, body: unknown): Promise<Review>;
  raw(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
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
      return res.json() as Review;
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

describe('a review round-trips through Postgres unchanged', () => {
  it('round-trips sixty findings with citations, notes and a net position', async () => {
    // `toEqual` on the WHOLE record. A findings map that loses one clause is
    // a review that silently claims less than it checked.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      for (const d of ['d1', 'd2', 'd3']) await aDocument(t, d);
      const h = harness(t, await aUser(t));

      const findings: Record<string, Record<string, unknown>> = {};
      for (const doc of ['d1', 'd2', 'd3']) {
        findings[doc] = {};
        for (let i = 1; i <= 20; i++) {
          findings[doc][`c${i}`] = finding({
            clauseId: `c${i}`,
            summary: `Finding ${doc}/${i}.`,
            citations: [{ quote: `quote ${i}`, documentId: doc, page: i }],
          });
        }
      }
      const netPosition = {
        text: 'Read in order, the tenant has a rolling break on six months notice.',
        state: 'unconfirmed',
        trail: [{ documentId: 'd1', kind: 'original', effect: 'Grants the break.', citations: [] }],
      };
      findings.d1.c1 = finding({ netPosition });

      const saved = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2', 'd3'],
        target: { kind: 'documents', documentIds: ['d1', 'd2', 'd3'] },
        findings,
      }));
      // TASK 14: `GET /v1/reviews/:id` no longer carries the findings —
      // absent, never `{}` — and the record is otherwise byte-for-byte what
      // the save answered. The findings themselves are asserted against the
      // route that now serves them, which is the whole point of the flip.
      const { findings: _sent, ...record } = saved as Review;
      expect(await h.get('/v1/reviews/r1')).toEqual(record);
      const back = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, Record<string, unknown>>>;
      expect(Object.keys(back)).toEqual(['d1', 'd2', 'd3']);
      expect(Object.keys(back.d2)).toHaveLength(20);
      expect(back.d1.c1.netPosition).toEqual(netPosition);
      await h.app.close();
    });
  });

  it('preserves a verification exactly, including its byUserId and at', async () => {
    // Nothing derives a verification, and a round trip must not become the
    // first thing that does.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW());
      const f = (saved.findings as Record<string, Record<string, Record<string, unknown>>>).d1.c1;
      expect(f.verification).toEqual({
        state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000,
      });
      expect(f.notes).toEqual([{ id: 'n1', findingId: 'd1::c1',
        text: 'Checked against the deed.', byUserId: HUMAN, at: 1_700_000_010_000 }]);
      await h.app.close();
    });
  });

  it('keeps an ABSENT optional key absent, rather than storing it as null', async () => {
    // `positionOutcome` absent means "no standard position to compare
    // against"; `'unclear'` means "we have one and could not tell". Different
    // facts, and only the first should produce no comparison. `jsonb` will
    // happily store `{"positionOutcome": null}`, which reads back as a claim
    // that a comparison was attempted.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW());
      const f = (saved.findings as Record<string, Record<string, Record<string, unknown>>>).d1.c1;
      // NOT toEqual — Vitest cannot tell an absent key from an undefined one,
      // and absence is the assertion.
      expect('positionOutcome' in f).toBe(false);
      expect('positionRationale' in f).toBe(false);
      // …and an outcome that IS present survives as itself.
      const withOutcome = await h.put('/v1/reviews/r2', REVIEW({
        id: 'r2', findings: { d1: { c1: finding({ positionOutcome: 'unclear',
          positionRationale: 'The model gave no reason.' }) } },
      }));
      const g = (withOutcome.findings as Record<string, Record<string, Record<string, unknown>>>).d1.c1;
      expect(g.positionOutcome).toBe('unclear');
      await h.app.close();
    });
  });

  it('keeps truncatedDocuments absent rather than an empty array on a single-document finding', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW());
      const f = (saved.findings as Record<string, Record<string, Record<string, unknown>>>).d1.c1;
      expect('truncatedDocuments' in f).toBe(false);
      await h.app.close();
    });
  });

  it('keeps completedAt and cancelledAt absent on a review that is still running', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW());
      expect('completedAt' in saved).toBe(false);
      expect('cancelledAt' in saved).toBe(false);
      const done = await h.put('/v1/reviews/r1',
        { ...REVIEW(), version: saved.version, completedAt: 1_700_000_100_000 });
      expect(done.completedAt).toBe(1_700_000_100_000);
      expect('cancelledAt' in done).toBe(false);
      await h.app.close();
    });
  });

  it('keeps a collection target and its findings key exactly as given', async () => {
    // `findingsKeyFor`: a collection review keys its findings by the
    // COLLECTION id, not by a document. A round trip that re-keyed anything
    // would produce an empty findings pane.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2'],
        target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
        findings: { 'coll-1': { c1: finding() } },
      }));
      expect(saved.target).toEqual(
        { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] });
      expect(Object.keys(saved.findings as object)).toEqual(['coll-1']);
      await h.app.close();
    });
  });

  it('records the AUTHENTICATED actor as who ran it, not whoever the body named', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const saved = await h.put('/v1/reviews/r1', REVIEW({ createdByUserId: someoneElse }));
      expect(saved.createdByUserId).toBe(actor);
      await h.app.close();
    });
  });
});

describe('a save that would lose somebody else s work is refused', () => {
  it('refuses a stale save with 409 and returns the current review (P9)', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const first = await h.put('/v1/reviews/r1', REVIEW());
      expect(first.version).toBe(1);
      const second = await h.put('/v1/reviews/r1', { ...first, modelId: 'other/model' });
      expect(second.version).toBe(2);

      const res = await h.raw('PUT', '/v1/reviews/r1', { ...first, modelId: 'from-a-stale-tab' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
      expect(res.json().current.modelId).toBe('other/model');
      expect((await h.get('/v1/reviews/r1') as Review).modelId).toBe('other/model');
      await h.app.close();
    });
  });

  it('THE ONE THAT MATTERS: a run s stale save cannot erase a human s verification', async () => {
    // The whole reason this table has an optimistic-concurrency token. A
    // run's debounced saver holds its own copy of the review, writes the
    // WHOLE record every two seconds, and knows nothing about a verification
    // somebody recorded in another tab. `carryHumanState` closes that within
    // one tab and cannot close it across two, because the other tab's write
    // was never in this one's snapshot to carry.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));

      // The run saves an UNCHECKED finding, as `extractClause` produces one.
      const running = await h.put('/v1/reviews/r1', REVIEW({
        findings: { d1: { c1: finding({ verification: { state: 'unchecked' } }) } },
      }));

      // A person, elsewhere, verifies it.
      await h.put('/v1/reviews/r1', {
        ...running,
        findings: { d1: { c1: finding({
          verification: { state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000 },
        }) } },
      });

      // The run's next save, built from the copy it has held all along.
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...running,
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          summary: 'A later cell finished.',
        }) } },
      });
      expect(res.statusCode, 'a stale run save was APPLIED over a human verification').toBe(409);

      const now = await h.get('/v1/reviews/r1/findings');
      const v = (now.findings as Record<string, Record<string, Record<string, unknown>>>)
        .d1.c1.verification;
      expect(v).toEqual({ state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000 });
      await h.app.close();
    });
  });

  it('refuses a create over an id that already exists, rather than overwriting it', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      await h.put('/v1/reviews/r1', REVIEW());
      // No `version` at all — the claim a review built from a run makes.
      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({ modelId: 'a-retried-create' }));
      expect(res.statusCode).toBe(409);
      expect((await h.get('/v1/reviews/r1') as Review).modelId).toBe('test/model');
      await h.app.close();
    });
  });
});

describe('a review may only name a playbook version that is still here', () => {
  it('refuses a DANGLING playbookVersionId with a 400 naming the repair, not a raw FK 500', async () => {
    // The only way to get one: deleting a playbook clears this pointer on
    // every review that named one of its versions (R-D4), so a browser
    // holding a copy read BEFORE that delete still carries the old id. Left
    // unchecked it reaches Postgres as `review_playbook_version_id_fkey` and
    // comes back as a 500 quoting a constraint name — a status with no cause
    // and no action, which is the shape the error envelope exists to
    // replace.
    //
    // FINDING, recorded here as well as in the route: with this foreign key
    // in place a dangling `playbookVersionId` cannot be STORED at all, so
    // R-D15's distinction between "never recorded" and "recorded, then
    // deleted" survives a read and does not survive a save.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1',
        REVIEW({ playbookVersionId: 'a-version-that-was-deleted' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/a-version-that-was-deleted/);
      expect(res.json().error.message).toMatch(/reload the review and save again/i);
      // Not a Postgres constraint name in front of a lawyer.
      expect(res.json().error.message).not.toMatch(/fkey|constraint/i);
      expect((await t.query("select 1 from review where id = 'r1'")).length).toBe(0);
      await h.app.close();
    });
  });

  it('accepts a review that never named a version at all', async () => {
    // R-D4: `playbookVersionId` is optional because a review whose playbook
    // was deleted before D has none. Absent must stay savable.
    await withPg(async t => {
      await aMatter(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const body = REVIEW() as Record<string, unknown>;
      delete body.playbookVersionId;
      const saved = await h.put('/v1/reviews/r1', body);
      expect('playbookVersionId' in saved).toBe(false);
      await h.app.close();
    });
  });
});

describe('a review may only name documents in its own matter', () => {
  it('refuses a review naming a document from another matter, and writes nothing', async () => {
    // `ReviewTarget` carries document ids; a target pointing outside the
    // matter is a review that would cite the wrong client's document.
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aVersion(t);
      await aMatter(t, 'm2');
      await aDocument(t, 'd1', 'm1');
      await aDocument(t, 'd-theirs', 'm2');
      const h = harness(t, await aUser(t));

      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd-theirs'],
        target: { kind: 'documents', documentIds: ['d1', 'd-theirs'] },
      }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/d-theirs/);
      expect(res.json().error.message).toMatch(/only cover documents in the matter/i);
      expect((await t.query("select 1 from review where id = 'r1'")).length).toBe(0);
      await h.app.close();
    });
  });

  it('refuses a document that exists in ANOTHER WORKSPACE s matter', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'm1');
      await aVersion(t);
      await aMatter(t, 'theirs', OTHER_WS);
      await aDocument(t, 'd-foreign', 'theirs', OTHER_WS);
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({
        documentIds: ['d-foreign'],
        target: { kind: 'documents', documentIds: ['d-foreign'] },
      }));
      expect(res.statusCode).toBe(400);
      await h.app.close();
    }, migratorDb());
  });

  it('checks the TARGET s ids too, not only documentIds', async () => {
    // The two are written separately — `documentIds` is a convenience mirror
    // — so checking one leaves the other free to name somebody else's file.
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aVersion(t);
      await aMatter(t, 'm2');
      await aDocument(t, 'd1', 'm1');
      await aDocument(t, 'd-theirs', 'm2');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({
        documentIds: ['d1'],
        target: { kind: 'documents', documentIds: ['d1', 'd-theirs'] },
      }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/d-theirs/);
      await h.app.close();
    });
  });

  it('accepts a review whose target names nothing at all', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      const h = harness(t, await aUser(t));
      const saved = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: [], target: { kind: 'documents', documentIds: [] }, findings: {},
      }));
      expect(saved.documentIds).toEqual([]);
      await h.app.close();
    });
  });

  it('STILL SAVES a review after one of its documents was deleted from the matter', async () => {
    // THE ONE C1 EXISTS FOR. Removing a document from a matter is a single
    // click that touches no review, and spec §9 deliberately keeps such a
    // review openable. Re-validating the ids the row ALREADY HOLDS turned
    // that into a review that opens, reads, and can never be written again:
    // every verification, note, net-position confirmation, retry and
    // auto-save on it answered 400, permanently, with no UI anywhere able to
    // edit a stored review's `documentIds`. A guard against a lost human
    // judgement that has never been seen to fail is decoration, so this
    // re-reads the row and asserts the verification actually landed.
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aVersion(t);
      await aDocument(t, 'd1');
      await aDocument(t, 'd2');
      const h = harness(t, await aUser(t));

      const first = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2'],
        target: { kind: 'documents', documentIds: ['d1', 'd2'] },
        findings: { d1: { c1: finding() } },
      }));

      // The delete the reviewer actually performs — the row goes, the review
      // is not touched.
      await t.query("delete from document where id = 'd2'");

      const saved = await h.put('/v1/reviews/r1', {
        ...REVIEW({
          documentIds: ['d1', 'd2'],
          target: { kind: 'documents', documentIds: ['d1', 'd2'] },
          findings: {
            // A DIFFERENT judgement from the first save's, deliberately.
            // The re-read below now comes from `finding_disposition`, and
            // that row records who set the CURRENT state and when they set
            // it — so a save repeating an identical verification writes no
            // new instant (`writeDisposition` compares state, reason and
            // actor, on purpose: a run's autosave repeats the same
            // verification every two seconds). Re-asserting a moved
            // timestamp on an unchanged judgement would have been asserting
            // the blob's behaviour, not the store's.
            d1: { c1: finding({ verification: {
              state: 'flagged', byUserId: HUMAN, at: 1_700_000_099_000,
            } }) },
          },
        }),
        version: first.version,
      });
      expect(saved.documentIds).toEqual(['d1', 'd2']);

      const findings = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, { verification: { state: string; at: number } }>>;
      expect(findings.d1.c1.verification.state).toBe('flagged');
      expect(findings.d1.c1.verification.at).toBe(1_700_000_099_000);
      await h.app.close();
    });
  });

  it('still refuses a document id the stored review did NOT already hold', async () => {
    // The other half of C1's fix: grandfathering the row's own ids must not
    // become a door around the guard. A SECOND save that ADDS a foreign id
    // is refused exactly as the first save naming one is.
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aVersion(t);
      await aMatter(t, 'm2');
      await aDocument(t, 'd1', 'm1');
      await aDocument(t, 'd-theirs', 'm2');
      const h = harness(t, await aUser(t));

      const first = await h.put('/v1/reviews/r1', REVIEW());
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW({
          documentIds: ['d1', 'd-theirs'],
          target: { kind: 'documents', documentIds: ['d1', 'd-theirs'] },
        }),
        version: first.version,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/d-theirs/);
      // And the row is unchanged — the refusal wrote nothing.
      const back = await h.get('/v1/reviews/r1') as Review;
      expect(back.documentIds).toEqual(['d1']);
      await h.app.close();
    });
  });

  it('refuses a target whose kind is neither documents nor collection', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1',
        REVIEW({ target: { kind: 'everything', documentIds: [] } }));
      expect(res.statusCode).toBe(400);
      await h.app.close();
    });
  });

  it('refuses a review with no playbookSnapshot, rather than one that cannot say what it checked', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      const h = harness(t, await aUser(t));
      const body = REVIEW() as Record<string, unknown>;
      delete body.playbookSnapshot;
      const res = await h.raw('PUT', '/v1/reviews/r1', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/playbookSnapshot/);
      await h.app.close();
    });
  });
});

describe('listing, deleting and workspace scope', () => {
  it('lists a matter s reviews most recently started first, with a stable same-millisecond tie', async () => {
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aVersion(t);
      await aMatter(t, 'm2');
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      await h.put('/v1/reviews/aaa', REVIEW({ id: 'aaa', startedAt: 5_000 }));
      await h.put('/v1/reviews/bbb', REVIEW({ id: 'bbb', startedAt: 5_000 }));
      await h.put('/v1/reviews/ccc', REVIEW({
        id: 'ccc', matterId: 'm2', startedAt: 9_000,
        documentIds: [], target: { kind: 'documents', documentIds: [] },
      }));
      const list = await h.get('/v1/matters/m1/reviews') as Review[];
      expect(list.map(r => r.id)).toEqual(['bbb', 'aaa']);
      expect(list[0].startedAt).toBe(list[1].startedAt);
      await h.app.close();
    });
  });

  it('deletes a review, and a second delete is a 404 rather than a silent 204', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      await h.put('/v1/reviews/r1', REVIEW());
      expect((await h.raw('DELETE', '/v1/reviews/r1')).statusCode).toBe(204);
      expect((await h.raw('GET', '/v1/reviews/r1')).statusCode).toBe(404);
      expect((await h.raw('DELETE', '/v1/reviews/r1')).statusCode).toBe(404);
      await h.app.close();
    });
  });

  it('never lets a review be read, written or deleted across workspaces', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, model_id, started_at)
         values ('foreign', $1, 'theirs', '{"name":"Theirs"}'::jsonb, '{}'::jsonb, 'm', now())`,
        [OTHER_WS]);
      await aMatter(t, 'm1');
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));

      expect((await h.raw('GET', '/v1/reviews/foreign')).statusCode).toBe(404);
      expect((await h.get('/v1/matters/m1/reviews') as Review[]).map(r => r.id))
        .not.toContain('foreign');
      const res = await h.raw('PUT', '/v1/reviews/foreign', REVIEW({ id: 'foreign' }));
      expect(res.statusCode).toBe(409);
      expect('current' in res.json()).toBe(false);
      expect((await h.raw('DELETE', '/v1/reviews/foreign')).statusCode).toBe(404);
      expect((await t.query("select 1 from review where id = 'foreign'")).length).toBe(1);
      await h.app.close();
    }, migratorDb());
  });

  it('refuses a review whose matter is in another workspace', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({
        matterId: 'theirs', documentIds: [], target: { kind: 'documents', documentIds: [] },
      }));
      // 404, not 403 — a 403 confirms the matter id exists somewhere.
      expect(res.statusCode).toBe(404);
      await h.app.close();
    }, migratorDb());
  });
});
