import { describe, it, expect } from 'vitest';
import {
  PageRenderAbortedError, PageRenderTimeoutError, withinBudget,
} from '../src/parse/pageImages.ts';
import { cellImagesRefusal, imageCeilingMessage } from '../src/parse/hydrate.ts';
import type { DocumentFile } from '@lexprompt/core';
import { codeOf, ROOT } from './sourceScan.ts';
import path from 'node:path';

/**
 * M3: A PAGE RENDER CAN NO LONGER HANG PAST EVERY DECLARED CAP.
 *
 * `config.ts` calls `pageRenderTimeoutMs` "a **HARD** budget: exceeding it
 * throws `PageRenderTimeoutError` and the document is reported unreadable,
 * never returned half-rendered". The implementation checked
 * `Date.now() > deadline` BETWEEN pages, inside the loop — true of a
 * document made of many quick pages, and bounding nothing at all when it is
 * ONE page whose render does not return.
 *
 * What that cost: a scanned PDF with one pathological page held its worker
 * slot; the lease expired ten minutes later; a second slot claimed the same
 * cell, rendered the same page and hung too. With `runWorkers: 2` the
 * process was permanently down to zero usable slots, every later run in the
 * workspace starved, and nothing in the logs said why. `statement_timeout`
 * cannot help — this is CPU work in Node, not a query — and `runOneStep`'s
 * `AbortController`, the only enforcement of `API_RUN_CELL_TIMEOUT_MS`, had
 * no way to reach it because `renderPageImages` took no signal.
 *
 * `withinBudget` is the bound, tested here directly rather than through
 * pdf.js: the failure it exists for is a promise that NEVER SETTLES, and
 * there is no fixture for that. The compose suite covers the real renderer.
 */

/** A promise that never settles — the case a check-afterwards cannot see. */
const forever = new Promise<string>(() => { /* deliberately never settles */ });

