import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withPg } from './helpers/pgHarness.ts';
import { ROOT } from './sourceScan.ts';
import { memoryBlobStore } from './helpers/memoryBlobs.ts';
import {
  WS, MODEL, aMatter, aModelChoice, aReview, aRun, aUser, assertStatesAgree,
  fakeGateway, parseDeps, workerDeps,
} from './helpers/runHarness.ts';
import { runOneStep } from '../src/run/worker.ts';
import {
  documentFileForReview, documentFileForViewing, makePageImageCache,
} from '../src/parse/hydrate.ts';
import { parseDocument } from '../src/parse/parseDocument.ts';
import { parseOneDocument, reportStuckDocuments } from '../src/parse/parseWorker.ts';
import { dbOn } from './helpers/pgHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import type { DocumentRecord } from '../src/db/rows.ts';

/**
 * Task 9: the two hydrations, and THE DIFFERENCE THAT HAS REOPENED TWICE.
 *
 * `documentFileForViewing` carries no page images — correct for a viewer
 * that renders the PDF itself. `documentFileForReview` regenerates them for
 * a document whose pages fall below `SCAN_TEXT_THRESHOLD`.
 *
 * Handing a view-hydrated (or raw-record) document to an extractor reviews a
 * scanned document as though it said nothing — **this project's FOUNDING
 * DEFECT**. It has reopened twice: once one level up (a collection of
 * records) and once one level sideways (a retry on a reopened review). The
 * run worker hydrates FOR REVIEW, and the first test below is what keeps
 * that true when this file is next refactored.
 */

const SCAN = new Uint8Array(readFileSync(
  path.join(ROOT, 'apps/api/test/fixtures/scanned-lease.pdf')));

const CACHE_DEPS = {
  cache: makePageImageCache(50_000_000),
  pageRenderTimeoutMs: 30_000,
  pageImageMaxPages: 10,
  runImageBytesMax: 12_000_000,
};

const record = (over: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'h-d1',
  matterId: 'h-m1',
  name: 'scanned-lease.pdf',
  kind: 'pdf',
  text: '[Page 1]\n\n\n[Page 2]\n\n\n[Page 3]\n\n\n',
  byteSize: SCAN.byteLength,
  addedAt: 1,
  addedByUserId: '',
  role: 'standalone',
  ...over,
});

async function aScannedDocument(
  t: Tx, id: string, matterId: string, name = 'scanned-lease.pdf',
): Promise<void> {
  // The text a REAL parse produces for this fixture: markers and nothing
  // else. Written through `parseDocument` rather than typed out, so the
  // fixture cannot drift away from what the parse worker would store.
  const parsed = await parseDocument(SCAN, 'application/pdf', 'scanned-lease.pdf');
  expect(parsed.sparsePages).toEqual([1, 2, 3]);
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', $3, $7, 'pdf', $4, 'parsed', $5,
             'application/pdf', $6, 'standalone', now())`,
    [id, WS, matterId, parsed.text, SCAN.byteLength, `workspace/${WS}/document/${id}`, name]);
}

describe('the worker hands the extractor a REVIEW-hydrated document', () => {
  it('sends a scan s page images to the model, which only review hydration produces', async () => {
    // MUTATION: change `hydrateForReview`'s call in `run/worker.ts` to
    // `documentFileForViewing` and this test must fail — a view-hydrated
    // document carries no page images, so `assessDocument` reports
    // `needs-image-model` and the finding becomes an error instead. It is
    // the only guard between this stage and the defect the project was
    // founded on.
    //
    // Asserted through the MODEL CALL rather than through a spy on purpose:
    // a spy proves which function was named, and this proves what the model
    // was actually shown.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'h-m1');
      await aScannedDocument(t, 'h-d1', 'h-m1');
      await aReview(t, 'h-r1', 'h-m1', { kind: 'documents', documentIds: ['h-d1'] }, ['c1']);
      await aModelChoice(t);
      await aRun(t, 'h-run1', 'h-r1', [{ key: 'h-d1', clause: 'c1' }], userId);

      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d1`, Buffer.from(SCAN), 'application/pdf');
      const { gateway, log } = fakeGateway();
      await runOneStep(workerDeps(t, gateway, {}, blobs), 'w#1', [MODEL]);

      expect(log.infer).toHaveLength(1);
      const images = log.infer[0].images as { mime: string; data: string }[] | undefined;
      expect(images, 'the model was sent no page images for a scan').toBeDefined();
      expect(images).toHaveLength(3);
      expect(images![0].mime).toBe('image/jpeg');
      expect(images![0].data.length).toBeGreaterThan(1_000);

      const f = await t.query<{ status: string; error: string | null }>(
        'select status, error from finding where review_id = $1', ['h-r1']);
      expect(f[0].status, f[0].error ?? '').toBe('done');
      await assertStatesAgree(t);
    });
  }, 60_000);

  it('view hydration carries no images at all, which is what makes the guard bite', async () => {
    // The other half. Without this the assertion above could pass against a
    // `documentFileForViewing` that happened to render images too, and the
    // mutation would prove nothing.
    const viewed = documentFileForViewing(record(), Buffer.from(SCAN), 'application/pdf');
    expect(viewed.pageImages).toBeUndefined();
    expect(viewed.text).toContain('[Page 1]');

    const reviewed = await documentFileForReview(
      record(), async () => Buffer.from(SCAN), 'application/pdf', CACHE_DEPS);
    expect(reviewed.pageImages).toHaveLength(3);
    expect(reviewed.parseError).toBeUndefined();
  }, 60_000);
});

