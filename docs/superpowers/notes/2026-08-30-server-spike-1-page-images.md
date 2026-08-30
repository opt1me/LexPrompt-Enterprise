# Spike 1 — can the server render page images?

**Answer: YES, with two caveats that are named below and cost nothing to carry.**

Executed on 2026-08-30 against the running compose stack, inside the `api`
container (`node:22-alpine`, Node v22.23.2, linux/x64/musl). Not on a laptop's
Node: the binding that had to work is `@napi-rs/canvas-linux-x64-musl`, and a
Windows `-msvc` build proving nothing about the deployment is the failure mode
this spike exists to avoid.

Tasks 9 and 10 proceed as written. §15's fallback — Azure AI Document
Intelligence at ingest, and the §12 Q5 subprocessor change it drags with it —
is **not needed** and is not being taken.

---

## What was run

`apps/api/src/parse/pageImages.ts` — the kept code — and
`apps/api/test/pageImages.compose.test.ts`, which drives it inside the
container over a genuinely scanned fixture.

### The fixture

`apps/api/test/fixtures/scanned-lease.pdf`, 44,285 bytes, 3 pages, committed.

Generated rather than downloaded, because nothing in the repository was a
scan and a fixture has to be reproducible. It is built by a short script that
emits a PDF by hand: each page is a single 850×1100 `DeviceGray` image
XObject (`FlateDecode`), drawn full-bleed by a content stream of
`q 612 0 0 792 0 0 cm /Im0 Do Q` — **not one text-drawing operator anywhere in
the file**. The bitmap is ~35 lines of black bars of varying width over an
off-white ground, plus 4% seeded speckle noise, so it renders like a scanned
page rather than a blank one. A seeded LCG makes it byte-identical on
re-generation. The generator is reproduced at the end of this report.

pdf.js extracts **0 characters from every page**, so every page is below
`SCAN_TEXT_THRESHOLD` (20) — per page, which is the granularity CLAUDE.md says
has had to be fixed three times. The first test in the suite re-checks that on
every run by asking pdf.js, not by trusting the filename: a fixture that
quietly gained a text layer would turn the whole file into a test of the case
that never needed an image.

### The timing (a number, not an impression)

| measurement | value |
|---|---|
| cold import of `pdfjs-dist/legacy/build/pdf.mjs` + `@napi-rs/canvas` | **108 ms**, once per process (memoised) |
| `getDocument` + parse, 3-page 44 KB scan | **93 ms** |
| render, scale 2.0 → JPEG q0.8, per page | **~200 ms** |
| throughput, whole call including encode | **3.1 – 5.1 pages/s** |
| output, per page (1224×1584) | **230 – 232 KB** JPEG (≈310 KB base64) |
| peak RSS during a 3-page render | **174 – 193 MB** |
| render at scale 1.0 / 1.5, for comparison | 5.18 / 4.40 pages/s |

Ink coverage of the decoded output is **16 – 18%** of pixels below luminance
200, and the three pages' images are byte-distinct from one another. That is
the fidelity check that matters: a blank page and a rendered page are both
valid JPEGs of respectable size, so the test decodes each image and measures
it rather than asserting that a string came back.

**What that means at a realistic size.** A 100-page scanned lease is roughly
**20–30 seconds** of render and about **31 MB** of base64 — which is already
larger than `API_MAX_BODY_BYTES` (16 MiB) and far larger than any single
model's image budget. That is not a render problem, it is a Task 9/10
batching problem, and it is worth knowing now: the constraint on server-side
scan review is the **wire and the model**, not the renderer.

---

## The caveats

**1. `pdfjs-dist/legacy/build/pdf.mjs` is the only import specifier that
works.** `import('pdfjs-dist')` and `pdfjs-dist/build/pdf.mjs` both throw
`DOMMatrix is not defined` under Node 22 — the modern build assumes a
browser's geometry globals — and pdf.js prints "Please use the `legacy` build
in Node.js environments" on the way past. Costs nothing; it just has to be
written down, because the browser side (`src/lib/documents.ts`) imports the
bare specifier and the two are not interchangeable.

**2. The rendered image must be JPEG at scale 2.0, quality 0.8 — the
browser's three numbers, not new ones.** The task brief specified base64 PNG,
and this is a deliberate departure (see "brief bugs" below). These three
constants decide what a model actually sees of a scanned page; picking
different ones server-side would mean the same document reviewed in the
browser and reviewed on the server got different pictures and could reach
different findings, with nothing on either card saying why. `@napi-rs/canvas`
implements `toDataURL('image/jpeg', 0.8)` with the browser's own 0–1 quality
semantics, so the two paths agree by construction. PNG is also 20 – 45% larger
here for the same page, on a path that is already over the body limit at 100
pages.

