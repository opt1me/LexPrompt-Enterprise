import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { memoryBlobStore } from './helpers/memoryBlobs.ts';
import type { Tx } from '../src/db/pool.ts';
import type { PositionBasis } from '../src/routes/positionBasis.ts';

/**
 * §6.5 / §11.1: a house rule that can still show its evidence next year.
 *
 * *"A position adopted six months ago still resolves to the documents and the
 * specific edits that produced it, and a partner asking 'where did this house
 * rule come from?' gets the four leases and the four strikes rather than a
 * shrug."*
 *
 * Every test here is about a way that sentence could be false while a suite
 * stayed green: the evidence vanishing on a publish (P13's key), four leases
 * shown beside a sentence they never supported, an empty panel where a
 * disposal should be named, and a count nobody recomputed.
 */

const WS = '00000000-0000-0000-0000-000000000001';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-basis',
  groups: ['partners'],
};

const EDIT_1 = {
  documentId: 'p1', kind: 'deletion', source: 'tracked',
  text: 'in its absolute discretion',
  context: 'The landlord may withhold consent in its absolute discretion.',
  author: 'A Partner',
};

const ADOPTED = 'No unreasonable withholding.';

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'partner', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  raw(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; body: string; json(): any;
  }>;
  /** Creates a precedent set and one precedent document in it, through the
   *  real routes, so the foreign keys `position_basis` depends on are real. */
  seedPrecedents(setId: string, documentIds: string[]): Promise<void>;
  /** Publishes a version, carrying `basis` when supplied. */
  publish(clauseText: string | undefined, basis?: unknown[], summary?: string): Promise<any>;
  basis(clauseId?: string): Promise<PositionBasis>;
}

const BOUNDARY = '----lexpromptbasistest';