describe('bytes are read only for a document that needs images', () => {
  it('does not touch the store for a document with a healthy text layer', async () => {
    // A forty-cell run over three documents would otherwise pull every
    // document's bytes out of Blob Storage a hundred and twenty times.
    let reads = 0;
    const hydrated = await documentFileForReview(
      record({ text: '[Page 1]\nThe term is ten years from 1 January 2020.\n\n' }),
      async () => { reads += 1; return Buffer.from(SCAN); },
      'application/pdf', { ...CACHE_DEPS, cache: makePageImageCache(50_000_000) });
    expect(reads).toBe(0);
    expect(hydrated.pageImages).toBeUndefined();
    expect(hydrated.parseError).toBeUndefined();
  });

  it('refuses a SCAN whose bytes are gone, rather than reviewing its empty text', async () => {
    const hydrated = await documentFileForReview(
      record(), async () => null, 'application/pdf',
      { ...CACHE_DEPS, cache: makePageImageCache(50_000_000) });
    expect(hydrated.parseError).toMatch(/no longer available/);
    expect(hydrated.parseError).toMatch(/reviewing it would report every clause as absent/);
  });

  it('reports a store that REFUSED differently from a file that is gone', async () => {
    const hydrated = await documentFileForReview(
      record(), async () => { throw new Error('403 from the account'); },
      'application/pdf', { ...CACHE_DEPS, cache: makePageImageCache(50_000_000) });
    expect(hydrated.parseError).toMatch(/could not reach the file store/);
  });

  it('carries a stored parseError through without re-parsing', async () => {
    let reads = 0;
    const hydrated = await documentFileForReview(
      record({ parseError: 'the file is encrypted' }),
      async () => { reads += 1; return Buffer.from(SCAN); },
      'application/pdf', { ...CACHE_DEPS, cache: makePageImageCache(50_000_000) });
    expect(hydrated.parseError).toBe('the file is encrypted');
    expect(reads).toBe(0);
  });

  it('refuses a FAILED document whose parse_error is empty, rather than reviewing no text', async () => {
    /*
     * FINAL REVIEW m3. This branched on the MESSAGE alone, so a row with
     * `parse_state = 'failed'` and no `parse_error` fell through the whole
     * function — the sparse-pages check is skipped for anything that is not
     * a PDF — and came back with `text: ''` and NO `parseError` at all.
     * `extractClause` then answers *"the agreement is silent on this point"*
     * for every clause of a document nothing could read, which is this
     * project's founding defect.
     *
     * Not reachable through today's callers (`parseWorker.fail` always
     * writes a message, `refuseUnparsedDocuments` blocks a `failed` document
     * at run creation), which is exactly why the guard belongs in the module
     * that presents itself as the last line rather than in the two callers
     * that happen to make it unnecessary.
     */
    let reads = 0;
    const hydrated = await documentFileForReview(
      record({ kind: 'txt', name: 'notes.txt', text: '', parseState: 'failed' }),
      async () => { reads += 1; return Buffer.from(SCAN); },
      'text/plain', { ...CACHE_DEPS, cache: makePageImageCache(50_000_000) });
    expect(hydrated.parseError, 'a failed document came back as one that says nothing')
      .toBeTruthy();
    expect(hydrated.parseError).toMatch(/could not be read/i);
    expect(hydrated.parseError).toContain('notes.txt');
    expect(reads).toBe(0);
  });
});

