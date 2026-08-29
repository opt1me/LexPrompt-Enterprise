import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { memoryBlobStore, type MemoryBlobStore } from './helpers/memoryBlobs.ts';
import { blobKeyFor } from '../src/blob/store.ts';
import type { Tx } from '../src/db/pool.ts';
import type { PrecedentDocumentRecord, PrecedentSet } from '../src/db/rows.ts';

/**
 * §11.1 / S23: a precedent document is STORED, and is never a matter
 * document.
 *
 * Both halves, in one file, because either alone is a different bug with the
 * same green suite:
 *
 *  - Only the negatives ("a precedent is never offered as a review target")
 *    would pass over an implementation that filtered `kind = 'matter'`
 *    everywhere and made precedents unreachable — storage nobody can read.
 *  - Only the positives would pass over the founding failure this ruling
 *    exists to prevent: another client's marked-up lease sitting in a
 *    matter's document list, openable as though it were the deal under
 *    review.
 *
 * And the refusals are asserted as REFUSALS, not as absences. §11.1:
 * *"refused by the API rather than merely absent from a picker."* A picker
 * that omits a document is a UI convention; a 400 is a control.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-precedent',
  groups: ['reviewers'],
};

const BOUNDARY = '----lexpromptprecedenttest';

function multipart(record: unknown, bytes: Buffer, filename = 'markup.docx', mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'): {
  payload: Buffer; headers: Record<string, string>;
} {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="record"\r\n\r\n`
    + `${JSON.stringify(record)}\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="bytes"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

const SET = { id: 's1', name: 'Brookvale precedents', createdAt: 1_700_000_000_000 };

const PRECEDENT = {
  id: 'p1', name: 'Brookvale - our markup.docx', kind: 'docx',
  text: 'The tenant shall not unreasonably withhold…', byteSize: 9,
  addedAt: 1_700_000_000_000,
};

interface Harness {
  app: FastifyInstance;
  blobs: MemoryBlobStore;
  get(url: string): Promise<any>;
  raw(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; body: string; rawPayload: Buffer; json(): any;
  }>;
  postSet(record?: unknown): Promise<PrecedentSet>;
  postPrecedent(setId: string, record?: unknown, bytes?: Buffer): Promise<PrecedentDocumentRecord>;
  rawPostPrecedent(setId: string, record?: unknown, bytes?: Buffer): Promise<{
    statusCode: number; body: string; json(): any;
  }>;
}

function harness(t: Tx, actorId: string, opts: { blobs?: MemoryBlobStore } = {}): Harness {
  const blobs = opts.blobs ?? memoryBlobStore();
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    blobs,
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: string, url: string, body?: unknown) =>
    app.inject({ method: method as never, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  const injectForm = (url: string, record: unknown, bytes: Buffer) => {
    const form = multipart(record, bytes);
    return app.inject({
      method: 'POST', url,
      headers: { authorization: 'Bearer t', ...form.headers },
      payload: form.payload,
    });
  };
  return {
    app,
    blobs,
    async get(url) {
      const res = await inject('GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    raw: (method, url, body) => inject(method, url, body) as never,
    async postSet(record = SET) {
      const res = await inject('POST', '/v1/precedent-sets', record);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as PrecedentSet;
    },
    async postPrecedent(setId, record = PRECEDENT, bytes = Buffer.from('PKabc')) {
      const res = await injectForm(
        `/v1/precedent-sets/${setId}/documents`, record, bytes);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as PrecedentDocumentRecord;
    },
    rawPostPrecedent: (setId, record = PRECEDENT, bytes = Buffer.from('PKabc')) =>
      injectForm(`/v1/precedent-sets/${setId}/documents`, record, bytes) as never,
  };
}

async function aMatter(t: Tx, id = 'm1', ws = WS): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now())`, [id, ws]);
}

async function aMatterDocument(t: Tx, id: string, matterId = 'm1'): Promise<void> {
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', $3, $4, 'pdf', 'x', 'parsed', 4, 'application/pdf', $5,
             'standalone', now())`,
    [id, WS, matterId, `${id}.pdf`, blobKeyFor(WS, id)]);
}

async function aVersion(t: Tx): Promise<void> {
  await t.query(
    `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
     values ('pb1', $1, 'PB', now(), now(), 7)`, [WS]);
  await t.query(
    `insert into playbook_version (id, workspace_id, playbook_id, version_number, content,
                                   published_at)
     values ('v1', $1, 'pb1', 1, '{}'::jsonb, now())`, [WS]);
}

const REVIEW = (over: Record<string, unknown>) => ({
  id: 'r1', matterId: 'm1', playbookSnapshot: {}, playbookVersionId: 'v1',
  documentIds: [], target: { kind: 'documents', documentIds: [] }, findings: {},
  modelId: 'test/model', startedAt: 1_700_000_000_000, createdByUserId: '',
  ...over,
});

const COLLECTION = (over: Record<string, unknown>) => ({
  id: 'c1', matterId: 'm1', name: 'Lease + DoV', baseDocumentId: 'd-base',
  variesDocumentIds: [], createdAt: 1_700_000_000_000, createdByUserId: '',
  ...over,
});

describe('a precedent document is a document, and is not a matter document', () => {
  it('stores a precedent with a set and no matter', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.postSet();
      const doc = await h.postPrecedent('s1');
      // The brief for this task writes `expect(doc.kind).toBe('precedent')`.
      // That cannot be satisfied against the shipped types and the shipped
      // source wins: `DocumentRecord.kind` is the FILE type, which the
      // `document` table calls `doc_type`, and `kind` is the COLUMN this
      // task adds. `rows.ts` names the column `storedAs` on the wire for
      // exactly that reason — two facts with one word is what 002's own
      // comment refused to allow in the schema.
      expect(doc.storedAs).toBe('precedent');
      expect(doc.kind).toBe('docx');
      expect(doc.precedentSetId).toBe('s1');
      // ABSENT, not `matterId: undefined`. "Belongs to no matter" and "I
      // forgot to say which matter" must not arrive in one shape.
      expect('matterId' in doc).toBe(false);
      // Stored: the row AND the bytes, under the same one key derivation
      // every other document uses.
      expect(h.blobs.keys()).toEqual([blobKeyFor(WS, 'p1')]);
      const rows = await t.query<{ kind: string; matter_id: string | null }>(
        "select kind, matter_id from document where id = 'p1'");
      expect(rows[0]).toEqual({ kind: 'precedent', matter_id: null });
    });
  });

  it('refuses a precedent row with a matter_id', async () => {
    await withPg(async t => {
      await aMatter(t);
      await t.query(
        `insert into precedent_set (id, workspace_id, name, created_at)
         values ('s1', $1, 'S', now())`, [WS]);
      await expect(t.query(
        `insert into document (id, workspace_id, kind, matter_id, precedent_set_id, name, doc_type,
                               text, parse_state, byte_size, mime, blob_key, role, added_at)
         values ('x', $1, 'precedent', 'm1', 's1', 'D', 'docx', 't', 'parsed', 1, 'm', 'k',
                 'standalone', now())`,
        [WS])).rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a matter row with a precedent_set_id', async () => {
    await withPg(async t => {
      await aMatter(t);
      await t.query(
        `insert into precedent_set (id, workspace_id, name, created_at)
         values ('s1', $1, 'S', now())`, [WS]);
      await expect(t.query(
        `insert into document (id, workspace_id, kind, matter_id, precedent_set_id, name, doc_type,
                               text, parse_state, byte_size, mime, blob_key, role, added_at)
         values ('x', $1, 'matter', 'm1', 's1', 'D', 'docx', 't', 'parsed', 1, 'm', 'k',
                 'standalone', now())`,
        [WS])).rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a matter row with NO matter_id', async () => {
    // Not a nullable matter_id alone (§11.1): the constraint has to bite in
    // both directions, or "a document with no matter" quietly becomes a
    // third state nothing filters.
    await withPg(async t => {
      await expect(t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type,
                               text, parse_state, byte_size, mime, blob_key, role, added_at)
         values ('x', $1, 'matter', null, 'D', 'docx', 't', 'parsed', 1, 'm', 'k',
                 'standalone', now())`,
        [WS])).rejects.toThrow(/check constraint/i);
    });
  });

  it('a precedent NEVER appears in a matter document list', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postPrecedent('s1');
      expect(await h.get('/v1/matters/m1/documents')).toEqual([]);
    });
  });

  it('refuses a precedent by DIRECT id fetch through the matter-document route', async () => {
    // The predicate has to be on the READ as well as on the list, or a deep
    // link is a way round it.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postPrecedent('s1');
      expect((await h.raw('GET', '/v1/documents/p1')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/documents/p1/bytes')).statusCode).toBe(404);
      expect((await h.raw('DELETE', '/v1/documents/p1')).statusCode).toBe(404);
      expect((await h.raw('PATCH', '/v1/documents/p1/role', { role: 'standalone' })).statusCode)
        .toBe(404);
      // …and it is still there afterwards. A 404 from a DELETE that had
      // already deleted the row would be the worst of both.
      const rows = await t.query("select 1 from document where id = 'p1'");
      expect(rows.length).toBe(1);
    });
  });

  it('REFUSES a precedent as a review target — not merely absent from a picker', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aVersion(t);
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postPrecedent('s1');
      const res = await h.raw('PUT', '/v1/reviews/r1', REVIEW({
        documentIds: ['p1'],
        target: { kind: 'documents', documentIds: ['p1'] },
      }));
      expect(res.statusCode).toBe(400);
      // NAMES it as a precedent. A generic "not in this matter" would send
      // someone hunting for a document sitting in front of them on the
      // playbook side of the app.
      expect(res.json().error.message).toMatch(/precedent/i);
      expect(res.json().error.message).toMatch(/p1/);
      expect((await t.query("select 1 from review where id = 'r1'")).length).toBe(0);
    });
  });

  it('REFUSES a precedent as a collection member, base or varies', async () => {
    await withPg(async t => {
      await aMatter(t);
      await aMatterDocument(t, 'd-base');
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postPrecedent('s1');
      for (const body of [{ baseDocumentId: 'p1' }, { variesDocumentIds: ['p1'] }]) {
        const res = await h.raw('PUT', '/v1/collections/c1', COLLECTION(body));
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error.message).toMatch(/precedent/i);
      }
      expect((await t.query("select 1 from collection where id = 'c1'")).length).toBe(0);
    });
  });

  it('serves a precedent through its OWN route, so the workings can still show it', async () => {
    // The positive half. Without it, a `kind` predicate on every route would
    // pass all of the above and make precedents unreachable — which is a
    // different bug with the same green suite.
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postPrecedent('s1', PRECEDENT, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const res = await h.raw('GET', '/v1/precedent-documents/p1');
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toBe(PRECEDENT.text);
      // …and its bytes, which is what makes "re-run the inference without
      // re-uploading" true rather than aspirational.
      const bytes = await h.raw('GET', '/v1/precedent-documents/p1/bytes');
      expect(bytes.statusCode).toBe(200);
      expect([...bytes.rawPayload]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(await h.get('/v1/precedent-sets/s1/documents')).toHaveLength(1);
    });
  });

  it('refuses a MATTER document through the precedent route', async () => {
    // The mirror of the deep-link test above. A live matter document read
    // through the playbook side would be a client's own deal shown as
    // learning material.
    await withPg(async t => {
      await aMatter(t);
      await aMatterDocument(t, 'd1');
      const h = harness(t, await aUser(t));
      expect((await h.raw('GET', '/v1/precedent-documents/d1')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/precedent-documents/d1/bytes')).statusCode).toBe(404);
    });
  });

  it('deleting a precedent set deletes its documents and their blobs', async () => {
    await withPg(async t => {
      const blobs = memoryBlobStore();
      const h = harness(t, await aUser(t), { blobs });
      await h.postSet();
      await h.postPrecedent('s1');
      await h.postPrecedent('s1', { ...PRECEDENT, id: 'p2', name: 'Ashfield.docx' });
      expect(blobs.keys()).toHaveLength(2);

      expect((await h.raw('DELETE', '/v1/precedent-sets/s1')).statusCode).toBe(204);
      expect((await t.query("select 1 from document where precedent_set_id = 's1'")).length).toBe(0);
      expect(blobs.keys()).toEqual([]);
      expect((await h.raw('GET', '/v1/precedent-sets/s1')).statusCode).toBe(404);
    });
  });

  it('answers 404 for a set in another workspace, and never confirms it exists', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await t.query(
        `insert into precedent_set (id, workspace_id, name, created_at)
         values ('s-theirs', $1, 'Theirs', now())`, [OTHER_WS]);
      const h = harness(t, await aUser(t));
      expect((await h.raw('GET', '/v1/precedent-sets/s-theirs')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/precedent-sets/s-theirs/documents')).statusCode).toBe(404);
      expect((await h.rawPostPrecedent('s-theirs')).statusCode).toBe(404);
      // On the MIGRATOR's connection: seeding a second workspace is a schema
      // owner's act, and the app role is deliberately refused it
      // (`identity.pg.test.ts` asserts that refusal directly). Same pattern
      // as `documents.pg.test.ts`'s cross-workspace tests.
    }, migratorDb());
  });

  it('an unknown set is 404 for the LIST, not an empty array', async () => {
    // Empty is not broken. A set that does not exist answering `[]` reads on
    // screen as "nothing brought in yet".
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      expect((await h.raw('GET', '/v1/precedent-sets/nope/documents')).statusCode).toBe(404);
    });
  });

  it('stores no bytes for an upload into a set that does not exist', async () => {
    // The blob-first ordering means everything that can refuse has to run
    // BEFORE the put — an unauthorised upload must not leave its bytes
    // behind. Shared with the matter path through `ingest.ts`; asserted here
    // because the precedent route supplies its own pre-check.
    await withPg(async t => {
      const blobs = memoryBlobStore();
      const h = harness(t, await aUser(t), { blobs });
      expect((await h.rawPostPrecedent('nope')).statusCode).toBe(404);
      expect(blobs.keys()).toEqual([]);
    });
  });

  it('takes the set from the URL and DISCARDS a set id in the body', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      await h.postSet();
      await h.postSet({ ...SET, id: 's2', name: 'Other set' });
      const doc = await h.postPrecedent('s1', { ...PRECEDENT, precedentSetId: 's2' });
      expect(doc.precedentSetId).toBe('s1');
    });
  });

  it('attributes the upload to the TOKEN, never to the body', async () => {
    await withPg(async t => {
      const actor = await aUser(t);
      const h = harness(t, actor);
      await h.postSet();
      const doc = await h.postPrecedent('s1', { ...PRECEDENT, addedByUserId: 'someone-else' });
      expect(doc.addedByUserId).toBe(actor);
    });
  });

  it('a precedent id collides with a matter document id, and neither wins by accident', async () => {
    // `document.id` is a global primary key, so the id checks on the ingest
    // path must NOT be scoped by `kind` — otherwise the insert fails on the
    // primary key AFTER the blob has been written.
    await withPg(async t => {
      await aMatter(t);
      await aMatterDocument(t, 'dup');
      const blobs = memoryBlobStore();
      const h = harness(t, await aUser(t), { blobs });
      await h.postSet();
      const res = await h.rawPostPrecedent('s1', { ...PRECEDENT, id: 'dup' });
      expect(res.statusCode).toBe(409);
      // Nothing stored — in particular, the matter document's own bytes were
      // not overwritten before the refusal.
      expect(blobs.keys()).toEqual([]);
    });
  });
});
