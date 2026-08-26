import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFile, parseFiles } from './documents';

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