describe('the page-image cache, and the promise it keeps', () => {
  it('serves a second hydration from memory rather than rendering twice', async () => {
    const cache = makePageImageCache(50_000_000);
    let reads = 0;
    const read = async () => { reads += 1; return Buffer.from(SCAN); };
    const first = await documentFileForReview(record(), read, 'application/pdf',
      { ...CACHE_DEPS, cache });
    const second = await documentFileForReview(record(), read, 'application/pdf',
      { ...CACHE_DEPS, cache });
    expect(reads).toBe(1);
    expect(second.pageImages).toEqual(first.pageImages);
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBeGreaterThan(0);
  }, 60_000);

  it('is bounded by BYTES, and the bound actually bites', () => {
    // The browser bounds by DOCUMENT COUNT, which is right for one person's
    // tab and wrong for a shared process: ten documents is a few megabytes
    // of three-page contracts and gigabytes of hundred-page scans.
    const cache = makePageImageCache(1_000);
    const image = (n: number) => [{ mime: 'image/jpeg', data: 'x'.repeat(n) }];
    cache.set('a', image(600));
    cache.set('b', image(600));
    expect(cache.bytes()).toBeLessThanOrEqual(1_000);
    // Least-recently-USED, not least-recently-added: a hit moves an entry to
    // the recent end.
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();

    cache.set('c', image(300));
    expect(cache.get('b')).toBeDefined();
    cache.set('d', image(300));
    expect(cache.get('c')).toBeUndefined();

    // An entry larger than the whole budget is not admitted, rather than
    // evicting everything to hold one document that the next call evicts.
    cache.set('huge', image(5_000));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.bytes()).toBeLessThanOrEqual(1_000);
  });

  it('refuses a scan whose images will not fit in one call, rather than sending part', () => {
    // Spike 1's finding: a 100-page scan is ~31 MB of base64, already over
    // API_MAX_BODY_BYTES. NOT BATCHED — see `config.ts` for why. A partly
    // sent scan reads to a model as a document silent on everything the
    // missing pages said.
    const cache = makePageImageCache(50_000_000);
    cache.set('h-d1', [
      { mime: 'image/jpeg', data: 'x'.repeat(900) },
      { mime: 'image/jpeg', data: 'x'.repeat(900) },
    ]);
    return documentFileForReview(record(), async () => Buffer.from(SCAN), 'application/pdf', {
      ...CACHE_DEPS, cache, runImageBytesMax: 1_000,
    }).then(hydrated => {
      expect(hydrated.pageImages).toBeUndefined();
      expect(hydrated.parseError).toMatch(/API_RUN_IMAGE_BYTES_MAX/);
      expect(hydrated.parseError).toMatch(/will not send part of a scan/i);
    });
  });

  it('no page image reaches Postgres or the blob store across a whole run', async () => {
    // S12, as a run-level fact rather than as a source scan. The companion
    // POSITIVE assertion — that images were produced at all — is the first
    // test in this file; without it "nothing was stored" would pass over a
    // run that rendered nothing.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'h-m2');
      await aScannedDocument(t, 'h-d2', 'h-m2');
      await aReview(t, 'h-r2', 'h-m2', { kind: 'documents', documentIds: ['h-d2'] }, ['c1']);
      await aModelChoice(t);
      await aRun(t, 'h-run2', 'h-r2', [{ key: 'h-d2', clause: 'c1' }], userId);

      const blobs = memoryBlobStore();
      const key = `workspace/${WS}/document/h-d2`;
      await blobs.put(key, Buffer.from(SCAN), 'application/pdf');
      const before = blobs.keys();

      const { gateway, log } = fakeGateway();
      await runOneStep(workerDeps(t, gateway, {}, blobs), 'w#1', [MODEL]);
      expect((log.infer[0].images as unknown[]).length).toBe(3);

      // The store is untouched: one key in, one key out, same bytes.
      expect(blobs.keys()).toEqual(before);
      expect(blobs.raw.get(key)!.bytes.byteLength).toBe(SCAN.byteLength);

      // …and nothing in the database is base64 of an image. The document's
      // own `text` and every finding column, searched rather than assumed.
      const rows = await t.query<{ blob: string }>(
        `select coalesce(d.text, '') || coalesce(f.summary, '') || coalesce(f.error, '')
                || f.citations::text as blob
           from finding f join document d on d.id = f.findings_key
          where f.review_id = $1`, ['h-r2']);
      for (const row of rows) {
        expect(row.blob).not.toMatch(/\/9j\//);         // a JPEG's base64 prefix
        expect(row.blob).not.toMatch(/data:image/);
        expect(row.blob.length).toBeLessThan(10_000);
      }
      await assertStatesAgree(t);
    });
  }, 60_000);
});

