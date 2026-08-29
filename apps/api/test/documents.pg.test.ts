import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { memoryBlobStore, type MemoryBlobStore } from './helpers/memoryBlobs.ts';
import { blobKeyFor } from '../src/blob/store.ts';
import type { Db, Tx } from '../src/db/pool.ts';
import type { DocumentRecord } from '../src/db/rows.ts';

/**
 * `documents` and their bytes end to end: the REAL routes, the REAL SQL, the
 * REAL Postgres — and an in-memory blob store, because the questions this
 * file asks about storage are about ORDER and about failure, and neither can
 * be asked of Azurite without a fault injector it does not have.
 *
 * The bytes themselves go through real Azurite in `blobStore.compose.test.ts`
 * (0x00 and 0xFF, from inside the container) and the cascade reaches real
 * Azurite in `cascade.compose.test.ts`. What is here is everything those two
 * cannot see.
 */

// The seeded workspace (§6), as `matters.pg.test.ts` names it. Not
// `apiHarness`'s `WORKSPACE_ID`, which is a readable stand-in rather than a
// uuid the `workspace` foreign key would accept.
const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000ff';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-documents',
  groups: ['reviewers'],
};

const BOUNDARY = '----lexpromptdocumentstest';

/** A multipart body in the shape the browser's `addDocument` builds: a
 *  `record` field carrying the JSON record and a named `bytes` file part. */
