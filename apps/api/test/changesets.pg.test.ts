import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { Changeset, Playbook, PlaybookVersion } from '../src/db/rows.ts';

/**
 * `changesets` end to end, against a real Postgres.
 *
 * The centre of this file is the stale-base refusal: what it refuses, what
 * it leaves behind, and — the part that is really about the wire — that the
 * CODE is the contract and the message is not.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-changesets',
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
  id: 'p1', name: 'Commercial Lease', createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000, schemaVersion: 7,
};

const DRAFT = {
  name: 'Commercial Lease', contractType: 'Lease',
  systemPrompt: 'Be careful.', formatPrompt: 'Quote verbatim.',
  clauses: [
    { id: 'c-break', title: 'Break', extractPrompt: 'What is the break right?' },
    { id: 'c-rent', title: 'Rent', extractPrompt: 'What rent is payable?' },
  ],
  changeSummary: '',
};

/** An item against an EXISTING clause. */
const drift = (clauseId: string, decision: string, over: Record<string, unknown> = {}) => ({
  id: `i-${clauseId}`, kind: 'drift', clauseId,
  currentText: 'The standing position.',
  proposedText: `A proposal for ${clauseId} nobody should see published unless accepted.`,
  rationale: 'Raised in this deal.',
  basis: [{ documentId: 'd1', kind: 'insertion', text: 'e', context: 'e', source: 'tracked' }],
  decision, ...over,
});

const newClause = (title: string, decision: string, over: Record<string, unknown> = {}) => ({
  id: `i-${title}`, kind: 'new_clause', title,
  proposedText: `A ${title} position.`,
  rationale: 'Raised in this deal.',
  basis: [{ documentId: 'd1', kind: 'insertion', text: 'e', context: 'e',
    clauseRef: title, source: 'tracked' }],
  decision, ...over,
});

interface Harness {
  app: FastifyInstance;
  get(url: string): Promise<any>;
  publish(id: string, draft?: unknown, identity?: unknown): Promise<{
    playbook: Playbook; version: PlaybookVersion;
  }>;
  put(url: string, body: unknown): Promise<any>;
  raw(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string, role: 'reviewer' | 'partner' = 'partner'): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'Test Partner', initials: 'TP', role, workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) =>
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
    async publish(id, draft = DRAFT, identity = { ...IDENTITY, id }) {
      const res = await inject('POST', `/v1/playbooks/${id}/versions`, { playbook: identity, draft });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { playbook: Playbook; version: PlaybookVersion };
    },
    raw: (method, url, body) => inject(method, url, body) as never,
  };
}

const changesetFor = (versionId: string, items: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'cs1', playbookId: 'p1', fromVersionId: versionId,
  sourceSummary: 'Brookvale Retail Park — our markup + executed, Jul 2026',
  items, createdAt: 1_700_000_000_000, createdByUserId: '', ...over,
});

