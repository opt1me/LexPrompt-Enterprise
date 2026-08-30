import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SCAN_TEXT_THRESHOLD, pageSegmentsWithNumbers } from '@lexprompt/core';
import { ROOT, codeOf } from './sourceScan.ts';
import {
  classifyDocument, pageBlock, pageMarker, parseDocument, sparsePagesOf,
} from '../src/parse/parseDocument.ts';

/**
 * Task 9: the server reads documents, and produces the SAME text the browser
 * does — marker for marker.
 *
 * ## Why the equality is asserted against the browser's SOURCE and not
 * against its output
 *
 * The brief asks for `expect(fromServer.text).toBe(fromBrowser.text)` with
 * `parseFile` called in the jsdom project. That test is not runnable, and
 * the reason is worth recording rather than working around:
 *
 *  - `parseFile` takes a `File` and reaches for `document.createElement`,
 *    so it needs jsdom; this module has no DOM lib at all and `apps/api`'s
 *    tsconfig deliberately keeps it that way.
 *  - `parseFile` loads `pdfjs-dist`'s MODERN build, which throws `DOMMatrix
 *    is not defined` under Node — Spike 1's first finding. Only the legacy
 *    build works here, so the two cannot be loaded into one process.
 *
 * What would actually drift is the FORMAT, and that is what is checked: the
 * exact `[Page N]\n…\n\n` shape and the `' '` join between text items, read
 * out of the browser's own shipped source. Both sides then round-trip a real
 * PDF through `pageSegmentsWithNumbers` — the function `derivePage` uses to
 * decide every citation's page.
 */

const BROWSER = path.join(ROOT, 'src/lib/documents.ts');
const A_REAL_PDF = path.join(ROOT, 'test_docs/openrent_standard_ast.pdf');
const A_SCAN = path.join(ROOT, 'apps/api/test/fixtures/scanned-lease.pdf');

describe('the page-marker format, against the browser s own source', () => {
  it('writes a page exactly as parsePdf does', () => {
    const browser = codeOf(BROWSER);
    // THE SHIPPED SOURCE WINS. If either side changes this line, this
    // assertion is what says so — and a `[Page N]` marker that moved would
    // move every citation's derived page silently.
    expect(browser).toContain('text += `[Page ${i}]\\n${pageText}\\n\\n`;');
    expect(pageBlock(1, 'x')).toBe('[Page 1]\nx\n\n');
    expect(pageMarker(4)).toBe('[Page 4]');
  });

  it('joins a page s text items with a single space, as parsePdf does', () => {
    const browser = codeOf(BROWSER);
    // A different separator would change every quote's whitespace and
    // therefore whether `findQuoteRects` can locate it at all.
    expect(browser).toContain(".join(' ');");
    expect(codeOf(path.join(ROOT, 'apps/api/src/parse/parseDocument.ts')))
      .toContain(".join(' ');");
  });

  it('the scan is reading the browser file it names', () => {
    // A guard whose source file moved would pass vacuously on an empty
    // string; `codeOf` throws on a missing file, and this pins the content.
    expect(codeOf(BROWSER)).toContain('export async function parseFile');
    expect(codeOf(BROWSER).length).toBeGreaterThan(5_000);
  });
});

describe('parsing a real PDF', () => {
  it('produces one marked page per page, findable by pageSegmentsWithNumbers', async () => {
    const parsed = await parseDocument(
      new Uint8Array(readFileSync(A_REAL_PDF)), 'application/pdf', 'openrent.pdf');
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.pageCount).toBeGreaterThan(1);

    const pages = pageSegmentsWithNumbers(parsed.text);
    expect(pages).toHaveLength(parsed.pageCount);
    expect(pages.map(p => p.page)).toEqual(
      Array.from({ length: parsed.pageCount }, (_, i) => i + 1));
    // A tenancy agreement has text on it. Asserted so a parser that returned
    // markers and nothing else could not pass this file.
    expect(parsed.text.length).toBeGreaterThan(2_000);
    expect(parsed.sparsePages).toEqual([]);
  }, 30_000);

  it('reports every page of a genuine scan as sparse', async () => {
    const parsed = await parseDocument(
      new Uint8Array(readFileSync(A_SCAN)), 'application/pdf', 'scanned-lease.pdf');
    expect(parsed.parseError).toBeUndefined();
    // The fixture is three pages of image XObject with no text-drawing
    // operator at all — `pageImages.compose.test.ts` re-checks that property
    // against pdf.js on every run.
    expect(parsed.pageCount).toBe(3);
    expect(parsed.sparsePages).toEqual([1, 2, 3]);
  }, 30_000);
});

