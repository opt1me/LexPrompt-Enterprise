import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseFile, parseFiles, toDocumentRecord, documentFileForReview, documentFileForViewing,
  evictPageImages, BLOB_UNAVAILABLE_MESSAGE, PAGE_IMAGE_CACHE_MAX_DOCUMENTS,
} from './documents';
import { TRACKED_CHANGES_NOTICE, COMMENTS_NOTICE, MARKUP_UNCHECKED_NOTICE } from './docxMarkup';
import { buildDocx, CLEAN_BODY, TRACKED_BODY, COMMENTED_BODY, TABLE_BODY } from '../test/docxFixture';
import type { DocumentRecord } from '../types';

// pdf.js and mammoth are heavy and DOM-bound; the unit tests cover dispatch
// and error isolation. Real PDF parsing is covered by manual verification
// against test_docs/ in Task 19.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Hello world from the PDF' }] }),
        getViewport: () => ({ width: 100, height: 100 }),
      }),
    }),
  })),
}));

vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn(async () => ({ value: 'docx text' })) },
}));

function makeFile(name: string, type: string, content = 'plain text body'): File {
  return new File([content], name, { type });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('parseFile', () => {
  it('reads a plain text file', async () => {
    const doc = await parseFile(makeFile('a.txt', 'text/plain'));
    expect(doc.kind).toBe('txt');
    expect(doc.text).toBe('plain text body');
    expect(doc.name).toBe('a.txt');
  });

  it('extracts text from a PDF and tags the page number', async () => {
    const doc = await parseFile(makeFile('a.pdf', 'application/pdf'));
    expect(doc.kind).toBe('pdf');
    expect(doc.text).toContain('Hello world from the PDF');
    expect(doc.text).toContain('[Page 1]');
  });

  it('extracts text from a DOCX', async () => {
    const doc = await parseFile(makeFile(
      'a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ));
    expect(doc.kind).toBe('docx');
    expect(doc.text).toBe('docx text');
  });

  it('falls back to extension when the browser reports no MIME type', async () => {
    const doc = await parseFile(makeFile('contract.pdf', ''));
    expect(doc.kind).toBe('pdf');
  });

  it('assigns a unique id per document', async () => {
    const a = await parseFile(makeFile('a.txt', 'text/plain'));
    const b = await parseFile(makeFile('b.txt', 'text/plain'));
    expect(a.id).not.toBe(b.id);
  });

  it('records a parse failure on the document instead of throwing', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('corrupt file');
    });

    const doc = await parseFile(makeFile('bad.pdf', 'application/pdf'));
    expect(doc.parseError).toMatch(/corrupt file/);
    expect(doc.text).toBe('');
  });

  it('renders a scanned page (near-empty text layer) to a JPEG image', async () => {
    // jsdom does not implement a real <canvas> 2D backend, so the canvas
    // element itself is stubbed here; this still exercises the real
    // production code path (renderPageToJpeg) that decides *whether* to
    // render, not jsdom's canvas rendering itself.
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({})),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,ZmFrZWRhdGE='),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );

    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'x' }] }), // far below threshold
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);

    const doc = await parseFile(makeFile('scan.pdf', 'application/pdf'));
    expect(doc.pageImages).toBeDefined();
    expect(doc.pageImages?.length).toBe(1);
    expect(doc.pageImages?.[0].mime).toBe('image/jpeg');
    expect(doc.pageImages?.[0].data).toBe('ZmFrZWRhdGE=');
    expect(fakeCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8);

    createElementSpy.mockRestore();
  });

  it('still returns the extracted text when canvas rendering throws (real jsdom behavior)', async () => {
    // Real jsdom does not return null from getContext('2d') -- it throws
    // "Not implemented" (HTMLCanvasElement-impl.js). A scanned PDF must
    // still open with whatever text it has; only the page image is lost.
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => {
        throw new Error('Not implemented: HTMLCanvasElement.prototype.getContext');
      }),
      toDataURL: vi.fn(),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );

    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'sparse' }] }), // far below threshold
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);

    const doc = await parseFile(makeFile('scan.pdf', 'application/pdf'));

    expect(doc.parseError).toBeUndefined();
    expect(doc.text).toContain('sparse');
    expect(doc.pageImages).toBeUndefined();

    createElementSpy.mockRestore();
  });
});