describe('the parse worker is the one writer of a parse_state change', () => {
  it('reads a pending document s bytes and writes its text', async () => {
    await withPg(async t => {
      await aMatter(t, 'h-m3');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d3', $1, 'matter', 'h-m3', 'notes.txt', 'txt', '', 'pending', 10,
                 'text/plain', $2, 'standalone', now())`,
        [WS, `workspace/${WS}/document/h-d3`]);

      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d3`,
        Buffer.from('Clause 1. The term is ten years.'), 'text/plain');

      expect(await parseOneDocument(parseDeps(dbOn(t), blobs))).toBe(true);
      const rows = await t.query<{ parse_state: string; text: string; parse_error: string | null }>(
        'select parse_state, text, parse_error from document where id = $1', ['h-d3']);
      expect(rows[0].parse_state).toBe('parsed');
      expect(rows[0].text).toBe('Clause 1. The term is ten years.');
      expect(rows[0].parse_error).toBeNull();

      // …and there is nothing left to claim.
      expect(await parseOneDocument(parseDeps(dbOn(t), blobs))).toBe(false);
    });
  });

  it('writes FAILED with a message, never parsed with empty text', async () => {
    await withPg(async t => {
      await aMatter(t, 'h-m4');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d4', $1, 'matter', 'h-m4', 'broken.pdf', 'pdf', '', 'pending', 10,
                 'application/pdf', $2, 'standalone', now())`,
        [WS, `workspace/${WS}/document/h-d4`]);
      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d4`,
        Buffer.from('this is not a pdf at all'), 'application/pdf');

      expect(await parseOneDocument(parseDeps(dbOn(t), blobs))).toBe(true);
      const rows = await t.query<{ parse_state: string; parse_error: string; text: string }>(
        'select parse_state, parse_error, text from document where id = $1', ['h-d4']);
      expect(rows[0].parse_state).toBe('failed');
      expect(rows[0].parse_error).toContain('broken.pdf');
      expect(rows[0].text).toBe('');
    });
  }, 30_000);

  it('says the FILE is missing rather than blaming the document for saying nothing', async () => {
    await withPg(async t => {
      await aMatter(t, 'h-m5');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d5', $1, 'matter', 'h-m5', 'gone.pdf', 'pdf', '', 'pending', 10,
                 'application/pdf', $2, 'standalone', now())`,
        [WS, `workspace/${WS}/document/h-d5`]);

      expect(await parseOneDocument({
        ...parseDeps(dbOn(t), memoryBlobStore()),
      })).toBe(true);
      const rows = await t.query<{ parse_state: string; parse_error: string }>(
        'select parse_state, parse_error from document where id = $1', ['h-d5']);
      expect(rows[0].parse_state).toBe('failed');
      expect(rows[0].parse_error).toMatch(/not in storage/);
    });
  });

  it('refuses a document that parsed to nothing at all', async () => {
    // Not a scan — a scan has sparse pages and gets IMAGES at review time.
    // A document that produced no text AND no page structure would be
    // reviewed as one that says nothing about every clause.
    await withPg(async t => {
      await aMatter(t, 'h-m6');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d6', $1, 'matter', 'h-m6', 'empty.txt', 'txt', '', 'pending', 0,
                 'text/plain', $2, 'standalone', now())`,
        [WS, `workspace/${WS}/document/h-d6`]);
      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d6`, Buffer.from('   \n  '), 'text/plain');

      expect(await parseOneDocument(parseDeps(dbOn(t), blobs))).toBe(true);
      const rows = await t.query<{ parse_state: string; parse_error: string }>(
        'select parse_state, parse_error from document where id = $1', ['h-d6']);
      expect(rows[0].parse_state).toBe('failed');
      expect(rows[0].parse_error).toMatch(/produced no text at all/);
    });
  });

  it('leaves a SCAN parsed, because its pages are read as images later', async () => {
    await withPg(async t => {
      await aMatter(t, 'h-m7');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d7', $1, 'matter', 'h-m7', 'scan.pdf', 'pdf', '', 'pending', 10,
                 'application/pdf', $2, 'standalone', now())`,
        [WS, `workspace/${WS}/document/h-d7`]);
      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d7`, Buffer.from(SCAN), 'application/pdf');

      expect(await parseOneDocument(parseDeps(dbOn(t), blobs))).toBe(true);
      const rows = await t.query<{ parse_state: string; text: string }>(
        'select parse_state, text from document where id = $1', ['h-d7']);
      expect(rows[0].parse_state).toBe('parsed');
      expect(rows[0].text).toContain('[Page 3]');
    });
  }, 30_000);
});

/**
 * M8: THE CELL'S TOTAL, refused before the call — through the worker, not
 * only through the helper.
 *
 * `withImages` enforces `runImageBytesMax` per DOCUMENT, and
 * `extractCollectionClause` concatenates `present.flatMap(p =>
 * p.document.pageImages ?? [])` into ONE body. Three scanned members at 70%
 * of the budget each passed three per-document checks and sent 210% of the
 * ceiling, and the operator got a raw 413 from nginx or the gateway instead
 * of the sentence naming the documents and the two keys to move.
 *
 * Driven through `runOneStep` rather than through `cellImagesRefusal`
 * directly, because the shape this stage keeps producing is a correct
 * mechanism with no path to it: a helper nothing calls refuses nothing.
 */
describe('a collection cell is refused by name when its members will not fit in one call', () => {
  it('refuses before the model call, naming every member and both keys', async () => {
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'h-m-col');
      await aScannedDocument(t, 'h-d-base', 'h-m-col', 'lease.pdf');
      await aScannedDocument(t, 'h-d-var', 'h-m-col', 'deed-of-variation.pdf');
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('h-col', $1, 'h-m-col', 'Lease and DoV', 'h-d-base', '["h-d-var"]'::jsonb, now())`,
        [WS]);
      await aReview(t, 'h-r-col', 'h-m-col',
        { kind: 'collection', collectionId: 'h-col', documentIds: ['h-d-base', 'h-d-var'] }, ['c1']);
      await aModelChoice(t);
      await aRun(t, 'h-run-col', 'h-r-col', [{ key: 'h-col', clause: 'c1' }], userId);

      const { gateway, log } = fakeGateway();
      // 1,200 bytes for the cell. Each member holds 700 — comfortably under
      // it on its own, which is exactly why three per-document checks said
      // nothing — and 1,400 between them.
      const deps = workerDeps(t, gateway, { runImageBytesMax: 1_200 });
      for (const id of ['h-d-base', 'h-d-var']) {
        deps.cache.set(id, [{ mime: 'image/jpeg', data: 'x'.repeat(700) }]);
      }
      await runOneStep(deps, 'w#1', [MODEL]);

      const rows = await t.query<{ status: string; error: string }>(
        'select status, error from finding where review_id = $1', ['h-r-col']);
      expect(rows[0].status).toBe('error');
      expect(rows[0].error).toContain('lease.pdf');
      expect(rows[0].error).toContain('deed-of-variation.pdf');
      expect(rows[0].error).toContain('API_RUN_IMAGE_BYTES_MAX');
      expect(rows[0].error).toContain('API_MAX_BODY_BYTES');
      // BEFORE the call. A 413 from the hop is loud but names nothing.
      expect(log.infer).toHaveLength(0);
      await assertStatesAgree(t);
    });
  });

  it('sends a collection whose members DO fit, which is what makes the refusal about the total', async () => {
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'h-m-fit');
      await aScannedDocument(t, 'h-d-fitbase', 'h-m-fit');
      await aScannedDocument(t, 'h-d-fitvar', 'h-m-fit');
      await t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
                                 varies_document_ids, created_at)
         values ('h-colfit', $1, 'h-m-fit', 'Lease and DoV', 'h-d-fitbase',
                 '["h-d-fitvar"]'::jsonb, now())`, [WS]);
      await aReview(t, 'h-r-fit', 'h-m-fit',
        { kind: 'collection', collectionId: 'h-colfit',
          documentIds: ['h-d-fitbase', 'h-d-fitvar'] }, ['c1']);
      await aModelChoice(t);
      await aRun(t, 'h-run-fit', 'h-r-fit', [{ key: 'h-colfit', clause: 'c1' }], userId);

      const { gateway, log } = fakeGateway({
        content: () => JSON.stringify({
          trail: [
            { document: 1, effect: 'Sets a ten-year term.', citations: [] },
            { document: 2, effect: 'Extends it to fifteen.', citations: [] },
          ],
          net_position: 'The term is fifteen years.',
        }),
      });
      const deps = workerDeps(t, gateway, { runImageBytesMax: 5_000 });
      for (const id of ['h-d-fitbase', 'h-d-fitvar']) {
        deps.cache.set(id, [{ mime: 'image/jpeg', data: 'x'.repeat(700) }]);
      }
      await runOneStep(deps, 'w#1', [MODEL]);

      expect(log.infer).toHaveLength(1);
      const rows = await t.query<{ status: string }>(
        'select status from finding where review_id = $1', ['h-r-fit']);
      expect(rows[0].status).toBe('done');
      await assertStatesAgree(t);
    });
  });
});

/**
 * M6: THE PARSE QUEUE HAS A BOUND NOW, AND SAYS WHEN A DOCUMENT IS STUCK.
 *
 * Every other loop in this stage declares one — `runCellTimeoutMs`,
 * `pageRenderTimeoutMs`, `runAttemptsMax`, `runLeaseMs`. This one had none:
 * `parseDocument` ran inside the claim transaction with no deadline and no
 * signal, and `statement_timeout` bounds statements, not `pdfjs`.
 *
 * `parseWorkers` defaults to **1** and the claim is `order by added_at asc,
 * id asc` — strict FIFO with no skipping — so one slow document at the head
 * blocked every other document in the deployment, in every workspace, and a
 * genuine hang blocked them forever. The only message anybody could reach
 * was `routes/runs.ts`'s *"has not finished being read. Nothing was started;
 * try again in a moment"*, repeated for as long as it took.
 *
 * The bound takes the document OUT of `pending`, which is what unblocks
 * everything behind it, and says why by name.
 */
describe('the parse queue is bounded, and a stuck queue is not silent', () => {
  it('marks a document that outruns its budget FAILED, naming the key', async () => {
    await withPg(async t => {
      await aMatter(t, 'h-m-slow');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d-slow', $1, 'matter', 'h-m-slow', 'huge.pdf', 'pdf', '', 'pending', $2,
                 'application/pdf', $3, 'standalone', now())`,
        [WS, SCAN.byteLength, `workspace/${WS}/document/h-d-slow`]);
      const blobs = memoryBlobStore();
      await blobs.put(`workspace/${WS}/document/h-d-slow`, Buffer.from(SCAN), 'application/pdf');

      // A budget nothing can meet. The document is not the point — the
      // point is that a parse which does not finish inside its budget leaves
      // `pending` rather than holding the single FIFO slot.
      // A parse that never returns — the case a check-after cannot see, and
      // the one the FIFO queue could not survive.
      const never = () => new Promise<never>(() => { /* deliberately hangs */ });
      expect(await parseOneDocument(parseDeps(dbOn(t), blobs, {
        parseTimeoutMs: 30, parse: never as never,
      }))).toBe(true);

      const rows = await t.query<{ parse_state: string; parse_error: string; text: string }>(
        'select parse_state, parse_error, text from document where id = $1', ['h-d-slow']);
      expect(rows[0].parse_state).toBe('failed');
      expect(rows[0].parse_error).toContain('huge.pdf');
      expect(rows[0].parse_error).toContain('API_PARSE_TIMEOUT_MS');
      expect(rows[0].parse_error).toMatch(/has NOT been read/);
      expect(rows[0].text).toBe('');
    });
  });

  it('unblocks the document behind it, which is the whole reason for the bound', async () => {
    // Strict FIFO with one slot: before the timeout, the second document was
    // unreachable for as long as the first took.
    await withPg(async t => {
      await aMatter(t, 'h-m-fifo');
      const blobs = memoryBlobStore();
      for (const [id, added] of [['h-d-first', '2 hours'], ['h-d-second', '1 hour']] as const) {
        await t.query(
          `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                                 parse_state, byte_size, mime, blob_key, role, added_at)
           values ($1, $2, 'matter', 'h-m-fifo', $3, 'pdf', '', 'pending', $4,
                   'application/pdf', $5, 'standalone', now() - $6::interval)`,
          [id, WS, `${id}.pdf`, SCAN.byteLength, `workspace/${WS}/document/${id}`, added]);
        await blobs.put(`workspace/${WS}/document/${id}`, Buffer.from(SCAN), 'application/pdf');
      }

      // The head of the queue cannot be read inside its budget…
      const never = () => new Promise<never>(() => { /* deliberately hangs */ });
      await parseOneDocument(parseDeps(dbOn(t), blobs, {
        parseTimeoutMs: 30, parse: never as never,
      }));
      // …and the next claim reaches the SECOND document rather than the same
      // one again.
      await parseOneDocument(parseDeps(dbOn(t), blobs));
      const rows = await t.query<{ id: string; parse_state: string }>(
        "select id, parse_state from document where matter_id = 'h-m-fifo' order by id");
      expect(rows).toEqual([
        { id: 'h-d-first', parse_state: 'failed' },
        { id: 'h-d-second', parse_state: 'parsed' },
      ]);
    });
  }, 60_000);

  it('reports a document that has been waiting far too long, without failing it', async () => {
    // A busy queue is not a broken one — the same rule the reaper keeps for a
    // queued run. What must not happen is a queue whose only symptom is a
    // person being told to try again in a moment, forever.
    await withPg(async t => {
      await aMatter(t, 'h-m-stuck');
      await t.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('h-d-stuck', $1, 'matter', 'h-m-stuck', 'waiting.pdf', 'pdf', '', 'pending', 4,
                 'application/pdf', $2, 'standalone', now() - interval '2 hours')`,
        [WS, `workspace/${WS}/document/h-d-stuck`]);

      const deps = parseDeps(dbOn(t), memoryBlobStore(), { parseStuckReportMs: 60_000 });
      expect(await reportStuckDocuments(deps)).toBe(1);
      // …and it is still `pending`. A report is not a state change.
      expect((await t.query<{ parse_state: string }>(
        "select parse_state from document where id = 'h-d-stuck'"))[0].parse_state).toBe('pending');
      // A document added a moment ago is ordinary and says nothing.
      expect(await reportStuckDocuments(
        parseDeps(dbOn(t), memoryBlobStore(), { parseStuckReportMs: 6 * 60 * 60 * 1000 }))).toBe(0);
    });
  });
});