Neither caveat changes what the app can claim about scanned documents.

---

## Dependencies and the image

**No Dockerfile change was needed.** `apps/api/Dockerfile` already runs
`npm ci --omit=dev --workspace @lexprompt/api --include-workspace-root`, so
the root's `pdfjs-dist` and its optional `@napi-rs/canvas` were already in the
image — the musl binding included. That is the sort of accident that works
until someone tidies the root's dependency list, so both are now declared
directly in `apps/api/package.json` (`pdfjs-dist ^6.2.108`,
`@napi-rs/canvas ^1.0.8`) rather than inherited. The lockfile records
`@napi-rs/canvas` as no longer optional and nothing else moved.

**Config.** `API_PAGE_RENDER_TIMEOUT_MS` (default 120,000) and
`API_PAGE_IMAGE_MAX_PAGES` (default 100) are added to `apps/api/src/config.ts`
and registered in `apps/api/test/divergence.json` as
`defaultedInBothEnvironments`. §15's third key, **`API_PAGE_IMAGE_LRU_BYTES`,
was deliberately not added**: there is no cache for it to size yet, and a
configuration key that changes nothing is a knob an operator turns and then
trusts. It belongs in Task 9, with the cache it bounds.

---

## What the kept code refuses to do

- **It never persists an image.** No blob store, no pool, no cache — bytes in,
  base64 out. A source scan (comments stripped first, via `codeOf`) asserts
  that and is mutation-tested.
- **It does not decide which pages are scans.** `SCAN_TEXT_THRESHOLD` is
  applied per page in exactly one place; a second copy here is the blind spot
  CLAUDE.md records having had to fix three times. The caller — which has
  already extracted the per-page text — names the pages through an optional
  `pages` argument. (This is the one piece of surface beyond the brief's
  signature, and it exists so Task 9 has no reason to re-derive the rule.)
- **It throws rather than returning half a scan.** A render that exceeds its
  budget raises `PageRenderTimeoutError`; it never returns the pages it
  managed. A partly-rendered scan handed to a model produces a fluent answer
  about the half it could read and "silent on this point" about the half it
  could not — this project's founding defect wearing a successful return
  value. A page **cap** is different and is reported softly, as
  `renderedPages < totalPages`, for the caller to surface as truncation.
- **It does not detach its caller's buffer** (see below).

---

## Bugs found while executing the brief

Four, all real, all caught by running rather than by reading:

1. **`docker compose --env-file /tmp/compose.env exec` does not work from a
   test.** Node's `execFileSync` hands the POSIX path to `docker.exe`
   unconverted and Docker Desktop resolves it as `C:\tmp\compose.env`:
   *"couldn't find env file"*, every call. The other four `*.compose.test.ts`
   files use bare `docker compose exec` and are right to — `exec` attaches to
   an already-running container, so the blank `${OIDC_*}` interpolations reach
   no image and no process. `--env-file` remains mandatory for anything that
   **builds**, and this file says so where the next reader will look.

2. **A constructor parameter property crashes the api at import.**
   `constructor(public readonly renderedPages: number, …)` is valid
   TypeScript and `npx tsc` had nothing to say about it, but `apps/api` runs
   under `node --experimental-strip-types`, which is strip-only:
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, at import time, in the container.
   Plain fields assigned in the body instead.

3. **`destroy()` is on the loading task, not the document proxy, in pdf.js
   v6.** `PDFDocumentProxy` has `cleanup()` and no `destroy` at all, so
   `doc.destroy()` threw at the end of a render that had otherwise just
   succeeded. The task is kept and destroyed.

4. **pdf.js *transfers* the `Uint8Array` it is handed, detaching the
   caller's.** Passing `bytes` straight to `getDocument` leaves the caller
   holding a zero-length array, and a second `getDocument` over the same array
   dies with `DataCloneError: Cannot transfer object of unsupported type`.
   The caller here is a parse worker that has just read the same document's
   text out of the same bytes — that second read is the normal case, not an
   unusual one, and a document whose bytes silently became empty between two
   reads is the founding defect with no error attached. `renderPageImages`
   copies. There is a named test for it.