describe('saving and reading a changeset', () => {
  it('round-trips a changeset through Postgres, items and order unchanged', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1');
      const items = [drift('c-break', 'accepted'), newClause('Service charge', 'declined')];
      const saved = await h.put('/v1/changesets/cs1', changesetFor(version.id, items)) as Changeset;
      expect(await h.get('/v1/changesets/cs1')).toEqual(saved);
      expect((saved.items as { id: string }[]).map(i => i.id))
        .toEqual(['i-c-break', 'i-Service charge']);
      // Never published, so the key is ABSENT rather than null.
      expect('publishedVersionId' in saved).toBe(false);
      await h.app.close();
    });
  });

  it('records the AUTHENTICATED actor as the author, not whoever the body named', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const { version } = await h.publish('p1');
      const saved = await h.put('/v1/changesets/cs1',
        changesetFor(version.id, [], { createdByUserId: someoneElse })) as Changeset;
      expect(saved.createdByUserId).toBe(actor);
      await h.app.close();
    });
  });

  it('cannot stamp publishedVersionId from the body — only a publish sets it', async () => {
    // A changeset claiming to have been published, with no version behind
    // the claim, is a reviewer told their decisions were acted on when they
    // were not.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1');
      const saved = await h.put('/v1/changesets/cs1',
        changesetFor(version.id, [], { publishedVersionId: 'made-up' })) as Changeset;
      expect('publishedVersionId' in saved).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a changeset with no fromVersionId, rather than storing one that names nothing', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.publish('p1');
      const res = await h.raw('PUT', '/v1/changesets/cs1',
        { ...changesetFor('v', []), fromVersionId: '' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/fromVersionId/);
      await h.app.close();
    });
  });

  it('refuses an item whose decision is not one of the four', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1');
      const res = await h.raw('PUT', '/v1/changesets/cs1',
        changesetFor(version.id, [drift('c-break', 'maybe')]));
      expect(res.statusCode).toBe(400);
      await h.app.close();
    });
  });

  it('refuses a stale save with 409 and returns the current row (P9)', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version } = await h.publish('p1');
      const first = await h.put('/v1/changesets/cs1',
        changesetFor(version.id, [drift('c-break', 'open')])) as Changeset;
      expect(first.version).toBe(1);
      await h.put('/v1/changesets/cs1',
        { ...first, items: [drift('c-break', 'accepted')] });
      const res = await h.raw('PUT', '/v1/changesets/cs1',
        { ...first, items: [drift('c-break', 'declined')] });
      expect(res.statusCode).toBe(409);
      // …and the stale decision did NOT land over the newer one.
      const now = await h.get('/v1/changesets/cs1') as Changeset;
      expect((now.items as { decision: string }[])[0].decision).toBe('accepted');
      await h.app.close();
    });
  });

  it('never reads or writes a changeset across workspaces', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
         values ('foreign-pb', $1, 'Theirs', now(), now(), 7)`, [OTHER_WS]);
      await t.query(
        `insert into playbook_version (id, workspace_id, playbook_id, version_number, content, published_at)
         values ('fv', $1, 'foreign-pb', 1, '{}'::jsonb, now())`, [OTHER_WS]);
      await t.query(
        `insert into changeset (id, workspace_id, playbook_id, from_version_id, source_summary, created_at)
         values ('foreign', $1, 'foreign-pb', 'fv', 'Theirs', now())`, [OTHER_WS]);
      const h = harness(t, await aUser(t));

      expect((await h.raw('GET', '/v1/changesets/foreign')).statusCode).toBe(404);
      expect((await h.get('/v1/playbooks/foreign-pb/changesets') as Changeset[])).toEqual([]);
      const res = await h.raw('PUT', '/v1/changesets/foreign',
        { ...changesetFor('fv', []), id: 'foreign' });
      expect(res.statusCode).toBe(409);
      expect('current' in res.json()).toBe(false);
      expect((await h.raw('POST', '/v1/changesets/foreign/publish')).statusCode).toBe(404);
      const still = await t.query<{ source_summary: string }>(
        "select source_summary from changeset where id = 'foreign'");
      expect(still[0].source_summary).toBe('Theirs');
      await h.app.close();
    }, migratorDb());
  });
});

describe('publishing a changeset', () => {
  it('publishes ONLY accepted and reworded items, and stamps the changeset in the same transaction', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      const items = [
        drift('c-break', 'accepted'),
        drift('c-rent', 'declined'),
        newClause('Service charge', 'reworded', { rewordedText: 'The words a person wrote.' }),
      ];
      await h.put('/v1/changesets/cs1', changesetFor(v1.id, items));

      const res = await h.raw('POST', '/v1/changesets/cs1/publish');
      expect(res.statusCode, res.body).toBe(200);
      const v2 = res.json() as PlaybookVersion;
      expect(v2.version).toBe(2);

      const clauses = v2.clauses as { id: string; title: string;
        standardPosition?: { text: string; origin: string; reviewedByHuman: boolean } }[];
      // The accepted item's position landed…
      expect(clauses.find(c => c.id === 'c-break')!.standardPosition!.text)
        .toBe('A proposal for c-break nobody should see published unless accepted.');
      // …the DECLINED one's did not. A person's explicit "no" must not reach
      // the instrument every future review measures documents against.
      expect(clauses.find(c => c.id === 'c-rent')!.standardPosition).toBeUndefined();
      // …and the reworded item published the HUMAN's words, not the model's.
      const added = clauses.find(c => c.title === 'Service charge')!;
      expect(added.standardPosition!.text).toBe('The words a person wrote.');
      expect(added.standardPosition!.origin).toBe('learned');
      expect(added.standardPosition!.reviewedByHuman).toBe(true);

      // The changeset is stamped INSIDE the same transaction. In the browser
      // this was a second write after the publish returned.
      expect((await h.get('/v1/changesets/cs1') as Changeset).publishedVersionId).toBe(v2.id);
      // …and the playbook points at the new version.
      expect((await h.get('/v1/playbooks/p1') as Playbook).currentVersionId).toBe(v2.id);
      await h.app.close();
    });
  });

  it('refuses a publish whose fromVersionId is no longer the playbook s current version', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1',
        changesetFor(v1.id, [drift('c-break', 'accepted')]));
      // Somebody else publishes v2 from the editor.
      const before = await h.get('/v1/playbooks/p1') as Playbook;
      await h.publish('p1', { ...DRAFT, changeSummary: 'Somebody else got here first.' },
        { ...IDENTITY, version: before.version });

      const res = await h.raw('POST', '/v1/changesets/cs1/publish');
      expect(res.statusCode).toBe(409);
      // THE CONTRACT. Not the message.
      expect(res.json().error.code).toBe('changeset_stale_base');
      // The message names BOTH versions, because "stale" with no numbers
      // tells a person nothing they can act on. Nothing CLASSIFIES on this.
      expect(res.json().error.message).toMatch(/v1[\s\S]*v2|v2[\s\S]*v1/);
      await h.app.close();
    });
  });

  it('publishes nothing at all when it refuses, and loses no decision', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1',
        changesetFor(v1.id, [drift('c-break', 'accepted'), drift('c-rent', 'declined')]));
      const before = await h.get('/v1/playbooks/p1') as Playbook;
      await h.publish('p1', { ...DRAFT, changeSummary: 'Somebody else got here first.' },
        { ...IDENTITY, version: before.version });

      expect((await h.raw('POST', '/v1/changesets/cs1/publish')).statusCode).toBe(409);

      const numbers = (await h.get('/v1/playbooks/p1/versions') as PlaybookVersion[])
        .map(v => v.version).sort();
      expect(numbers).toEqual([1, 2]);
      // The review work is the expensive part and must not be lost.
      const cs = await h.get('/v1/changesets/cs1') as Changeset;
      expect((cs.items as { decision: string }[]).map(i => i.decision))
        .toEqual(['accepted', 'declined']);
      expect('publishedVersionId' in cs).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a changeset with any OPEN item, and publishes nothing', async () => {
    // "Not yet decided" is not "declined".
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1',
        changesetFor(v1.id, [drift('c-break', 'accepted'), drift('c-rent', 'open')]));
      const res = await h.raw('POST', '/v1/changesets/cs1/publish');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/undecided/i);
      expect((await h.get('/v1/playbooks/p1/versions') as PlaybookVersion[])).toHaveLength(1);
      await h.app.close();
    });
  });

  it('carries every clause the changeset never mentioned forward unchanged', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1', changesetFor(v1.id, [drift('c-break', 'accepted')]));
      const v2 = (await h.raw('POST', '/v1/changesets/cs1/publish')).json() as PlaybookVersion;
      const rent = (v2.clauses as { id: string; title: string; extractPrompt: string }[])
        .find(c => c.id === 'c-rent')!;
      expect(rent).toEqual(DRAFT.clauses[1]);
      await h.app.close();
    });
  });

  it('composes a change summary naming the deal and what was decided', async () => {
    // A version history whose entries do not say what changed is a list of
    // dates — and this publish path cannot ask a person for one.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1', changesetFor(v1.id, [
        drift('c-break', 'accepted'),
        newClause('Service charge', 'reworded', { rewordedText: 'x' }),
      ]));
      const v2 = (await h.raw('POST', '/v1/changesets/cs1/publish')).json() as PlaybookVersion;
      expect(v2.changeSummary).toBe(
        'Changeset from Brookvale Retail Park — our markup + executed, Jul 2026 '
        + '— 1 accepted, 1 reworded.');
      await h.app.close();
    });
  });

  it('needs the partner role to publish, and a reviewer may still save decisions', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const partner = harness(t, actor, 'partner');
      const { version: v1 } = await partner.publish('p1');
      await partner.app.close();

      const reviewer = harness(t, actor, 'reviewer');
      // A reviewer records decisions…
      const saved = await reviewer.put('/v1/changesets/cs1',
        changesetFor(v1.id, [drift('c-break', 'accepted')]));
      expect(saved.id).toBe('cs1');
      // …and cannot publish them.
      expect((await reviewer.raw('POST', '/v1/changesets/cs1/publish')).statusCode).toBe(403);
      expect((await reviewer.get('/v1/playbooks/p1/versions') as PlaybookVersion[]))
        .toHaveLength(1);
      await reviewer.app.close();
    });
  });

  it('records the AUTHENTICATED actor as the publisher', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const h = harness(t, actor);
      const { version: v1 } = await h.publish('p1');
      await h.put('/v1/changesets/cs1', changesetFor(v1.id, [drift('c-break', 'accepted')]));
      const v2 = (await h.raw('POST', '/v1/changesets/cs1/publish')).json() as PlaybookVersion;
      expect(v2.publishedByUserId).toBe(actor);
      await h.app.close();
    });
  });
});