describe('withinBudget bounds one step of a render', () => {
  it('rejects work that never settles, with the budget in the message', async () => {
    const deadline = Date.now() + 20;
    await expect(withinBudget(forever, deadline, { maxPages: 10, timeoutMs: 20 }, 2, 7))
      .rejects.toThrow(PageRenderTimeoutError);
  });

  it('says how much of the document was rendered and that it has NOT been reviewed', async () => {
    const deadline = Date.now() + 20;
    const error: unknown = await withinBudget(
      forever, deadline, { maxPages: 10, timeoutMs: 20 }, 2, 7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageRenderTimeoutError);
    if (!(error instanceof PageRenderTimeoutError)) throw error;
    expect(error.renderedPages).toBe(2);
    expect(error.totalPages).toBe(7);
    expect(error.message).toMatch(/2 of 7 page\(s\)/);
    expect(error.message).toMatch(/has not been reviewed/);
  });

  it('rejects on the CALLER s abort, distinctly from a timeout', async () => {
    // A cell stopped by a person must never read as a document that could
    // not be read: `runOneStep` spends `AbortCause` on exactly that
    // distinction, and it needs two error types to spend it on.
    const controller = new AbortController();
    const pending = withinBudget(
      forever, Date.now() + 60_000, { maxPages: 10, timeoutMs: 60_000, signal: controller.signal },
      1, 5);
    controller.abort();
    await expect(pending).rejects.toThrow(PageRenderAbortedError);
    await expect(pending).rejects.toThrow(/cancelled or timed out/);
  });

  it('rejects immediately when the budget is already spent, without waiting', async () => {
    const started = Date.now();
    await expect(withinBudget(forever, Date.now() - 1, { maxPages: 10, timeoutMs: 5_000 }, 0, 3))
      .rejects.toThrow(PageRenderTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('passes work that finishes in time straight through', async () => {
    await expect(withinBudget(
      Promise.resolve('rendered'), Date.now() + 5_000, { maxPages: 10, timeoutMs: 5_000 }, 0, 3))
      .resolves.toBe('rendered');
  });

  it('re-throws the work s own failure rather than dressing it as a timeout', async () => {
    await expect(withinBudget(
      Promise.reject(new Error('no 2D canvas backend')), Date.now() + 5_000,
      { maxPages: 10, timeoutMs: 5_000 }, 0, 3)).rejects.toThrow('no 2D canvas backend');
  });
});

describe('the renderer actually uses the bound (a helper nothing calls guards nothing)', () => {
  // The guard against the shape this whole finding is about: a correct
  // mechanism with no path to it. `withinBudget` is only a cap if the render
  // loop and the document load both go through it, and if the signal
  // reaches it from the cell that owns the timeout.
  const PAGE_IMAGES = codeOf(path.join(ROOT, 'apps/api/src/parse/pageImages.ts'));
  const HYDRATE = codeOf(path.join(ROOT, 'apps/api/src/parse/hydrate.ts'));
  const WORKER = codeOf(path.join(ROOT, 'apps/api/src/run/worker.ts'));

  it('bounds the document load and each page, not only the gap between pages', () => {
    // Three call sites, not counting the declaration: the document load
    // (opening a malformed PDF is itself unbounded work), `doc.getPage`, and
    // the render task's own promise.
    // (The declaration reads `withinBudget<T>(` and so is not one of these.)
    expect(PAGE_IMAGES.match(/withinBudget\(/g)?.length ?? 0).toBe(3);
    // The deadline starts BEFORE the parse, or the step most likely to hang
    // sits outside every cap this module declares.
    expect(PAGE_IMAGES.indexOf('const deadline'))
      .toBeLessThan(PAGE_IMAGES.indexOf('pdfjs.getDocument'));
    // …and a render that loses the race is cancelled rather than left
    // burning CPU for a result nobody will read.
    expect(PAGE_IMAGES).toMatch(/task\.cancel\(\)/);
  });

  it('carries the cell s AbortSignal from the worker to the renderer', () => {
    expect(HYDRATE).toMatch(/signal\?: AbortSignal/);
    expect(HYDRATE).toMatch(/deps\.signal \? \{ signal: deps\.signal \}/);
    // Both call sites — the collection's members and the single document —
    // because a signal that reaches one of them leaves the other holding a
    // slot nothing can interrupt.
    expect(WORKER).toMatch(/hydrateForReview\(db, deps, workspaceId, id, signal\)/);
    expect(WORKER).toMatch(/hydrateForReview\(deps\.db, deps, workspaceId, documentId, signal\)/);
    // The signal `runOneStep` builds is the one that reaches hydration.
    expect(WORKER).toMatch(/runOneCell\(deps, leased, models, controller\.signal\)/);
  });
});

/**
 * M8: THE WIRE CEILING AT THE SCALE IT WAS DOCUMENTED AT.
 *
 * `config.ts` calls `runImageBytesMax` "the wire ceiling on **one clause's**
 * page images". The check lived in `withImages`, which runs once per
 * DOCUMENT — and `extractCollectionClause` builds its body from
 * `present.flatMap(p => p.document.pageImages ?? [])`. A collection of a
 * scanned lease plus two scanned deeds, each at 70% of the budget, passed
 * three per-document checks and sent 210% of the ceiling.
 *
 * The result was a raw 413 from nginx or the gateway. That is loud — 413 is
 * not retryable, so it lands as an error finding rather than being retried
 * forever — but the operator got a status code instead of the sentence
 * naming the documents, their page counts and the two keys to move, which is
 * the entire reason the check exists.
 */
describe('cellImagesRefusal bounds a whole cell, not one document at a time', () => {
  const scan = (name: string, pages: number, bytesPerPage: number): DocumentFile => ({
    id: name,
    name,
    text: '',
    file: new File([], name),
    kind: 'pdf',
    pageImages: Array.from({ length: pages }, () => ({
      mime: 'image/jpeg', data: 'x'.repeat(bytesPerPage),
    })),
  });

  it('refuses three members at 70% each, which three per-document checks all passed', () => {
    const max = 1_000;
    const members = [scan('lease.pdf', 7, 100), scan('deed-1.pdf', 7, 100), scan('deed-2.pdf', 7, 100)];
    // Each on its own fits, which is why the per-document check said nothing.
    for (const m of members) {
      expect(cellImagesRefusal([m], max)).toBeUndefined();
    }
    const refusal = cellImagesRefusal(members, max);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('lease.pdf');
    expect(refusal).toContain('deed-1.pdf');
    expect(refusal).toContain('deed-2.pdf');
    expect(refusal).toContain('API_RUN_IMAGE_BYTES_MAX');
    expect(refusal).toContain('API_MAX_BODY_BYTES');
    expect(refusal).toMatch(/will not send part of a scan/);
  });

  it('says nothing when the cell fits, and nothing when there are no images at all', () => {
    expect(cellImagesRefusal([scan('a.pdf', 2, 100)], 1_000)).toBeUndefined();
    expect(cellImagesRefusal([], 1_000)).toBeUndefined();
    expect(cellImagesRefusal([null], 1_000)).toBeUndefined();
  });

  it('does not count a member that is already refused for its own reason', () => {
    // Its pages are not in the body: the extractor answers for it separately.
    const broken = { ...scan('gone.pdf', 20, 100), parseError: 'The original file is missing.' };
    expect(cellImagesRefusal([scan('a.pdf', 2, 100), broken], 1_000)).toBeUndefined();
  });

  it('is the SAME sentence the per-document check uses, so the two cannot drift', () => {
    const tail = 'API_RUN_IMAGE_BYTES_MAX and API_MAX_BODY_BYTES together.';
    expect(imageCeilingMessage('lease.pdf', 3, 9_000, 1_000)).toContain(tail);
    expect(cellImagesRefusal([scan('a.pdf', 20, 100)], 1_000)).toContain(tail);
  });
});