function harness(t: Tx, actorId: string): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    blobs: memoryBlobStore(),
    actor: {
      id: actorId, displayName: 'A Partner', initials: 'AP',
      role: 'partner', workspaceId: WS,
    },
  });
  const inject = (method: string, url: string, body?: unknown) =>
    app.inject({ method: method as never, url, headers: { authorization: 'Bearer t' }, payload: body as never });

  const playbook = () => ({
    id: 'p-book', name: 'Commercial Lease (Landlord)', createdAt: 1, updatedAt: 1,
    schemaVersion: 7,
  });
  const draft = (clauseText: string | undefined, summary: string) => ({
    name: 'Commercial Lease (Landlord)',
    contractType: 'Lease',
    systemPrompt: 'sys', formatPrompt: 'fmt',
    clauses: [{
      id: 'c1', title: 'Consent to assign', extractPrompt: 'What does it say?',
      ...(clauseText === undefined ? {} : {
        standardPosition: { text: clauseText, origin: 'learned', reviewedByHuman: true },
      }),
    }],
    changeSummary: summary,
  });

  return {
    app,
    async get(url) {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    raw: (method, url, body) => inject(method, url, body) as never,
    async seedPrecedents(setId, documentIds) {
      const set = await inject('POST', '/v1/precedent-sets',
        { id: setId, name: 'Brookvale precedents', createdAt: 1 });
      expect(set.statusCode, set.body).toBe(201);
      for (const id of documentIds) {
        const record = {
          id, name: `${id}.docx`, kind: 'docx', text: 'x', byteSize: 4, addedAt: 1,
        };
        const head = Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="record"\r\n\r\n`
          + `${JSON.stringify(record)}\r\n`
          + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="bytes"; filename="${id}.docx"\r\n`
          + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
        const res = await app.inject({
          method: 'POST', url: `/v1/precedent-sets/${setId}/documents`,
          headers: {
            authorization: 'Bearer t',
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          payload: Buffer.concat([head, Buffer.from('PKab'),
            Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8')]),
        });
        expect(res.statusCode, res.body).toBe(201);
      }
    },
    async publish(clauseText, basis, summary = 'a change') {
      const res = await inject('POST', '/v1/playbooks/p-book/versions', {
        playbook: playbook(), draft: draft(clauseText, summary),
        ...(basis === undefined ? {} : { basis }),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    async basis(clauseId = 'c1') {
      const res = await inject('GET', `/v1/playbooks/p-book/clauses/${clauseId}/basis`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as PositionBasis;
    },
  };
}

/** Four documents, four strikes — §11.1's own example. */
const FOUR = ['p1', 'p2', 'p3', 'p4'];

function basisPayload(documentIds: string[], over: Record<string, unknown> = {}): unknown[] {
  return documentIds.map(documentId => ({
    clauseId: 'c1',
    adoptedText: ADOPTED,
    precedentSetId: 's1',
    documentId,
    edits: [{ ...EDIT_1, documentId }],
    diffDerivedOnly: false,
    ...over,
  }));
}

describe('a position adopted six months ago still resolves to its documents', () => {
  it('resolves a position to its documents and its edits, after two more publishes', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', FOUR);
      await h.publish(ADOPTED, basisPayload(FOUR), '');

      // TWO MORE VERSIONS SINCE. This is the whole of P13: §6.5 writes the
      // key as `standard_position_id`, a `StandardPosition` has no id, and
      // keying on the VERSION would make the four leases disappear right
      // here — on a publish that changed nothing about this clause.
      await h.publish(ADOPTED, undefined, 'v2');
      await h.publish(ADOPTED, undefined, 'v3');

      const basis = await h.basis();
      expect(basis.recorded).toBe(true);
      expect(basis.resolvable).toBe(true);
      expect(basis.entries).toHaveLength(4);
      expect(basis.entries[0].documentId).toBe('p1');
      expect(basis.entries[0].documentName).toBe('p1.docx');
      expect((basis.entries[0].edits[0] as { text: string }).text).toBe(EDIT_1.text);
      expect((basis.entries[0].edits[0] as { author: string }).author).toBe('A Partner');
      // …and it still says which version adopted it, so "when did this
      // become a house rule?" is answerable too.
      expect(basis.adoptedInVersionId).toBeTruthy();
    });
  });

  it('records the basis in the SAME transaction as the publish', async () => {
    // A basis written outside the publish could survive a publish that
    // failed: evidence for a version nobody ever published. Forced by making
    // the version insert fail and checking nothing was recorded.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      // v1 with no change summary is fine; a SECOND version with an empty
      // one is refused by `publishInto` — after the identity upsert and
      // before the version insert, which is the window this is about.
      await h.publish(ADOPTED, undefined, '');
      const res = await h.raw('POST', '/v1/playbooks/p-book/versions', {
        playbook: { id: 'p-book', name: 'X', createdAt: 1, updatedAt: 1, schemaVersion: 7 },
        draft: {
          name: 'X', contractType: 'Lease', systemPrompt: 's', formatPrompt: 'f',
          clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }], changeSummary: '',
        },
        basis: basisPayload(['p1']),
      });
      expect(res.statusCode).toBe(400);
      const rows = await t.query("select 1 from position_basis where clause_id = 'c1'");
      expect(rows.length).toBe(0);
    });
  });

  it('says the wording has moved when the clause has been edited since adoption', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', FOUR);
      await h.publish(ADOPTED, basisPayload(FOUR), '');
      await h.publish('Consent not to be unreasonably withheld or delayed.', undefined, 'reworded');

      const basis = await h.basis();
      expect(basis.adoptedTextMatchesCurrent).toBe(false);
      expect(basis.adoptedText).toBe(ADOPTED);
      expect(basis.currentText).toBe('Consent not to be unreasonably withheld or delayed.');
      // Rendering four leases beside a sentence they never supported would be
      // exactly the confidently-wrong claim `positionHealth`'s wording scope
      // exists to prevent, one layer down. The evidence is still HERE — it is
      // still the honest answer to where the rule came from — and it is
      // labelled.
      expect(basis.entries).toHaveLength(4);
    });
  });

  it('says the wording has NOT moved when the clause still reads as adopted', async () => {
    // The positive half. Without it, an implementation that always answered
    // `false` would pass the test above and mark every position stale — which
    // reads as "nothing here can be trusted" and is its own quiet defect.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      await h.publish(ADOPTED, basisPayload(['p1']), '');
      expect((await h.basis()).adoptedTextMatchesCurrent).toBe(true);
    });
  });

  it('omits the comparison entirely when the current wording cannot be read', async () => {
    // ABSENT, not `false`. "The wording has moved" and "I could not tell" are
    // different facts, and only the first should render the comparison — the
    // same rule `positionOutcome.ts` applies to a missing outcome.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      await h.publish(undefined, basisPayload(['p1']), '');
      const basis = await h.basis();
      expect('adoptedTextMatchesCurrent' in basis).toBe(false);
      expect('currentText' in basis).toBe(false);
      expect(basis.adoptedText).toBe(ADOPTED);
    });
  });

  it('says the basis is UNRESOLVABLE when the precedent set has been deleted', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', FOUR);
      await h.publish(ADOPTED, basisPayload(FOUR), '');
      expect((await h.raw('DELETE', '/v1/precedent-sets/s1')).statusCode).toBe(204);

      const basis = await h.basis();
      expect(basis.resolvable).toBe(false);
      expect(basis.entries).toEqual([]);
      // §11.1: "delete the set and a position's basis becomes unresolvable
      // (and must then say so on screen rather than showing an empty evidence
      // panel — 'empty is not broken', again)." `recorded` is what makes the
      // two distinguishable at all: evidence WAS recorded, and it is gone.
      expect(basis.recorded).toBe(true);
      expect(basis.adoptedText).toBe(ADOPTED);
    });
  });

  it('is not the same answer as a clause that never had a basis', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.publish(ADOPTED, undefined, '');
      const basis = await h.basis();
      expect(basis.recorded).toBe(false);
      expect(basis.resolvable).toBe(true);
      expect(basis.entries).toEqual([]);
    });
  });

  it('404s for a playbook that does not exist, rather than an empty basis', async () => {
    // An empty basis for a missing playbook reads on screen as "no evidence
    // was recorded", which is a different fact entirely.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      expect((await h.raw('GET', '/v1/playbooks/nope/clauses/c1/basis')).statusCode).toBe(404);
    });
  });

  it('carries diffDerivedOnly through, so weaker evidence stays weaker', async () => {
    // `source: 'diff'` never wears `source: 'tracked'`'s confidence. A
    // position resting solely on diff-derived edits is flagged and rendered
    // as weaker evidence EVERYWHERE it appears — and "everywhere" now
    // includes a panel opened six months later.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1', 'p2']);
      await h.publish(ADOPTED, basisPayload(['p1', 'p2'], { diffDerivedOnly: true }), '');
      expect((await h.basis()).diffDerivedOnly).toBe(true);
    });
  });

  it('does not flag a position as diff-derived when any of its evidence is tracked', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1', 'p2']);
      await h.publish(ADOPTED, [
        ...basisPayload(['p1'], { diffDerivedOnly: true }),
        ...basisPayload(['p2'], { diffDerivedOnly: false }),
      ], '');
      expect((await h.basis()).diffDerivedOnly).toBe(false);
    });
  });
});

