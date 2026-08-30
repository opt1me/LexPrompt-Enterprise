import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, codeOf } from './sourceScan.ts';

/**
 * Spike 1 (§15, §19), executed: can the SERVER render page images?
 *
 * Inside the `api` container, because that is where the native canvas
 * binding actually has to work. A render that succeeds on a developer's
 * Windows Node (`@napi-rs/canvas-win32-x64-msvc`) and fails in a
 * `node:22-alpine` image (`-linux-x64-musl`) proves nothing about the
 * deployment, and the musl build is the one this stack ships.
 *
 * `*.compose.test.ts` is excluded from `npm test` (it shells out to
 * `docker compose exec`, and the default gate must stay green with no
 * Docker daemon at all). Requires `npm run compose:up`.
 *
 * THE FIXTURE. `fixtures/scanned-lease.pdf` is a genuine scan, generated
 * deterministically rather than downloaded: three pages, each a single
 * grayscale image XObject with speckle noise and NOT ONE text-drawing
 * operator, so pdf.js extracts zero characters from every page and every
 * page therefore sits below `SCAN_TEXT_THRESHOLD` (20). The generator is
 * recorded in `spike-1-report.md`. The first test below re-checks that
 * property on every run: a fixture that quietly acquired a text layer would
 * turn this whole file into a test of the easy case.
 */

/**
 * No `--env-file`, matching every other `*.compose.test.ts` in this
 * directory, and that is safe for exactly one reason: `exec` attaches to an
 * ALREADY-RUNNING container. Compose still interpolates `docker-compose.yml`
 * to find it and still warns that every `${OIDC_*}` is unset — the
 * repository's `.env` is a single bare line with no `NAME=` prefix — but
 * nothing here builds, recreates or restarts anything, so the blank values
 * reach no image and no process. `docker compose up --build` is where an
 * `--env-file /tmp/compose.env` is mandatory; a test must never run one.
 *
 * (Passing `--env-file /tmp/compose.env` here does not work anyway: Node's
 * `execFileSync` hands the argument to docker.exe unconverted, and Docker
 * Desktop resolves the POSIX path as `C:\\tmp\\compose.env`, which does not
 * exist. Every call fails with "couldn't find env file".)
 */
