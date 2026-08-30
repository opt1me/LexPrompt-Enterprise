import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { PlaybookVersion } from '../src/db/rows.ts';

/**
 * What the API has to answer for when the UPLOADER (§13.1) is the caller.
 *
 * The uploader is unlike every other caller in one respect that matters
 * here: the records it sends name ids MINTED BY ANOTHER SYSTEM — this
 * browser's IndexedDB, over however many years a firm has been using
 * LexPrompt. So it is the one caller that can reach a foreign key with an id
 * that names nothing, and it is the one caller whose entire product is a
 * report saying, by name, what did not move and why. A 500 carrying
 * `violates foreign key constraint "changeset_from_version_id_fkey"` is true
 * and useless on that report.
 *
 * The other half of this file is the payload the uploader exists to move: a
 * review with a human's verification in it. Verification state is set only
 * by a human action and nothing derives it, so a review that arrives without
 * its verifications is a silent loss of exactly the judgement this app
 * exists to record — silent, because the review still opens, still reads and
 * still exports. Proven against a real Postgres, through the real jsonb
 * column, including an ABSENT optional key staying absent.
 */

const WS = '00000000-0000-0000-0000-000000000001';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-upload',
  groups: ['partners'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'partner', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

const IDENTITY = {
  id: 'p1', name: 'Retail lease', createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000, schemaVersion: 7,
};

const DRAFT = {
  name: 'Retail lease', contractType: 'Lease',
  systemPrompt: 'Be careful.', formatPrompt: 'Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Rent review', extractPrompt: 'What rent is payable?' }],
  changeSummary: '',
};