function multipart(record: unknown, bytes: Buffer, filename = 'lease.pdf', mime = 'application/pdf'): {
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

const RECORD = {
  id: 'd1', matterId: 'm1', name: 'lease.pdf', kind: 'pdf', text: 'The tenant shall…',
  byteSize: 9, addedAt: 1_700_000_000_000, addedByUserId: '', role: 'standalone',
};

interface Harness {
  app: FastifyInstance;
  blobs: MemoryBlobStore;
  get(url: string): Promise<any>;
  post(record: unknown, bytes?: Buffer, filename?: string, mime?: string): Promise<DocumentRecord>;
  raw(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{
    statusCode: number; headers: Record<string, unknown>; body: string; rawPayload: Buffer; json(): any;
  }>;
  rawPost(record: unknown, bytes?: Buffer, filename?: string, mime?: string): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function harness(t: Tx, actorId: string, opts: {
  blobs?: MemoryBlobStore; db?: Db; role?: 'reviewer' | 'partner' | 'admin';
} = {}): Harness {
  const blobs = opts.blobs ?? memoryBlobStore();
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: opts.db ?? dbOn(t),
    blobs,
    actor: {
      id: actorId, displayName: 'Test Reviewer', initials: 'TR',
      role: opts.role ?? 'reviewer', workspaceId: WS,
    },
  });
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: body as never });
  const injectForm = (record: unknown, bytes: Buffer, filename?: string, mime?: string) => {
    const form = multipart(record, bytes, filename, mime);
    return app.inject({
      method: 'POST', url: '/v1/documents',
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
    async post(record, bytes = Buffer.from('%PDF-1.7\n'), filename, mime) {
      const res = await injectForm(record, bytes, filename, mime);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as DocumentRecord;
    },
    raw: (method, url, body) => inject(method, url, body) as never,
    rawPost: (record, bytes = Buffer.from('%PDF-1.7\n'), filename, mime) =>
      injectForm(record, bytes, filename, mime) as never,
  };
}

/** Seeds a matter with the app role, so the document routes have somewhere
 *  to put a document. */
async function aMatter(t: Tx, id = 'm1', ws = WS): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now())`, [id, ws]);
}

/**
 * A collection for a document to be moved into.
 *
 * `PATCH /v1/documents/:id/role` now checks that the `collectionId` it is
 * handed exists in this workspace (Part 2A m3) — the absent foreign key is
 * deliberate, "deliberately not enforced by the database" is not
 * "deliberately not checked" — so a test that groups a document has to
 * group it into something. Additive fixture seeding: no assertion moved.
 */
async function aCollection(t: Tx, id = 'c1', matterId = 'm1', ws = WS): Promise<void> {
  await t.query(
    `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                             varies_document_ids, created_at)
     values ($1, $2, $3, 'A collection', $4, '[]'::jsonb, now())`,
    [id, ws, matterId, `${id}-base`]);
}

describe('uploading a document', () => {
  it('stores the row and puts the bytes under blobKeyFor, and returns the row', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const saved = await h.post(RECORD, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      expect(saved.id).toBe('d1');
      expect(saved.name).toBe('lease.pdf');
      expect(saved.kind).toBe('pdf');
      expect(saved.text).toBe('The tenant shall…');
      // The key comes from `blobKeyFor` and from nowhere else. A key derived
      // twice is a blob the cascade cannot find, which makes "deleting a
      // matter deletes its documents' bytes" false in the one direction
      // nobody would notice.
      expect(h.blobs.keys()).toEqual([blobKeyFor(WS, 'd1')]);
      expect(await h.get('/v1/documents/d1')).toEqual(saved);
      await h.app.close();
    });
  });

  it('records the AUTHENTICATED actor as who added it, not whoever the body named', async () => {
    await withPg(async t => {
      await aMatter(t);
      const actor = await aUser(t);
      const someoneElse = await aUser(t);
      const h = harness(t, actor);
      const saved = await h.post({ ...RECORD, addedByUserId: someoneElse });
      expect(saved.addedByUserId).toBe(actor);
      expect(saved.addedByUserId).not.toBe(someoneElse);
      await h.app.close();
    });
  });

  it('writes the blob BEFORE the row, so a failure leaves an orphan and never a contentless document', async () => {
    // The write-order decision, asserted rather than described. A row-first
    // route would leave a DOCUMENT RECORD WITH NO BYTES here — visible to a
    // reader as a document that opens to nothing, and selectable for review
    // on the path whose founding defect is a document reviewed as though it
    // said nothing.
    await withPg(async t => {
      await aMatter(t);
      const real = dbOn(t);
      const failing: Db = {
        query: async <R>(text: string, values?: unknown[]): Promise<R[]> => {
          if (/insert into document/i.test(text)) throw new Error('the database fell over');
          return real.query<R>(text, values);
        },
        tx: run => real.tx(run),
      };
      const h = harness(t, await aUser(t), { db: failing });
      const res = await h.rawPost(RECORD);
      expect(res.statusCode).toBe(500);
      // The bytes ARE there. That is the orphan, and it is the failure this
      // order chose: a storage leak with a sweeper, rather than a document
      // that lies about existing.
      expect(h.blobs.keys()).toEqual([blobKeyFor(WS, 'd1')]);
      // …and no row was written.
      expect((await t.query("select 1 from document where id = 'd1'")).length).toBe(0);
      await h.app.close();
    });
  });

  it('rejects a document whose matter is in another workspace, without storing bytes', async () => {
    // The order above makes this the case that matters: an unauthorised
    // upload must not leave its bytes behind. So the WORKSPACE CHECK runs
    // before the blob put, and only the row insert is after it.
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      const h = harness(t, await aUser(t));
      const res = await h.rawPost({ ...RECORD, matterId: 'theirs' });
      // NOT FOUND, not FORBIDDEN — a 403 would confirm the matter id exists
      // somewhere, which is a fact this workspace is not entitled to.
      expect(res.statusCode).toBe(404);
      expect(h.blobs.keys()).toEqual([]);
      await h.app.close();
    }, migratorDb());
  });

  it('refuses an id held by ANOTHER workspace without claiming an overwrite (Part 2A m4)', async () => {
    // `document.id` is a GLOBAL primary key and the "id already taken"
    // pre-check is workspace-scoped, so a foreign id passed it, the blob was
    // written, `on conflict (id) do nothing` swallowed the insert, and the
    // caller was told *"Its file HAS been written to storage under that id
    // and may have replaced the other document's. Tell an administrator
    // before opening it."* — false, because the blob key carries the
    // workspace, so the two documents' bytes never shared a key. A confident
    // wrong claim about a client's file, in the one message that sends a
    // reader to fetch an administrator.
    //
    // A bare `ConflictError` instead, exactly as `matters.ts` answers the
    // same P6 collision: that id is taken, and by what is not yours to know.
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t);
      await aMatter(t, 'theirs', OTHER_WS);
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                               byte_size, mime, blob_key, role, added_at)
         values ('d1', $1, 'matter', 'theirs', 'theirs.pdf', 'pdf', 'x', 'parsed', 4, 'application/pdf',
                 $2, 'standalone', now())`, [OTHER_WS, blobKeyFor(OTHER_WS, 'd1')]);

      const h = harness(t, await aUser(t));
      const res = await h.rawPost(RECORD, Buffer.from('mine'));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).not.toMatch(/HAS been written/);
      expect(res.json().error.message).not.toMatch(/may have replaced/);
      expect(res.json().error.message).toMatch(/not yours to overwrite/);
      // …and no bytes were written for an insert that was never going to
      // land, so the refusal leaves no orphan behind either.
      expect(h.blobs.keys()).toEqual([]);
      // The other workspace's row is untouched.
      const theirs = await t.query<{ name: string }>(
        'select name from document where id = $1 and workspace_id = $2', ['d1', OTHER_WS]);
      expect(theirs[0].name).toBe('theirs.pdf');
      await h.app.close();
    }, migratorDb());
  });

  it('refuses a second upload over a live id, and leaves that document s bytes alone', async () => {
    // Worse than an orphan: overwriting the bytes and THEN failing the
    // insert would leave the surviving row pointing at somebody else's file.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD, Buffer.from('the original'));
      const res = await h.rawPost({ ...RECORD, name: 'other.pdf' }, Buffer.from('an impostor'));
      expect(res.statusCode).toBe(409);
      const stored = await h.blobs.get(blobKeyFor(WS, 'd1'));
      expect(stored!.bytes.toString()).toBe('the original');
      expect((await h.get('/v1/documents/d1') as DocumentRecord).name).toBe('lease.pdf');
      await h.app.close();
    });
  });

  it('stores parse_state failed for a record carrying a parseError, and parsed otherwise', async () => {
    // P12. Stage 3's parse worker reads this column, and a document silently
    // marked `parsed` with no text is the founding defect wearing a database
    // column. Never 'pending' in Stage 2 — nothing here is asynchronous.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, id: 'd-ok' });
      await h.post({ ...RECORD, id: 'd-bad', text: '', parseError: 'This PDF could not be read.' });
      const states = await t.query<{ id: string; parse_state: string }>(
        'select id, parse_state from document where workspace_id = $1 order by id', [WS]);
      expect(states).toEqual([
        { id: 'd-bad', parse_state: 'failed' },
        { id: 'd-ok', parse_state: 'parsed' },
      ]);
      expect(states.some(s => s.parse_state === 'pending')).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a malformed record with 400, and stores neither row nor bytes', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const res = await h.rawPost({ ...RECORD, kind: 'xlsx' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/kind/);
      expect(h.blobs.keys()).toEqual([]);
      expect((await t.query("select 1 from document where id = 'd1'")).length).toBe(0);
      await h.app.close();
    });
  });

  it('keeps an absent optional field absent rather than reading it back as null', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const saved = await h.post(RECORD);
      // `toEqual` cannot tell an absent key from an undefined one, and
      // `structuredClone` preserves the latter — so absence is asserted
      // directly, at every optional field this record did not carry.
      for (const key of ['parseError', 'markupNotice', 'collectionId', 'documentDate']) {
        expect(key in saved, key).toBe(false);
      }
      await h.app.close();
    });
  });
});