describe('parseFiles', () => {
  it('isolates one bad file from the rest of the batch', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('corrupt file');
    });

    const docs = await parseFiles([
      makeFile('bad.pdf', 'application/pdf'),
      makeFile('good.txt', 'text/plain'),
    ]);

    expect(docs.length).toBe(2);
    expect(docs[0].parseError).toBeTruthy();
    expect(docs[0].text).toBe('');
    expect(docs[1].parseError).toBeUndefined();
    expect(docs[1].text).toBe('plain text body');
    expect(docs[1].kind).toBe('txt');
  });

  it('parses many files independently even when several fail', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument)
      .mockImplementationOnce(() => { throw new Error('corrupt 1'); })
      .mockImplementationOnce(() => { throw new Error('corrupt 2'); });

    const docs = await parseFiles([
      makeFile('bad1.pdf', 'application/pdf'),
      makeFile('bad2.pdf', 'application/pdf'),
      makeFile('good1.txt', 'text/plain', 'first'),
      makeFile('good2.txt', 'text/plain', 'second'),
    ]);

    expect(docs.map(d => d.parseError !== undefined)).toEqual([true, true, false, false]);
    expect(docs[2].text).toBe('first');
    expect(docs[3].text).toBe('second');
  });
});

describe('toDocumentRecord', () => {
  it('builds a DocumentRecord carrying the parsed metadata, and the File as bytes', async () => {
    const doc = await parseFile(makeFile('nda.txt', 'text/plain', 'the body'));
    const { record, bytes } = toDocumentRecord(doc, 'matter-1', 'user-1');

    expect(record.id).toBe(doc.id);
    expect(record.matterId).toBe('matter-1');
    expect(record.name).toBe('nda.txt');
    expect(record.kind).toBe('txt');
    expect(record.text).toBe('the body');
    expect(record.byteSize).toBe(doc.file.size);
    expect(record.addedByUserId).toBe('user-1');
    expect(record.addedAt).toBeGreaterThan(0);
    expect(bytes).toBe(doc.file);
  });

  it('carries a parse error through onto the record', async () => {
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('corrupt file');
    });
    const doc = await parseFile(makeFile('bad.pdf', 'application/pdf'));

    const { record } = toDocumentRecord(doc, 'matter-1', 'user-1');
    expect(record.parseError).toMatch(/corrupt file/);
  });

  it('never carries pageImages onto the record — LexPrompt persists source bytes, not derived page images', async () => {
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({})),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,ZmFrZWRhdGE='),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'x' }] }),
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);

    const doc = await parseFile(makeFile('scan.pdf', 'application/pdf'));
    expect(doc.pageImages?.length).toBe(1); // sanity: this document did produce page images

    const { record } = toDocumentRecord(doc, 'matter-1', 'user-1');
    expect('pageImages' in record).toBe(false);

    createElementSpy.mockRestore();
  });
});