interface Harness {
  app: FastifyInstance;
  publish(): Promise<{ version: PlaybookVersion }>;
  raw(method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: { id: actorId, displayName: 'Test Partner', initials: 'TP', role: 'partner', workspaceId: WS },
  });
  const inject = (method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  return {
    app,
    async publish() {
      const res = await inject('POST', '/v1/playbooks/p1/versions', { playbook: IDENTITY, draft: DRAFT });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { version: PlaybookVersion };
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

async function aMatter(h: Harness): Promise<void> {
  const res = await h.raw('PUT', '/v1/matters/m1', {
    id: 'm1', name: 'Brookvale Retail Park', createdAt: 1_700_000_000_000,
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('an unrewritten id reaches a foreign key', () => {
  it('answers something a person can read, not a constraint name', async () => {
    // Exactly the uploader's failure mode: `Changeset.fromVersionId` still
    // holds the id this BROWSER minted, because the version-id remap missed
    // it. `changeset.from_version_id` is `not null references
    // playbook_version(id)`, and nothing in the route pre-checks it, so
    // Postgres raises 23503.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.publish();
      const res = await h.raw('PUT', '/v1/changesets/cs1', {
        id: 'cs1', playbookId: 'p1',
        fromVersionId: 'a-local-indexeddb-id-that-names-nothing',
        sourceSummary: 'Brookvale — our markup + executed',
        items: [], createdAt: 1_700_000_000_000, createdByUserId: '',
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('conflict');
      expect(body.error.message).toMatch(/names something LexPrompt does not know/);
      // The wording a reader gets is a sentence, not SQL. The constraint name
      // is still there for whoever has to diagnose it, but it is not what the
      // sentence is made of.
      expect(body.error.message).not.toMatch(/^insert or update on table/);
      // And it is NOT a 500: nothing is broken. The request named something
      // that is not there.
      expect(res.statusCode).not.toBe(500);
      await h.app.close();
    });
  });

  it('saves the changeset once the id names a version that is really there', async () => {
    // The positive half, so the case above is not passing because the route
    // refuses everything.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish();
      const res = await h.raw('PUT', '/v1/changesets/cs1', {
        id: 'cs1', playbookId: 'p1', fromVersionId: version.id,
        sourceSummary: 'Brookvale — our markup + executed',
        items: [], createdAt: 1_700_000_000_000, createdByUserId: '',
      });
      expect(res.statusCode, res.body).toBe(200);
      await h.app.close();
    });
  });
});

describe("a human's verification survives the upload", () => {
  const findings = {
    d1: {
      c1: {
        clauseId: 'c1', status: 'done',
        summary: 'Rent is reviewed every fifth year.',
        citations: [{ documentId: 'd1', quote: 'reviewed every fifth year', page: 4 }],
        verification: { state: 'verified', byUserId: '', at: 1_700_000_500_000 },
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Agreed with the partner.',
          byUserId: '', at: 1_700_000_600_000 }],
      },
      c2: {
        clauseId: 'c2', status: 'done',
        summary: 'Silent on service charge caps.',
        citations: [],
        verification: { state: 'rejected', byUserId: '', at: 1_700_000_700_000,
          reason: 'The cap is in the sixth schedule.' },
        notes: [],
      },
    },
  };

  it('round-trips every verification, reason and note through the jsonb column', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const h = harness(t, actor);
      await aMatter(h);
      const { version } = await h.publish();
      // The uploader rewrites attribution before sending, so what arrives
      // names the signed-in user. Written that way here on purpose: the
      // server does NOT look inside `findings`, which is exactly why the
      // browser has to.
      const withActor = JSON.parse(
        JSON.stringify(findings).replaceAll('"byUserId":""', `"byUserId":"${actor}"`),
      ) as unknown;
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        id: 'r1', matterId: 'm1', playbookSnapshot: version, playbookVersionId: version.id,
        documentIds: [], target: { kind: 'documents', documentIds: [] },
        findings: withActor, modelId: 'model', startedAt: 1_700_000_000_000,
        createdByUserId: '',
      });
      expect(res.statusCode, res.body).toBe(200);

      // TASK 14: read back from the ROWS, which is where a verification and
      // a note now live. `GET /v1/reviews/:id` no longer carries the blob at
      // all — and reading them back from the tables is the stronger claim
      // this test was always making: the upload's judgements survived into
      // `finding_disposition` and `note`, not merely into a jsonb column.
      const read = (await h.raw('GET', '/v1/reviews/r1/findings')).json() as
        { findings: unknown };
      const stored = read.findings as unknown as typeof findings;
      expect(stored.d1.c1.verification.state).toBe('verified');
      expect(stored.d1.c1.verification.byUserId).toBe(actor);
      expect(stored.d1.c1.verification.at).toBe(1_700_000_500_000);
      expect(stored.d1.c1.notes[0].text).toBe('Agreed with the partner.');
      expect(stored.d1.c1.notes[0].byUserId).toBe(actor);
      expect(stored.d1.c2.verification.state).toBe('rejected');
      expect(stored.d1.c2.verification.reason).toBe('The cap is in the sixth schedule.');
      expect(stored.d1.c1.citations[0].quote).toBe('reviewed every fifth year');

      // An ABSENT optional key stays absent. `toEqual` cannot tell an absent
      // key from an `undefined` one, so the assertion is written the one way
      // that can — and it is load-bearing rather than decorative: a
      // `reason: undefined` on a VERIFIED finding would read back as a claim
      // that a reason was recorded and was empty.
      expect('reason' in stored.d1.c1.verification).toBe(false);
      expect('assigneeId' in stored.d1.c1.verification).toBe(false);
      await h.app.close();
    });
  });

  it('refuses the review rather than storing a version pointer that names nothing', async () => {
    // The other half of the remap. This refusal is why the uploader drops an
    // unmappable `playbookVersionId` and says so on the report, instead of
    // losing a whole review — verifications included — to save a pointer
    // that was already dangling in the browser.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await aMatter(h);
      const { version } = await h.publish();
      const res = await h.raw('PUT', '/v1/reviews/r1', {
        id: 'r1', matterId: 'm1', playbookSnapshot: version,
        playbookVersionId: 'a-local-indexeddb-id-that-names-nothing',
        documentIds: [], target: { kind: 'documents', documentIds: [] },
        findings: {}, modelId: 'model', startedAt: 1_700_000_000_000, createdByUserId: '',
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { message: string } }).error.message)
        .toMatch(/no longer here/);
      await h.app.close();
    });
  });
});