A fifth, found by the typechecker rather than at runtime: **`isEvalSupported:
false` is not a pdf.js v6 option.** It was in the first draft with a comment
claiming it kept a hostile PDF away from an evaluator. v6 removed the
mechanism entirely — the field is gone from `DocumentInitParameters` and there
is not one `new Function(` left in `pdf.worker.mjs` — so the option was a
no-op and the comment was a confident false claim about a protection that was
not happening. Both removed, with a note saying why.

---

## Mutation tests

Each mutation was applied, the suite run, the named test confirmed failing,
and the file restored (verified byte-identical afterwards).

| mutation | test that failed |
|---|---|
| never call `page.render` (blank canvas → still a valid JPEG) | `the images contain the scanned page, not a blank one` |
| pass the caller's `Uint8Array` through instead of copying | `leaves the caller holding its document, not a detached buffer` |
| `break` out of the loop on timeout instead of throwing | `throws on a render budget it cannot meet, rather than returning half a scan` |
| drop `.slice(0, opts.maxPages)` | `reports a page cap as a shortfall instead of absorbing it` |
| add a `blobStore.put(...)` of a rendered image | `writes no image anywhere — not to Postgres, not to the blob store` |

The first is the one worth reading twice: under it, *"renders every page of
the scanned PDF to a base64 image"* and *"the images are real JPEGs"* both
still **passed**. Asserting that strings came back, or that they decode to a
valid image, does not distinguish a rendered page from a blank one.

---

## The fixture generator

Run from the repository root; writes the committed fixture.

```js
// makeScan.mjs — three pages, one grayscale image XObject each, zero text
// operators, seeded so it is byte-identical on re-generation.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 850, H = 1100, PAGES = 3;
let seed = 20260830;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function pageBitmap(pageNo) {
  const px = Buffer.alloc(W * H, 0xf4);           // off-white scanner ground
  const line = (y, x0, x1, h) => {
    for (let yy = y; yy < y + h && yy < H; yy++)
      for (let xx = x0; xx < x1 && xx < W; xx++) px[yy * W + xx] = 0x20;
  };
  line(90, 90, 90 + 260 + pageNo * 30, 14);       // a heading
  let y = 150;
  for (let i = 0; i < 34; i++) {                  // lines of "words"
    let x = 90;
    while (x < W - 140) {
      const wLen = 24 + Math.floor(rnd() * 70);
      line(y, x, x + wLen, 8);
      x += wLen + 10 + Math.floor(rnd() * 8);
    }
    y += 24;
  }
  for (let i = 0; i < W * H * 0.04; i++) {        // scanner speckle
    const p = Math.floor(rnd() * W * H);
    px[p] = Math.max(0, px[p] - Math.floor(rnd() * 140));
  }
  return px;
}

const objs = [];
const put = (body) => { objs.push(body); return objs.length; };
const catalogId = put(null), pagesId = put(null);
const pageIds = [], imgIds = [], contentIds = [];
for (let p = 0; p < PAGES; p++) {
  const img = deflateSync(pageBitmap(p + 1), { level: 9 });
  imgIds.push(put(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray `
      + `/BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`),
    img, Buffer.from('\nendstream'),
  ])));
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q');
  contentIds.push(put(Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream'),
  ])));
  pageIds.push(put(null));
}
objs[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
objs[pagesId - 1] = Buffer.from(
  `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${PAGES} >>`);
pageIds.forEach((id, p) => {
  objs[id - 1] = Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
    + `/Resources << /XObject << /Im0 ${imgIds[p]} 0 R >> >> /Contents ${contentIds[p]} 0 R >>`);
});

const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
let offset = parts[0].length;
const offsets = [];
objs.forEach((body, i) => {
  const head = Buffer.from(`${i + 1} 0 obj\n`), tail = Buffer.from('\nendobj\n');
  offsets.push(offset);
  parts.push(head, body, tail);
  offset += head.length + body.length + tail.length;
});
let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\n`
  + `startxref\n${offset}\n%%EOF\n`;
parts.push(Buffer.from(xref));

writeFileSync('apps/api/test/fixtures/scanned-lease.pdf', Buffer.concat(parts));
```

---

## Gates at the time of writing

`npm run typecheck` exit 0, 4 projects. `npx vitest run` exit 0, 199 files /
2724 tests, no unhandled errors. `npm run test:pg` 16 files / 220 tests.
`npm run test:compose` 5 files / 23 tests (was 4 / 14). `npm run build` clean.