describe('documentFileForReview', () => {
  function makeRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
    return {
      id: 'doc-1',
      matterId: 'matter-1',
      name: 'lease.pdf',
      kind: 'pdf',
      text: '',
      byteSize: 100,
      addedAt: Date.now(),
      addedByUserId: 'user-1',
      role: 'standalone',
      ...overrides,
    };
  }

  function makeBlob(): Blob {
    return new Blob(['%PDF-1.4 fake bytes'], { type: 'application/pdf' });
  }

  /** Stubs the canvas so `renderPageToJpeg` succeeds in jsdom; returns a
   *  restore function to call at the end of the test. */
  function mockScanCanvas(): () => void {
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({})),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,eA=='),
    };
    const originalCreateElement = document.createElement.bind(document);
    const spy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );
    return () => spy.mockRestore();
  }

  /** A one-page, below-threshold "scan" pdfjs document, freshly built each
   *  call so a `mockImplementation` (as opposed to `mockReturnValueOnce`)
   *  can serve an unbounded number of `getDocument()` calls in the cache
   *  bound test below. */
  function scanPdfDocument() {
    return {
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'x' }] }),
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    };
  }

  it('does not re-parse a document whose text layer is healthy on every page', async () => {
    const record = makeRecord({
      text: '[Page 1]\nThis page has plenty of real, readable text content.\n\n'
        + '[Page 2]\nAnother page with plenty of readable text content too.\n\n',
    });

    const doc = await documentFileForReview(record, makeBlob());

    const pdfjs = await import('pdfjs-dist');
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(doc.text).toBe(record.text);
    expect(doc.pageImages).toBeUndefined();
    expect(doc.parseError).toBeUndefined();
  });

  it('regenerates page images, per page, for a document with at least one below-threshold page', async () => {
    // Mixed document: page 1 is healthy text, page 2 is a scan -- a
    // document-wide character count would let page 1 carry the whole
    // document over SCAN_TEXT_THRESHOLD and skip page 2 entirely.
    const record = makeRecord({
      id: 'doc-mixed',
      text: '[Page 1]\nThis page has plenty of real, readable text content.\n\n'
        + '[Page 2]\nx\n\n',
    });

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({})),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,cGFnZTI='),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );

    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (n: number) => ({
          getTextContent: async () => ({
            items: [{ str: n === 1 ? 'This page has plenty of real, readable text content.' : 'x' }],
          }),
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);

    const doc = await documentFileForReview(record, makeBlob());

    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(doc.pageImages?.length).toBe(1);
    expect(doc.pageImages?.[0].data).toBe('cGFnZTI=');
    expect(doc.parseError).toBeUndefined();

    createElementSpy.mockRestore();
  });

  it('caches regenerated page images within the session, so a second review does not re-render', async () => {
    const record = makeRecord({ id: 'doc-cache', text: '[Page 1]\nx\n\n' });
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({})),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,Y2FjaGVk'),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag),
      );

    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'x' }] }),
          getViewport: () => ({ width: 10, height: 10 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      }),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);

    const first = await documentFileForReview(record, makeBlob());
    expect(first.pageImages?.length).toBe(1);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);

    // Second review of the same document, same session: no further
    // getDocument() call (no re-render), and the persisted text is
    // untouched rather than replaced by whatever the (unused) reparse
    // would have produced.
    const second = await documentFileForReview(record, makeBlob());
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(second.pageImages).toEqual(first.pageImages);
    expect(second.text).toBe(record.text);

    createElementSpy.mockRestore();
  });

  it('surfaces a failed regeneration as parseError, distinct from "no images needed"', async () => {
    const record = makeRecord({ id: 'doc-broken', text: '[Page 1]\nx\n\n' });

    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementationOnce(() => {
      throw new Error('stored bytes are not a valid PDF');
    });

    const doc = await documentFileForReview(record, makeBlob());

    expect(doc.parseError).toMatch(/stored bytes are not a valid PDF/);
    // A document that legitimately needed no images also comes back with
    // pageImages undefined -- parseError is what tells the two apart, so a
    // caller must not treat an empty pageImages array as "reviewable".
    expect(doc.pageImages).toBeUndefined();
  });

  it('degrades to an explanatory parseError, never a throw, when the blob is missing', async () => {
    const record = makeRecord({ id: 'doc-missing-blob', text: '[Page 1]\nx\n\n' });
    const doc = await documentFileForReview(record, null);
    expect(doc.parseError).toBe(BLOB_UNAVAILABLE_MESSAGE);
    expect(doc.pageImages).toBeUndefined();
  });

  it('evictPageImages removes a cached entry, so the next review regenerates instead of reusing it', async () => {
    const record = makeRecord({ id: 'doc-evict', text: '[Page 1]\nx\n\n' });
    const restoreCanvas = mockScanCanvas();
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
      scanPdfDocument() as unknown as ReturnType<typeof pdfjs.getDocument>,
    );

    const first = await documentFileForReview(record, makeBlob());
    expect(first.pageImages?.length).toBe(1);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);

    evictPageImages('doc-evict');

    vi.mocked(pdfjs.getDocument).mockReturnValueOnce(
      scanPdfDocument() as unknown as ReturnType<typeof pdfjs.getDocument>,
    );
    const second = await documentFileForReview(record, makeBlob());
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(2); // re-rendered, not served from a stale cache entry
    expect(second.pageImages?.length).toBe(1);

    restoreCanvas();
  });

  it('bounds the session cache to PAGE_IMAGE_CACHE_MAX_DOCUMENTS documents, evicting least-recently-used', async () => {
    const restoreCanvas = mockScanCanvas();
    const pdfjs = await import('pdfjs-dist');
    vi.mocked(pdfjs.getDocument).mockImplementation(
      () => scanPdfDocument() as unknown as ReturnType<typeof pdfjs.getDocument>,
    );

    // Fill the cache past its cap with one more document than it holds.
    const overflow = PAGE_IMAGE_CACHE_MAX_DOCUMENTS + 1;
    for (let i = 0; i < overflow; i++) {
      const record = makeRecord({ id: `doc-bound-${i}`, text: '[Page 1]\nx\n\n' });
      await documentFileForReview(record, makeBlob());
    }
    const callsAfterFill = vi.mocked(pdfjs.getDocument).mock.calls.length;
    expect(callsAfterFill).toBe(overflow);

    // The first document inserted was evicted to make room for the last —
    // reviewing it again must re-render, not hit a stale cache entry.
    const evicted = makeRecord({ id: 'doc-bound-0', text: '[Page 1]\nx\n\n' });
    await documentFileForReview(evicted, makeBlob());
    expect(vi.mocked(pdfjs.getDocument).mock.calls.length).toBe(callsAfterFill + 1);

    // The most recently inserted document is still cached (no re-render).
    const recent = makeRecord({ id: `doc-bound-${overflow - 1}`, text: '[Page 1]\nx\n\n' });
    await documentFileForReview(recent, makeBlob());
    expect(vi.mocked(pdfjs.getDocument).mock.calls.length).toBe(callsAfterFill + 1);

    restoreCanvas();
  });
});