describe('nothing here records a strength, a supporting count or a total', () => {
  it('the TABLE has no column for one', async () => {
    // `strength.ts` computes them and the model never returns them. Storing
    // them here would create a second, frozen copy of the one number this
    // feature's credibility rests on — and it would be the copy nobody
    // recomputed. Asserted against the real schema, so adding such a column
    // is a test failure rather than a review catch.
    await withPg(async t => {
      const cols = await t.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'position_basis'`);
      const names = cols.map(c => c.column_name);
      expect(names).not.toContain('strength');
      expect(names).not.toContain('supporting');
      expect(names).not.toContain('total');
      // The positive half: the column that carries the evidence IS there, so
      // this cannot pass by the table having been renamed away.
      expect(names).toContain('edits');
      expect(names).toContain('adopted_text');
    });
  });

  it('DISCARDS a strength a caller volunteers, rather than storing it', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      await h.publish(ADOPTED, basisPayload(['p1'], {
        strength: 'consistent', supporting: 99, total: 99,
      }), '');
      const basis = await h.basis();
      const keys = Object.keys(basis);
      expect(keys).not.toContain('strength');
      expect(keys).not.toContain('supporting');
      expect(keys).not.toContain('total');
      // …and nothing of it reached the row, not even inside `edits`.
      const rows = await t.query<{ edits: unknown }>(
        "select edits from position_basis where clause_id = 'c1'");
      expect(JSON.stringify(rows[0].edits)).not.toContain('99');
      expect(JSON.stringify(rows[0].edits)).not.toContain('consistent');
    });
  });

  it('refuses a basis entry with no adoptedText rather than storing an empty one', async () => {
    // An empty `adopted_text` would make the "wording has moved" comparison
    // meaningless in the direction that matters: everything would look moved,
    // so nothing would.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      const res = await h.raw('POST', '/v1/playbooks/p-book/versions', {
        playbook: { id: 'p-book', name: 'X', createdAt: 1, updatedAt: 1, schemaVersion: 7 },
        draft: {
          name: 'X', contractType: 'Lease', systemPrompt: 's', formatPrompt: 'f',
          clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }], changeSummary: '',
        },
        basis: basisPayload(['p1'], { adoptedText: '   ' }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/adoptedText/);
    });
  });
});

describe('a basis is workspace-scoped and cannot be updated', () => {
  it('grants the app role insert, select and delete — never update', async () => {
    // Evidence recorded once, at the moment a position is adopted. A row that
    // could be edited afterwards is not evidence of anything.
    await withPg(async t => {
      const rows = await t.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_name = 'position_basis' and grantee = 'lexprompt_app'`);
      const granted = rows.map(r => r.privilege_type).sort();
      expect(granted).toEqual(['DELETE', 'INSERT', 'SELECT']);
    });
  });

  it('is deleted with its playbook, so a delete is honest about what it removes', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.seedPrecedents('s1', ['p1']);
      await h.publish(ADOPTED, basisPayload(['p1']), '');
      expect((await t.query("select 1 from position_basis where playbook_id = 'p-book'")).length)
        .toBe(1);
      expect((await h.raw('DELETE', '/v1/playbooks/p-book')).statusCode).toBe(204);
      expect((await t.query("select 1 from position_basis where playbook_id = 'p-book'")).length)
        .toBe(0);
    });
  });
});