describe('scan detection is PER PAGE, never over the document total', () => {
  it('catches a typed cover page carrying a scanned body', () => {
    // THIS BLIND SPOT HAS HAD TO BE FIXED THREE TIMES (`CLAUDE.md`). One
    // readable page and nine empty ones has plenty of text IN TOTAL and is
    // unreadable without images.
    const cover = 'THIS LEASE is made on 1 January 2020 between the parties named below. '.repeat(5);
    const text = pageBlock(1, cover)
      + Array.from({ length: 9 }, (_, i) => pageBlock(i + 2, '')).join('');

    // A document-wide check would pass this comfortably…
    expect(text.replace(/\[Page \d+\]/g, '').trim().length)
      .toBeGreaterThan(SCAN_TEXT_THRESHOLD * 10);
    // …and the per-page one names all nine.
    expect(sparsePagesOf(text)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reads the LABELLED page number, not the ordinal', () => {
    // A page that produced no text still gets its marker, so an ordinal
    // would be off by one for everything after it — and the renderer would
    // be handed the wrong pages of a scan.
    const text = `${pageBlock(1, '')}${pageBlock(2, 'x'.repeat(50))}${pageBlock(3, '')}`;
    expect(sparsePagesOf(text)).toEqual([1, 3]);
  });

  it('says a document with no page markers has no page information', () => {
    // NOT "one page called 1". A caller that needs a page number must be
    // able to tell "this document has no page information" from "page 1",
    // and inventing a page is the one thing citation pinning must never do.
    expect(sparsePagesOf('a docx has no page markers')).toEqual([]);
  });
});

describe('a parse that fails is a real answer with a real message', () => {
  it('reports a corrupt PDF rather than returning empty text', async () => {
    const parsed = await parseDocument(
      new Uint8Array(Buffer.from('this is not a pdf at all')),
      'application/pdf', 'broken.pdf');
    expect(parsed.parseError).toBeTruthy();
    expect(parsed.text).toBe('');
    // Never `parsed` with empty text: "a document silently marked parsed
    // with no text is the founding defect wearing a database column".
  }, 20_000);

  it('reports a corrupt docx rather than returning empty text', async () => {
    const parsed = await parseDocument(
      new Uint8Array(Buffer.from('PK not really a zip')),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'broken.docx');
    expect(parsed.parseError).toBeTruthy();
    expect(parsed.text).toBe('');
    // 20s, like the sibling below and for the same reason: this parse loads
    // `jszip` and `mammoth` on first use, and under full-suite parallel load
    // that has outgrown Vitest's 5s default — a timeout that reads as a
    // broken parser when the parser is fine.
  }, 20_000);

  it('never rejects — a bad document is a value, not an exception', async () => {
    // The same posture `extractClause` has. A worker that had to catch this
    // would be one refactor away from letting a bad document kill a run.
    await expect(parseDocument(new Uint8Array([0, 1, 2]), 'application/pdf', 'x.pdf'))
      .resolves.toMatchObject({ text: '' });
  }, 20_000);
});

describe('plain text and classification', () => {
  it('reads a txt document as its own bytes', async () => {
    const parsed = await parseDocument(
      new TextEncoder().encode('Clause 1. The term is ten years.'), 'text/plain', 'notes.txt');
    expect(parsed.text).toBe('Clause 1. The term is ten years.');
    expect(parsed.pageCount).toBe(1);
    expect(parsed.sparsePages).toEqual([]);
  });

  it('classifies on mime first and on the name as the tiebreak', () => {
    expect(classifyDocument('application/pdf', 'anything')).toBe('pdf');
    // A .docx uploaded with a generic content type is still a .docx — which
    // is what a browser sends for a file dragged from some file managers.
    expect(classifyDocument('application/octet-stream', 'lease.docx')).toBe('docx');
    expect(classifyDocument('application/octet-stream', 'scan.PDF')).toBe('pdf');
    expect(classifyDocument('text/plain', 'notes.txt')).toBe('txt');
  });
});
