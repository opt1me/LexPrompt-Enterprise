import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { seedFindingRows } from './helpers/seedFindings.ts';
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

const DOCS_TARGET = { kind: 'documents' as const, documentIds: ['d1'] };

const REVIEW = (over: Record<string, unknown> = {}) => ({
  id: 'r1', matterId: 'm1',
  playbookSnapshot: SNAPSHOT,
  playbookVersionId: 'v1',
  documentIds: ['d1'],
  target: { kind: 'documents', documentIds: ['d1'] },
  // TASK 22: NO `findings`. The blob is frozen (010) and this route refuses
  // a body carrying any — the refusal itself is asserted below.
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
  /*
   * TASK 22 TOOK THE FINDINGS OUT OF THIS RECORD, AND THREE TESTS WITH THEM.
   *
   * What stood here was a round trip of sixty findings through the jsonb
   * column, a verification preserved exactly, an absent optional key kept
   * absent, and `truncatedDocuments` kept absent rather than empty. Every one
   * of those claims is still made and still tested — against
   * `GET /v1/reviews/:id/findings`, in `findingsRead.pg.test.ts`, which is
   * where findings are read from now (Task 14) and written to (Tasks 15, 16,
   * 19). They are not deleted claims; they moved with the thing they are
   * about, and duplicating them here would be two suites making one claim,
   * which is this project's most repeated failure.
   *
   * What is left here is the review RECORD: its identity, its target, its
   * playbook snapshot, its timestamps, its actor and its version. Plus the
   * one new thing this route does, which is REFUSE a body that still carries
   * findings.
   */
  it('round-trips the whole record, and carries no findings in either direction', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      for (const d of ['d1', 'd2', 'd3']) await aDocument(t, d);
      const h = harness(t, await aUser(t));

      const saved = await h.put('/v1/reviews/r1', REVIEW({
        documentIds: ['d1', 'd2', 'd3'],
        target: { kind: 'documents', documentIds: ['d1', 'd2', 'd3'] },
      }));
      // `toEqual` on the WHOLE record: a save that quietly dropped the
      // playbook snapshot would be a review that cannot say what it checked.
      expect(await h.get('/v1/reviews/r1')).toEqual(saved);
      expect(saved.playbookSnapshot).toEqual(SNAPSHOT);
      expect(saved.target).toEqual({ kind: 'documents', documentIds: ['d1', 'd2', 'd3'] });
      // Absent, never `{}` — an empty object is the claim "this review found
      // nothing", which is the fact a reader would act on.
      expect('findings' in saved, 'the save answered with a findings map').toBe(false);
      expect('findings' in (await h.get('/v1/reviews/r1'))).toBe(false);
      await h.app.close();
    });
  });

  it('REFUSES a body carrying findings for a review that ALREADY EXISTS', async () => {
    /*
     * ACCEPT-AND-IGNORE IS THE WRONG ANSWER, and it is the shape of half the
     * defects on CLAUDE.md's list: a client that believes it saved sixty
     * findings and did not. The way it happens is ordinary — a browser left
     * open across a deploy, still running the code that put the whole review
     * on the wire.
     *
     * This is the dangerous case, and it is the one that is refused: the
     * review is here, its findings are rows written by the run and by the
     * judgement routes, and a whole-review body claiming otherwise is a
     * claim this route cannot keep.
     */
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const first = await h.put('/v1/reviews/r1', REVIEW());
      await seedFindingRows(t, 'r1', WS, DOCS_TARGET, { d1: { c1: finding({
        verification: { state: 'verified', byUserId: HUMAN, at: 1_700_000_030_000 },
      }) } }, HUMAN);

      const res = await h.raw('PUT', '/v1/reviews/r1',
        { ...REVIEW(), version: first.version, findings: { d1: { c1: finding() } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/findings are no longer saved with the review/i);
      expect(res.json().error.message).toMatch(/reload the page/i);

      // NOTHING was written — not the findings it tried to send, and not the
      // review either. A refusal that half-applied would be worse than an
      // accept-and-ignore.
      const back = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, { verification: { state: string } }>>;
      expect(back.d1.c1.verification.state).toBe('verified');
      expect((await h.get('/v1/reviews/r1') as Review).version).toBe(first.version);

      // …and the frozen column is untouched by the whole exchange.
      const blob = await t.query<{ n: string }>(
        "select count(*)::text n from review where findings <> '{}'::jsonb");
      expect(blob[0].n).toBe('0');
      await h.app.close();
    });
  });

  it('IMPORTS findings on a CREATE, as rows, never into the frozen column', async () => {
    /*
     * THE ONE PATH THAT MAY STILL HAND THIS ROUTE A FINDINGS MAP, and it is
     * not optional: the uploader moves an exported dataset into a workspace a
     * review at a time, and an exported review's findings carry
     * verifications, rejection reasons and notes — a lawyer's judgements,
     * which is the content this application exists to record.
     *
     * Refusing them would leave the uploader unable to move a review at all;
     * ignoring them would drop the judgements without saying so, which is the
     * failure this project's own list opens with. So they are WRITTEN, as
     * rows, and the frozen column stays empty.
     *
     * THIS TEST CHANGED DIRECTION (Stage 3 final review, C1). It used to
     * sign in as a freshly-minted random user and assert that the imported
     * verification came back attributed to HUMAN — a DIFFERENT real
     * `app_user`, named only by the request body. That is the forgery: it
     * enshrined a signed-in user's ability to write a colleague's name onto
     * a judgement. The import now records the actor's own judgements and
     * nobody else's, so the actor here IS the human whose judgements these
     * are, and the case that used to pass is the refusal below.
     */
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      // Signed in AS the person whose judgements are being moved.
      const h = harness(t, HUMAN);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'rejected', reason: 'The cap is in the sixth schedule.',
            byUserId: HUMAN, at: 1_700_000_040_000 },
          notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Agreed with the partner.',
            byUserId: HUMAN, at: 1_700_000_041_000 }],
        }) } },
      });
      expect(res.statusCode, res.body).toBe(200);

      // Read back from the ROWS, which is where a judgement lives — and with
      // the human's OWN instant, not the moment of the upload. The INSTANT is
      // still the body's and the NAME is the token's: a person may restate
      // when they themselves decided, and may not state who decided.
      const back = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, {
          verification: { state: string; reason: string; byUserId: string; at: number };
          notes: { text: string; byUserId: string }[];
        }>>;
      expect(back.d1.c1.verification).toEqual({
        state: 'rejected', reason: 'The cap is in the sixth schedule.',
        byUserId: HUMAN, at: 1_700_000_040_000,
      });
      expect(back.d1.c1.notes[0]).toMatchObject({
        text: 'Agreed with the partner.', byUserId: HUMAN,
      });
      // …and one history row behind it, because a disposition with no event
      // is a judgement with no record of having been made.
      expect(await t.query("select 1 from finding_disposition_event where review_id = 'r1'"))
        .toHaveLength(1);

      // THE FROZEN COLUMN IS STILL EMPTY. An import writes rows and nothing
      // else; a version of this that "helpfully" stored the map too would put
      // a second copy of every judgement beside the authoritative one.
      const blob = await t.query<{ f: string }>(
        "select findings::text f from review where id = 'r1'");
      expect(blob[0].f).toBe('{}');
      await h.app.close();
    });
  });

  it('REFUSES an import that attributes a verification to anybody but the actor', async () => {
    /*
     * THE WORST DEFECT THIS APPLICATION CAN HAVE, and it shipped: a signed-in
     * user could forge a colleague's verification.
     *
     * `GET /v1/reviews/:id/findings` returns each verification's `byUserId`,
     * so any reviewer can learn a colleague's `app_user` uuid from any review
     * they can see. `PUT /v1/reviews/<a fresh id>` with a findings map whose
     * verifications carry that uuid then wrote `finding_disposition` with
     * `by_user_id = <colleague>`, `at = <whatever they chose>` and a
     * `finding_disposition_event` with `cause = 'human'`. Every screen, every
     * DOCX and CSV export, and `positionHealth` treat that as the colleague's
     * genuine judgement — a document asserting a named lawyer checked
     * wording they never saw. The whole event history exists to make
     * attribution evidence; it is worth nothing if the current row can be
     * written with an arbitrary name.
     *
     * `byUserId` is exactly the field `parseDisposition` refuses by name on
     * the sibling route. This is the same rule on the only other path that
     * can write a disposition from a request.
     */
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      // The attacker: an ordinary signed-in reviewer, not the person named.
      const attacker = await aUser(t);
      const h = harness(t, attacker);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'rejected', reason: 'The cap is in the sixth schedule.',
            byUserId: HUMAN, at: 1_700_000_040_000 },
          notes: [],
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/is not the person signed in/i);
      expect(res.json().error.message).toContain(HUMAN);
      expect(res.json().error.message).toMatch(/Nothing has been saved/i);

      // NOTHING WAS WRITTEN — not the disposition, not its history, and not
      // the review either. The check runs before the first insert and the
      // route's transaction rolls back around it.
      expect(await t.query("select 1 from finding_disposition where review_id = 'r1'"))
        .toHaveLength(0);
      expect(await t.query("select 1 from finding_disposition_event where review_id = 'r1'"))
        .toHaveLength(0);
      expect(await t.query("select 1 from finding where review_id = 'r1'")).toHaveLength(0);
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  it('REFUSES an imported NOTE attributed to anybody but the actor', async () => {
    // A note is a person's remark and carries a name into the same export.
    // Checked separately because it is a second write with a second
    // `by_user_id`, and one guard covering only the verification would leave
    // a colleague's name on a remark they never wrote.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const attacker = await aUser(t);
      const h = harness(t, attacker);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Agreed with the partner.',
            byUserId: HUMAN, at: 1_700_000_041_000 }],
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/the note "n1" at d1\/c1/i);
      expect(res.json().error.message).toMatch(/is not the person signed in/i);
      expect(await t.query("select 1 from note where review_id = 'r1'")).toHaveLength(0);
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  /*
   * THE THIRD ATTRIBUTION ON THE IMPORT PATH — the one the fix round that
   * closed the verification and the note did not reach, found by the
   * cross-stage seam review (C1).
   *
   * A net position is synthesised text no document contains: `CLAUDE.md`
   * calls it "the most dangerous output this app produces", which is why it
   * starts `unconfirmed` and why only a human confirms it or amends it. That
   * makes forging its authorship WORSE than forging a verification, not
   * lesser — a verification says a person checked the model's reading of a
   * document that exists; an amended net position says a person WROTE EVERY
   * WORD of a paragraph no document contains.
   *
   * `readFindingsBlob` validates the net position as `isRecord(...)` and
   * nothing more, on purpose, and `toFindingRow` JSON.stringifies it straight
   * into `finding.net_position`. So until this guard existed, any reviewer
   * could read a colleague's `app_user` id off `GET /v1/workspace/users` and
   * `PUT /v1/reviews/<a fresh id>` with a confirmed position carrying it.
   */
  it('REFUSES an imported NET POSITION attributed to anybody but the actor', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const attacker = await aUser(t);
      const h = harness(t, attacker);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: {
            proposed: 'The tenant may assign without consent.',
            amended: 'The tenant may assign without consent.',
            state: 'confirmed', byUserId: HUMAN, at: 1_700_000_000_000, trail: [],
          },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/net position at d1\/c1/i);
      expect(res.json().error.message).toMatch(/is not the person signed in/i);
      expect(res.json().error.message).toContain(HUMAN);
      // NOTHING WAS WRITTEN. The check runs before the first insert.
      expect(await t.query("select 1 from finding where review_id = 'r1'")).toHaveLength(0);
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  it('REFUSES a confirmed net position that names nobody', async () => {
    // The same rule `readFindingsBlob` already applies to a verification that
    // "is verified but names nobody", one field over. A confirmation whose
    // whole content is "a person accepted this" is worth exactly the person,
    // and the panel would render "Confirmed on " with nothing after it.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: { proposed: 'X', state: 'confirmed', trail: [] },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/is confirmed but names nobody/i);
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  it('REFUSES a net position state it does not recognise, which would export as confirmed', async () => {
    // `netPositionLabel` emits its UNCONFIRMED caveat for the literal string
    // 'unconfirmed' and `null` for everything else — so an unrecognised state
    // is not exported as "unknown", it is exported with no caveat at all,
    // which a reader takes as a human having stood behind it.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: { proposed: 'X', state: 'agreed', trail: [] },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/not one of unconfirmed, confirmed/i);
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  it('REFUSES an amended net position with no text', async () => {
    // `amendPosition` throws `NetPositionError` for exactly this, so an
    // import that took it would produce through jsonb the one value the
    // constructor exists to prevent — an "AMENDED NET POSITION: this text was
    // rewritten by a person" caveat over an empty string.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const me = await aUser(t);
      const h = harness(t, me);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: {
            proposed: 'X', amended: '   ', state: 'confirmed', byUserId: me,
            at: 1_700_000_000_000, trail: [],
          },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/amended but the amendment has no text/i);
      await h.app.close();
    });
  });

  it('IMPORTS a net position the actor themselves confirmed, with the actor id on it', async () => {
    // The other half of the refusal: an uploader moving their own work must
    // still be able to move a position they themselves confirmed, keeping
    // their own instant. The id stored is the ACTOR'S — `vouchedContent`
    // rewrites the key rather than trusting the (already-refused) body value,
    // so there is no expression on this path a forged id could travel
    // through.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const me = await aUser(t);
      const h = harness(t, me);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: {
            proposed: 'The tenant may assign with consent, not to be unreasonably withheld.',
            state: 'confirmed', byUserId: me, at: 1_700_000_055_000, trail: [],
          },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const back = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, { netPosition: {
          state: string; byUserId: string; at: number } }>>;
      expect(back.d1.c1.netPosition.state).toBe('confirmed');
      expect(back.d1.c1.netPosition.byUserId).toBe(me);
      expect(back.d1.c1.netPosition.at).toBe(1_700_000_055_000);
      await h.app.close();
    });
  });

  it('keeps an UNCONFIRMED net position authorless rather than stamping the importer on it', async () => {
    // ABSENT, never `byUserId: undefined`. "Nobody has confirmed this" is a
    // different fact from "somebody did", and an import that helpfully filled
    // the field in would turn every imported synthesis into one a named
    // person appears to have stood behind.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const me = await aUser(t);
      const h = harness(t, me);
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: { proposed: 'X', state: 'unconfirmed', trail: [] },
        }) } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const back = (await h.get('/v1/reviews/r1/findings')).findings as
        Record<string, Record<string, { netPosition: Record<string, unknown> }>>;
      expect(back.d1.c1.netPosition.state).toBe('unconfirmed');
      expect('byUserId' in back.d1.c1.netPosition).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a byUserId that is not a uuid BY NAME, not with a Postgres error', async () => {
    /*
     * Final review m4. `upload/attribution.ts` rule 3 deliberately leaves a
     * browser-local `uid()` in place when it cannot map it, so this is the
     * shape a real upload produces. It used to reach `setDisposition`'s
     * `uuid` cast and fail with *"invalid input syntax for type uuid"* — a
     * Postgres error in front of a lawyer, from a module whose whole posture
     * is refusing by name.
     *
     * It is now refused by the same check as any other foreign author, which
     * is the honest reading: a local id is not the person signed in.
     */
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'verified', byUserId: 'k3f9x2', at: 1_700_000_040_000 },
          notes: [],
        }) } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.message).toMatch(/is not the person signed in/i);
      expect(res.json().error.message).not.toMatch(/invalid input syntax/i);
      await h.app.close();
    });
  });

  it('refuses an import it cannot store faithfully, by name, and saves nothing', async () => {
    // `importFindings` reads the map through `readFindingsBlob`, which
    // refuses a rejection with no reason, a note naming nobody, and a
    // findings key this review's own target does not explain. The refusal
    // has to name the cell — a Postgres constraint name in front of a lawyer
    // is what the error envelope exists to replace.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(),
        findings: { d1: { c1: finding({
          verification: { state: 'verified', at: 1_700_000_040_000 },
        }) } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/is verified but names nobody/);
      expect(res.json().error.message).not.toMatch(/fkey|constraint/i);
      // The whole transaction rolled back: no review, no findings.
      expect(await t.query("select 1 from review where id = 'r1'")).toHaveLength(0);
      expect(await t.query("select 1 from finding where review_id = 'r1'")).toHaveLength(0);
      await h.app.close();
    });
  });

  it('ACCEPTS an empty findings object, which claims nothing', async () => {
    // The other side of the refusal, so it cannot be read as "any `findings`
    // key is refused" — a caller with nothing to say about findings is not
    // making a claim about them, and neither an absent key nor an empty
    // object is a claim this route cannot keep.
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', { ...REVIEW(), findings: {} });
      expect(res.statusCode, res.body).toBe(200);
      await h.app.close();
    });
  });

  it('REFUSES a findings key that is not an object at all', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      const res = await h.raw('PUT', '/v1/reviews/r1', { ...REVIEW(), findings: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/findings is present and is not an object/i);
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
      }));
      expect(saved.target).toEqual(
        { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] });
      // The findings key a collection review uses is asserted where the
      // findings are: `findingsRead.pg.test.ts`, "assembles a collection
      // finding under the COLLECTION key, not a document id".
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

  it('THE ONE THAT MATTERS: a stale whole-review save cannot reach a human s verification', async () => {
    /*
     * The whole reason this table has an optimistic-concurrency token, and
     * TASK 22 ADDED A SECOND LOCK TO THE SAME DOOR.
     *
     * The token was earned by a run's debounced saver, which held its own
     * copy of the review, wrote the WHOLE record every two seconds, and knew
     * nothing about a verification somebody recorded in another tab. That
     * saver is gone (Task 18), a judgement is its own row (Task 19), and this
     * route now refuses a body carrying findings at all — so there are two
     * independent reasons a stale save cannot erase a judgement, and BOTH are
     * asserted, because either one alone would let the other rot.
     */
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      await aDocument(t, 'd1');
      const h = harness(t, await aUser(t));

      const running = await h.put('/v1/reviews/r1', REVIEW());
      // The run's findings, as rows. A person, elsewhere, verifies one.
      await seedFindingRows(t, 'r1', WS, DOCS_TARGET, {
        d1: { c1: finding({
          verification: { state: 'verified', byUserId: HUMAN, at: 1_700_000_009_000 },
        }) },
      }, HUMAN);

      // Somebody else writes the record — another tab recording that the
      // run finished. The version moves.
      await h.put('/v1/reviews/r1', { ...running, completedAt: 1_700_000_050_000 });

      // LOCK 1: this caller's save, built from the copy it has held all
      // along, is refused as stale before anything else is considered.
      const stale = await h.raw('PUT', '/v1/reviews/r1',
        { ...running, modelId: 'a-model-chosen-later' });
      expect(stale.statusCode, 'a stale save was applied').toBe(409);
      expect((await h.get('/v1/reviews/r1') as Review).modelId).toBe('test/model');

      // LOCK 2: even a save at the CURRENT version cannot carry a
      // verification, because it cannot carry findings.
      const current = await h.get('/v1/reviews/r1') as Review;
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        ...REVIEW(), version: current.version,
        findings: { d1: { c1: finding({ verification: { state: 'unchecked' } }) } },
      });
      expect(res.statusCode, 'a save carried a verification past the freeze').toBe(400);

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

      const target = { kind: 'documents' as const, documentIds: ['d1', 'd2'] };
      const first = await h.put('/v1/reviews/r1', REVIEW({ documentIds: ['d1', 'd2'], target }));
      // A judgement on the review, as a row — which is the only place one
      // lives now (Tasks 15, 19, 22).
      await seedFindingRows(t, 'r1', WS, target, {
        d1: { c1: finding({ verification: {
          state: 'flagged', byUserId: HUMAN, at: 1_700_000_099_000,
        } }) },
      }, HUMAN);

      // The delete the reviewer actually performs — the row goes, the review
      // is not touched.
      await t.query("delete from document where id = 'd2'");

      // …and the review is STILL SAVABLE. This is the assertion C1 exists
      // for: re-validating the ids the row already holds turned a review that
      // opens into one that can never be written again.
      const saved = await h.put('/v1/reviews/r1', {
        ...REVIEW({ documentIds: ['d1', 'd2'], target }),
        version: first.version,
      });
      expect(saved.documentIds).toEqual(['d1', 'd2']);

      // A guard against a lost human judgement that has never been seen to
      // fail is decoration, so this re-reads the row: the save went through
      // and the judgement is untouched by it.
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