describe('reading a document and its bytes', () => {
  it('serves the bytes back with the stored mime and a content-length', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      const bytes = Buffer.from([0x00, 0x25, 0x50, 0x44, 0x46, 0xFF]);
      await h.post(RECORD, bytes, 'lease.pdf', 'application/pdf');
      const res = await h.raw('GET', '/v1/documents/d1/bytes');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-length']).toBe(String(bytes.length));
      expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
      await h.app.close();
    });
  });

  it('answers 404 for bytes that are not there, so getDocumentBlob can return null', async () => {
    // A record can outlive its bytes — a partial failure, a manual purge —
    // and the UI must still show that document's metadata with an
    // "unavailable" state. A 500 here would turn a known, handled state into
    // a broken screen.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      h.blobs.raw.clear();
      const res = await h.raw('GET', '/v1/documents/d1/bytes');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/not in storage/i);
      // …and the RECORD is still readable, which is the whole point.
      expect((await h.get('/v1/documents/d1') as DocumentRecord).name).toBe('lease.pdf');
      await h.app.close();
    });
  });

  it('lists a matter s documents oldest-added first, and only that matter s', async () => {
    await withPg(async t => {
      await aMatter(t, 'm1');
      await aMatter(t, 'm2');
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, id: 'd-late', addedAt: 3_000 });
      await h.post({ ...RECORD, id: 'd-early', addedAt: 1_000 });
      await h.post({ ...RECORD, id: 'd-other', matterId: 'm2', addedAt: 2_000 });
      const list = await h.get('/v1/matters/m1/documents') as DocumentRecord[];
      expect(list.map(d => d.id)).toEqual(['d-early', 'd-late']);
      await h.app.close();
    });
  });

  it('never reads a document, or its bytes, across workspaces', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t, 'theirs', OTHER_WS);
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                               byte_size, mime, blob_key, role, added_at)
         values ('foreign', $1, 'matter', 'theirs', 'Theirs.pdf', 'pdf', 'secret', 'parsed', 6,
                 'application/pdf', $2, 'standalone', now())`,
        [OTHER_WS, blobKeyFor(OTHER_WS, 'foreign')]);
      const blobs = memoryBlobStore();
      await blobs.put(blobKeyFor(OTHER_WS, 'foreign'), Buffer.from('secret'), 'application/pdf');
      const h = harness(t, await aUser(t), { blobs });

      // 404, not 403 — a 403 confirms the id exists somewhere.
      expect((await h.raw('GET', '/v1/documents/foreign')).statusCode).toBe(404);
      expect((await h.raw('GET', '/v1/documents/foreign/bytes')).statusCode).toBe(404);
      expect((await h.raw('PATCH', '/v1/documents/foreign/role', { role: 'base' })).statusCode).toBe(404);
      expect((await h.raw('DELETE', '/v1/documents/foreign')).statusCode).toBe(404);
      // …and the refused DELETE destroyed nothing.
      expect((await t.query("select 1 from document where id = 'foreign'")).length).toBe(1);
      expect(blobs.keys()).toEqual([blobKeyFor(OTHER_WS, 'foreign')]);
      await h.app.close();
    }, migratorDb());
  });
});

describe('collection membership', () => {
  it('setDocumentRole leaves every other field untouched, including one it does not know about', async () => {
    // The shipped implementation read inside its own transaction and spread,
    // so a field added later survived. An UPDATE naming two columns is the
    // same guarantee by stronger means — and `content_sha256` is the proof,
    // because it is a column the wire type does not even carry, so a
    // whole-row rewrite would silently drop it.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, markupNotice: 'Tracked changes were accepted.', documentDate: 1_600_000_000_000 });
      await aCollection(t);
      await t.query(
        'update document set content_sha256 = $2 where id = $1 and workspace_id = $3',
        ['d1', 'abc123', WS]);

      const patched = (await h.raw('PATCH', '/v1/documents/d1/role',
        { role: 'varies', collectionId: 'c1' })).json() as DocumentRecord;
      expect(patched.role).toBe('varies');
      expect(patched.collectionId).toBe('c1');
      expect(patched.markupNotice).toBe('Tracked changes were accepted.');
      expect(patched.documentDate).toBe(1_600_000_000_000);
      expect(patched.text).toBe('The tenant shall…');
      const kept = await t.query<{ content_sha256: string; blob_key: string }>(
        'select content_sha256, blob_key from document where id = $1 and workspace_id = $2',
        ['d1', WS]);
      expect(kept[0].content_sha256).toBe('abc123');
      expect(kept[0].blob_key).toBe(blobKeyFor(WS, 'd1'));
      await h.app.close();
    });
  });

  it('ungrouping REMOVES collectionId rather than setting it to undefined', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      await aCollection(t);
      await h.raw('PATCH', '/v1/documents/d1/role', { role: 'base', collectionId: 'c1' });
      const doc = (await h.raw('PATCH', '/v1/documents/d1/role',
        { role: 'standalone' })).json() as DocumentRecord;
      // NOT toEqual — absence is the assertion.
      expect('collectionId' in doc).toBe(false);
      expect(doc.role).toBe('standalone');
      expect('collectionId' in (await h.get('/v1/documents/d1'))).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a role the schema does not have, before writing anything', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      const res = await h.raw('PATCH', '/v1/documents/d1/role', { role: 'primary' });
      expect(res.statusCode).toBe(400);
      expect((await h.get('/v1/documents/d1') as DocumentRecord).role).toBe('standalone');
      await h.app.close();
    });
  });

  it('refuses a collectionId naming no collection here, before writing (Part 2A m3)', async () => {
    // `document.collection_id` carries no foreign key on purpose — grouping
    // writes the collection record and each member's `role` as separate
    // statements, and an FK would refuse the intermediate state. Without a
    // route-level check a stale id then wrote a document into a collection
    // that does not exist: gone from the matter's standalone list, and in
    // nothing.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      const res = await h.raw('PATCH', '/v1/documents/d1/role',
        { role: 'varies', collectionId: 'no-such-collection' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/no-such-collection/);
      // Nothing was written: role and membership are as they were.
      const doc = await h.get('/v1/documents/d1') as DocumentRecord;
      expect(doc.role).toBe('standalone');
      expect('collectionId' in doc).toBe(false);
      await h.app.close();
    });
  });

  it('refuses a collection belonging to ANOTHER workspace (Part 2A m3)', async () => {
    await withPg(async t => {
      await t.query("insert into workspace (id, name) values ($1, 'Other')", [OTHER_WS]);
      await aMatter(t);
      await aMatter(t, 'theirs', OTHER_WS);
      await aCollection(t, 'c-theirs', 'theirs', OTHER_WS);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      expect((await h.raw('PATCH', '/v1/documents/d1/role',
        { role: 'varies', collectionId: 'c-theirs' })).statusCode).toBe(404);
      await h.app.close();
    }, migratorDb());
  });

  it('answers 404 for a role patch on a document that is not there', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t));
      expect((await h.raw('PATCH', '/v1/documents/nope/role', { role: 'base' })).statusCode).toBe(404);
      await h.app.close();
    });
  });
});

describe('deleting a document', () => {
  it('removes the row and the bytes together', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      expect((await h.raw('DELETE', '/v1/documents/d1')).statusCode).toBe(204);
      expect(h.blobs.keys()).toEqual([]);
      expect((await h.raw('GET', '/v1/documents/d1')).statusCode).toBe(404);
      // A second delete is a 404, not a silent 204.
      expect((await h.raw('DELETE', '/v1/documents/d1')).statusCode).toBe(404);
      await h.app.close();
    });
  });

  it('reports the delete as failed when the bytes could NOT be removed', async () => {
    // Loudly. The row is gone and committed by then, so the failure cannot
    // be undone — the honest answer is to say so, name the key, and leave it
    // for the sweeper. A 204 over a surviving blob makes the README's
    // sentence false with nothing on any screen to show it.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post(RECORD);
      h.blobs.failDeletesFor(blobKeyFor(WS, 'd1'));
      const res = await h.raw('DELETE', '/v1/documents/d1');
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toMatch(/could not be deleted/i);
      expect(res.json().error.message).toContain(blobKeyFor(WS, 'd1'));
      await h.app.close();
    });
  });
});

describe('the orphan sweeper (§6.5)', () => {
  it('lists only keys under this workspace that no document row claims', async () => {
    await withPg(async t => {
      await aMatter(t);
      const blobs = memoryBlobStore();
      const h = harness(t, await aUser(t), { blobs, role: 'admin' });
      await h.post(RECORD);
      await blobs.put(blobKeyFor(WS, 'orphan'), Buffer.from('leaked'), 'application/pdf');
      await blobs.put(blobKeyFor(OTHER_WS, 'theirs'), Buffer.from('not ours'), 'application/pdf');

      const { keys } = await h.get('/v1/admin/blob-orphans') as { keys: string[] };
      expect(keys).toEqual([blobKeyFor(WS, 'orphan')]);
      await h.app.close();
    });
  });

  it('deletes the orphans it derived itself, and never a key a caller named', async () => {
    await withPg(async t => {
      await aMatter(t);
      const blobs = memoryBlobStore();
      const h = harness(t, await aUser(t), { blobs, role: 'admin' });
      await h.post(RECORD);
      await blobs.put(blobKeyFor(WS, 'orphan'), Buffer.from('leaked'), 'application/pdf');

      // A caller doing its level best to have a LIVE document's bytes
      // destroyed. The route recomputes the list and ignores the body.
      const res = await h.raw('POST', '/v1/admin/blob-orphans/delete',
        { keys: [blobKeyFor(WS, 'd1')] });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([blobKeyFor(WS, 'orphan')]);
      expect(blobs.keys()).toEqual([blobKeyFor(WS, 'd1')]);
      await h.app.close();
    });
  });

  it('needs the admin role — a reviewer cannot see or delete orphaned bytes', async () => {
    await withPg(async t => {
      const h = harness(t, await aUser(t), { role: 'reviewer' });
      expect((await h.raw('GET', '/v1/admin/blob-orphans')).statusCode).toBe(403);
      expect((await h.raw('POST', '/v1/admin/blob-orphans/delete', {})).statusCode).toBe(403);
      await h.app.close();
    });
  });
});

describe('the matter cascade reaches the bytes', () => {
  it('deletes a matter s documents AND their blobs', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, id: 'd1' });
      await h.post({ ...RECORD, id: 'd2' });
      // Sorted, for the reason the cascade case below gives: the store's own
      // listing order is not something either side promises.
      expect([...h.blobs.keys()].sort())
        .toEqual([blobKeyFor(WS, 'd1'), blobKeyFor(WS, 'd2')].sort());

      expect((await h.raw('DELETE', '/v1/matters/m1')).statusCode).toBe(204);
      expect((await t.query("select 1 from document where matter_id = 'm1'")).length).toBe(0);
      // THE BREAKAGE TASK 9 LEFT OPEN, CLOSED. Before this, the rows went
      // and the bytes stayed, and every screen agreed the documents were
      // gone.
      expect(h.blobs.keys()).toEqual([]);
      await h.app.close();
    });
  });

  it('deletes the blobs even when one of them is already gone', async () => {
    // A half-done cascade is the failure the promise exists to prevent, and
    // the likeliest cause is one delete throwing and aborting the rest.
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, id: 'd1' });
      await h.post({ ...RECORD, id: 'd2' });
      await h.blobs.delete(blobKeyFor(WS, 'd1'));
      h.blobs.deleteCalls.length = 0;

      expect((await h.raw('DELETE', '/v1/matters/m1')).statusCode).toBe(204);
      // SORTED. The cascade reads `select blob_key from document where
      // matter_id = $1 and workspace_id = $2` with no ORDER BY, so Postgres
      // guarantees nothing about the order those keys come back in — and it
      // does flip: this assertion passed for hundreds of runs and then
      // failed as `[d2, d1]` on a rebuilt stack. What the cascade promises
      // is that EVERY key is attempted even after one has already gone, and
      // that is what this now asserts. An assertion whose truth depends on a
      // heap-scan order is a test passing for a reason nothing guarantees.
      expect([...h.blobs.deleteCalls].sort())
        .toEqual([blobKeyFor(WS, 'd1'), blobKeyFor(WS, 'd2')].sort());
      expect(h.blobs.keys()).toEqual([]);
      await h.app.close();
    });
  });

  it('reports the delete as failed when a blob could NOT be removed, and still attempts the rest', async () => {
    await withPg(async t => {
      await aMatter(t);
      const h = harness(t, await aUser(t));
      await h.post({ ...RECORD, id: 'd1' });
      await h.post({ ...RECORD, id: 'd2' });
      h.blobs.failDeletesFor(blobKeyFor(WS, 'd1'));

      const res = await h.raw('DELETE', '/v1/matters/m1');
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toMatch(/could not be deleted/i);
      expect(res.json().error.message).toContain(blobKeyFor(WS, 'd1'));
      // The second key was still attempted — the loop does not stop at the
      // first failure.
      expect(h.blobs.deleteCalls).toContain(blobKeyFor(WS, 'd2'));
      expect(h.blobs.keys()).toEqual([blobKeyFor(WS, 'd1')]);
      // …and the rows are gone, which is why the failure has to be loud:
      // there is nothing left to derive those keys from.
      expect((await t.query("select 1 from matter where id = 'm1'")).length).toBe(0);
      await h.app.close();
    });
  });
});