const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api',
      'node', '--experimental-strip-types', '--input-type=module', '-e', script,
    ], { encoding: 'utf8', timeout: 120_000 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const FIXTURE = '/app/apps/api/test/fixtures/scanned-lease.pdf';

/** The one line every in-container script prints, fished out of whatever
 *  pdf.js wrote to stdout around it. */
function resultOf({ code, out }: { code: number; out: string }): Record<string, unknown> {
  const line = out.split('\n').reverse().find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line (exit ${code}):\n${out}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

const PROBE = `
  const { readFileSync } = await import('node:fs');
  const { renderPageImages } = await import('/app/apps/api/src/parse/pageImages.ts');
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(readFileSync('${FIXTURE}'));

  // Is the fixture still a scan? Asked of pdf.js, not of the filename.
  // With its OWN copy of the bytes: pdf.js transfers the buffer it is given
  // and detaches it, and 'bytes' has to survive for the render below.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  const doc = await task.promise;
  const perPageChars = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    perPageChars.push(tc.items.map(x => x.str).join(' ').trim().length);
  }
  await task.destroy();   // v6: destroy() is on the loading task, not the proxy.

  const started = process.hrtime.bigint();
  const out = await renderPageImages(bytes, { maxPages: 50, timeoutMs: 30000 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // A blank page and a rendered page are both valid JPEGs. Decode each one
  // and count how much of it is not paper.
  const ink = [];
  for (const image of out.images) {
    const img = await loadImage(Buffer.from(image.data, 'base64'));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let dark = 0;
    for (let p = 0; p < px.length; p += 4) if (px[p] < 200) dark++;
    ink.push(dark / (px.length / 4));
  }

  console.log('RESULT ' + JSON.stringify({
    perPageChars,
    totalPages: out.totalPages,
    renderedPages: out.renderedPages,
    mimes: out.images.map(i => i.mime),
    magic: out.images.map(i => Buffer.from(i.data, 'base64').subarray(0, 3).toString('hex')),
    tail: out.images.map(i => { const b = Buffer.from(i.data, 'base64'); return b.subarray(b.length - 2).toString('hex'); }),
    byteLengths: out.images.map(i => Buffer.from(i.data, 'base64').byteLength),
    distinct: new Set(out.images.map(i => i.data)).size,
    // The caller's buffer must survive the call. pdf.js transfers what it
    // is handed; if renderPageImages passed 'bytes' straight through, this
    // would be 0 and every later read of the same document would see an
    // empty file with no error anywhere.
    bytesAfter: bytes.byteLength,
    ink,
    ms,
    rssMb: process.memoryUsage().rss / 1048576,
  }));
`;

describe('Spike 1: the server renders a scanned PDF to page images', () => {
  let result: Record<string, unknown>;

  beforeAll(() => { result = resultOf(inApi(PROBE)); }, 120_000);

  it('the fixture is genuinely a scan: every page is below SCAN_TEXT_THRESHOLD', () => {
    // If this fails the fixture gained a text layer and every other test in
    // this file is measuring the case that never needed an image.
    expect(result.perPageChars).toEqual([0, 0, 0]);
  });

  it('renders every page of the scanned PDF to a base64 image, in the container', () => {
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.renderedPages).toBe(result.totalPages);
    expect((result.mimes as string[]).length).toBe(result.totalPages);
  });

  it('the images are real JPEGs, in the same format and mime the browser produces', () => {
    // `src/lib/documents.ts` renders `image/jpeg` at quality 0.8; a server
    // that produced PNG would announce a different picture of the same page
    // to the same model.
    for (const mime of result.mimes as string[]) expect(mime).toBe('image/jpeg');
    for (const magic of result.magic as string[]) expect(magic).toBe('ffd8ff');   // SOI + marker
    for (const tail of result.tail as string[]) expect(tail).toBe('ffd9');        // EOI: not truncated
  });

  it('the images contain the scanned page, not a blank one', () => {
    // Not "it returned strings", and not "the string is long": a blank page
    // encodes to a perfectly valid JPEG. The images are DECODED and their
    // ink measured, and each page must differ from the others — three
    // identical images is what a render that silently drew nothing looks
    // like.
    for (const byteLength of result.byteLengths as number[]) expect(byteLength).toBeGreaterThan(5_000);
    for (const ink of result.ink as number[]) expect(ink).toBeGreaterThan(0.02);
    expect(result.distinct).toBe(result.totalPages);
  });

  it('leaves the caller holding its document, not a detached buffer', () => {
    // pdf.js TRANSFERS the array it is given to its worker port. A
    // renderPageImages that passed the caller's `Uint8Array` straight
    // through would detach it: the parse worker that read the document's
    // text out of those same bytes, and reads them again afterwards, would
    // find an empty file and no error to explain it.
    expect(result.bytesAfter).toBeGreaterThan(10_000);
  });

  it('records a timing rather than an impression', () => {
    // §15 asks for "a go/no-go with a worked example and a timing". Printed,
    // not asserted against a threshold: a wall-clock assertion on shared CI
    // hardware fails for reasons that have nothing to do with this code.
    const ms = result.ms as number;
    const pages = result.renderedPages as number;
    console.log(
      `[spike 1] ${pages} page(s) in ${ms.toFixed(0)}ms `
      + `(${(pages / (ms / 1000)).toFixed(2)} pages/s), `
      + `${(result.byteLengths as number[]).map(b => `${(b / 1024).toFixed(0)}KB`).join('/')}, `
      + `peak RSS ${(result.rssMb as number).toFixed(0)}MB`,
    );
    expect(ms).toBeGreaterThan(0);
  });

  it('reports a page cap as a shortfall instead of absorbing it', () => {
    // `renderedPages < totalPages` is the caller's only signal that it is
    // holding part of a document. It must survive.
    const capped = resultOf(inApi(`
      const { readFileSync } = await import('node:fs');
      const { renderPageImages } = await import('/app/apps/api/src/parse/pageImages.ts');
      const out = await renderPageImages(new Uint8Array(readFileSync('${FIXTURE}')), { maxPages: 1, timeoutMs: 30000 });
      console.log('RESULT ' + JSON.stringify({ rendered: out.renderedPages, total: out.totalPages, images: out.images.length }));
    `));
    expect(capped).toEqual({ rendered: 1, total: 3, images: 1 });
  });

  it('throws on a render budget it cannot meet, rather than returning half a scan', () => {
    // A partly-rendered scan handed to a model reads as a document that is
    // silent on everything the missing pages said — the founding defect,
    // wearing a successful return value.
    const timedOut = resultOf(inApi(`
      const { readFileSync } = await import('node:fs');
      const mod = await import('/app/apps/api/src/parse/pageImages.ts');
      let outcome;
      try {
        const out = await mod.renderPageImages(new Uint8Array(readFileSync('${FIXTURE}')), { maxPages: 50, timeoutMs: -1 });
        outcome = { threw: false, renderedPages: out.renderedPages };
      } catch (err) {
        outcome = { threw: true, name: err.name, isTypedError: err instanceof mod.PageRenderTimeoutError, message: err.message };
      }
      console.log('RESULT ' + JSON.stringify(outcome));
    `));
    expect(timedOut.threw).toBe(true);
    expect(timedOut.name).toBe('PageRenderTimeoutError');
    expect(timedOut.isTypedError).toBe(true);
    expect(timedOut.message).toMatch(/has not been reviewed/);
  });
});

describe('page images are never persisted', () => {
  const SOURCE = path.resolve(ROOT, 'apps/api/src/parse/pageImages.ts');

  it('writes no image anywhere — not to Postgres, not to the blob store', () => {
    // Comments stripped first (`codeOf`), because this file's own docstring
    // says at length that it must not reach a blob store, and a raw text
    // search cannot tell that sentence from a call.
    const code = codeOf(SOURCE);
    expect(code).not.toMatch(/blobStore|BlobStore|blobKeyFor|\.put\(|insert into|INSERT INTO|withPool|getPool/);
    // The companion positive assertion, or the above passes on an empty file
    // — and on a file that was deleted and re-stubbed.
    expect(code).toMatch(/export async function renderPageImages/);
    expect(code.length).toBeGreaterThan(1_000);
  });
});
