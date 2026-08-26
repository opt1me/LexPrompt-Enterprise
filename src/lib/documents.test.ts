import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFile, parseFiles, toDocumentRecord } from './documents';

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