// Placed last and using its own fresh module instance (via vi.resetModules +
// a dynamic re-import) rather than the file's top-level `parseFile`/`parseFiles`
// bindings: this test needs the *dynamic import of pdfjs-dist itself* to fail
// once, not just `getDocument()`, which the other tests' shared mock can't
// express without disturbing them. Kept last so its vi.doMock overrides can't
// leak into earlier tests' `await import('pdfjs-dist')` calls.
describe('loadPdfjs retry after a failed import', () => {
  it('recovers on the next parseFile instead of staying broken forever', async () => {
    vi.resetModules();
    // Simulates a chunk load failure (e.g. a redeploy invalidated the pdf.js
    // chunk hash while this tab was still open) rather than a
    // getDocument()-level error: the dynamic import() itself rejects.
    vi.doMock('pdfjs-dist', () => Promise.reject(new Error('Failed to fetch dynamically imported module')));

    const fresh = await import('./documents');

    const failed = await fresh.parseFile(makeFile('a.pdf', 'application/pdf'));
    // Contract preserved: a failed pdfjs-dist import still comes back as an
    // error Finding on the document, never a thrown exception out of
    // parseFile. (The exact message is Vitest's own module-mocking error
    // text, not the one thrown above — vi.doMock rewrites factory failures
    // before they reach the caller — so only the shape of the contract is
    // asserted here, not the wording.)
    expect(typeof failed.parseError).toBe('string');
    expect(failed.parseError).toBeTruthy();
    expect(failed.text).toBe('');

    // Without clearing the memo on rejection, every later call would reuse
    // the same rejected promise and fail identically forever.
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({ items: [{ str: 'Hello world from the PDF' }] }),
            getViewport: () => ({ width: 100, height: 100 }),
          }),
        }),
      })),
    }));

    const recovered = await fresh.parseFile(makeFile('b.pdf', 'application/pdf'));
    expect(recovered.parseError).toBeUndefined();
    expect(recovered.text).toContain('Hello world from the PDF');

    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Tracked changes and margin comments (spike 1)
//
// mammoth reads a `<w:ins>` straight through and drops `<w:del>` without a
// message, so a marked-up draft arrives as fluent accepted-changes prose
// that nothing downstream can tell apart from the real thing. `parseFile`
// checks the package itself and attaches a notice saying what it actually
// did. The notice is deliberately NOT a `parseError`: the document parsed,
// it is reviewable, and blocking the review over a caveat would be wrong.
// ---------------------------------------------------------------------------

function docxFile(bytes: ArrayBuffer, name = 'lease.docx'): File {
  return new File([new Uint8Array(bytes)], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

describe('parseFile: DOCX markup disclosure', () => {
  it('flags a redlined document with a notice, not a parse error, and still returns its text', async () => {
    const doc = await parseFile(docxFile(await buildDocx(TRACKED_BODY)));

    expect(doc.markupNotice).toBe(TRACKED_CHANGES_NOTICE);
    // The distinction the whole fix rests on: readable-with-a-caveat is not
    // unreadable. A `parseError` would make `extractClause` refuse the
    // document and `DocumentViewer` render an error instead of the text.
    expect(doc.parseError).toBeUndefined();
    expect(doc.text).toBe('docx text');
  });

  it('flags margin comments as excluded from the reviewed text', async () => {
    const doc = await parseFile(docxFile(await buildDocx(COMMENTED_BODY)));
    expect(doc.markupNotice).toBe(COMMENTS_NOTICE);
    expect(doc.parseError).toBeUndefined();
  });

  it('leaves the field off entirely for a clean document', async () => {
    const doc = await parseFile(docxFile(await buildDocx(CLEAN_BODY)));
    // `in`, not `toBeUndefined`: an absent key and an undefined one are the
    // same to `toEqual` but not to `structuredClone`, which is how every
    // record reaches IndexedDB.
    expect('markupNotice' in doc).toBe(false);
  });

  it('does not flag a clean document that merely contains a table', async () => {
    const doc = await parseFile(docxFile(await buildDocx(TABLE_BODY)));
    expect('markupNotice' in doc).toBe(false);
  });

  it('says it could not check, rather than nothing, when the package cannot be opened', async () => {
    // mammoth is mocked here, so this stands for the real case where the
    // text extractor succeeds but the package cannot be inspected. Silence
    // would be indistinguishable from "checked, clean".
    const doc = await parseFile(docxFile(new TextEncoder().encode('not a zip').buffer));

    expect(doc.markupNotice).toBe(MARKUP_UNCHECKED_NOTICE);
    expect(doc.parseError).toBeUndefined();
    expect(doc.text).toBe('docx text');
  });

  it('does not check a PDF or a text file for DOCX markup', async () => {
    expect('markupNotice' in (await parseFile(makeFile('a.pdf', 'application/pdf')))).toBe(false);
    expect('markupNotice' in (await parseFile(makeFile('a.txt', 'text/plain')))).toBe(false);
  });
});

describe('toDocumentRecord: markup notice', () => {
  it('carries the notice onto the persisted record', async () => {
    const doc = await parseFile(docxFile(await buildDocx(TRACKED_BODY)));
    const { record } = toDocumentRecord(doc, 'matter-1', 'user-1');
    expect(record.markupNotice).toBe(TRACKED_CHANGES_NOTICE);
    expect(record.parseError).toBeUndefined();
  });

  it('leaves the key off a clean document rather than writing undefined', async () => {
    const doc = await parseFile(docxFile(await buildDocx(CLEAN_BODY)));
    const { record } = toDocumentRecord(doc, 'matter-1', 'user-1');
    expect('markupNotice' in record).toBe(false);
  });
});

describe('hydration carries the markup notice', () => {
  const noticed: DocumentRecord = {
    id: 'd1',
    matterId: 'm1',
    name: 'lease.docx',
    kind: 'docx',
    text: 'Consent may be withheld only where it is reasonable to do so.',
    markupNotice: TRACKED_CHANGES_NOTICE,
    byteSize: 10,
    addedAt: 1,
    addedByUserId: 'u1',
    role: 'standalone',
  };

  it('reaches the viewer', () => {
    expect(documentFileForViewing(noticed, new Blob(['x'])).markupNotice).toBe(TRACKED_CHANGES_NOTICE);
  });

  it('reaches a run over a persisted document', async () => {
    const doc = await documentFileForReview(noticed, new Blob(['x']));
    expect(doc.markupNotice).toBe(TRACKED_CHANGES_NOTICE);
  });

  it('is absent, not undefined, on a document that carries no notice', async () => {
    const clean: DocumentRecord = { ...noticed };
    delete clean.markupNotice;
    expect('markupNotice' in documentFileForViewing(clean, new Blob(['x']))).toBe(false);
    expect('markupNotice' in (await documentFileForReview(clean, new Blob(['x'])))).toBe(false);
  });
});

/**
 * C1: THE UPLOAD RETURNS BEFORE THE TEXT EXISTS, AND THE BROWSER IS ITS
 * ONLY CLIENT.
 *
 * Since Stage 3 `POST /v1/documents` stores the bytes, writes the row
 * `parse_state = 'pending'`, `text = ''`, and returns; a parse worker reads
 * the file a moment later. `src/lib/db/documents.ts` is an HTTP client over
 * that route and `saveDocument` reads nothing back, so after a reload the
 * browser's only copy of a document's text is the row the upload just
 * blanked.
 *
 * What that produced: `documentFileForReview` handed the extractor a
 * document with `text: ''` and no `parseError`, `assessDocument` answered
 * `unreadable`, and every clause came back *"X has no readable text or
 * images to review. It may have failed to parse, or be a scan with no
 * extractable content."* — false in BOTH branches, for a document nothing
 * had tried to read yet. `parseState` was on the wire with zero readers in
 * `src/`.
 *
 * These are the readers.
 */
describe('a document that has not finished being read is loudly not-yet-read', () => {
  const pending: DocumentRecord = {
    id: 'd-pending',
    matterId: 'm1',
    name: 'lease.pdf',
    kind: 'pdf',
    text: '',
    parseState: 'pending',
    byteSize: 4_000_000,
    addedAt: Date.now(),
    addedByUserId: 'u1',
    role: 'standalone',
  };

  it('says so on the review hydration, rather than handing over an empty document', async () => {
    const doc = await documentFileForReview(pending, new Blob(['%PDF-1.4']));
    expect(doc.parseError).toBeTruthy();
    expect(doc.parseError).toContain('lease.pdf');
    expect(doc.parseError).toMatch(/has not finished being read/);
    // …and it does NOT read as a parse failure or as a scan, which is the
    // whole distinction.
    expect(doc.parseError).not.toMatch(/failed to parse|scan/i);
  });

  it('says so on the viewer hydration too, and wins over the missing-blob message', () => {
    const doc = documentFileForViewing(pending, null);
    expect(doc.parseError).toMatch(/has not finished being read/);
    expect(doc.parseError).not.toBe(BLOB_UNAVAILABLE_MESSAGE);
  });

  it('leaves a parsed document exactly as it was — absent parseState is not pending', async () => {
    // A record the browser built for itself has never been anywhere that
    // could answer the question, and treating "we do not know" as "still
    // reading" would refuse a review of a document sitting parsed in memory.
    const unknown: DocumentRecord = { ...pending, text: 'The term is ten years.' };
    delete unknown.parseState;
    const doc = await documentFileForReview(unknown, new Blob(['%PDF-1.4']));
    expect(doc.parseError).toBeUndefined();
    expect(doc.text).toBe('The term is ten years.');

    const parsed = await documentFileForReview(
      { ...pending, parseState: 'parsed', text: 'The term is ten years.' },
      new Blob(['%PDF-1.4']));
    expect(parsed.parseError).toBeUndefined();
  });

  it('carries a real parse failure through unchanged — the two are different facts', async () => {
    const failed: DocumentRecord = {
      ...pending, parseState: 'failed', parseError: 'This PDF is encrypted and could not be read.',
    };
    const doc = await documentFileForReview(failed, new Blob(['%PDF-1.4']));
    expect(doc.parseError).toBe('This PDF is encrypted and could not be read.');
  });
});
