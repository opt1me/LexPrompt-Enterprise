import { describe, it, expect } from 'vitest';

/**
 * THE WEB TIER MUST SERVE EVERY ASSET IN THE BUILD AS SOMETHING A BROWSER
 * WILL EXECUTE.
 *
 * A 200 is not enough, and that is the whole reason this file exists. nginx
 * 1.27's stock `mime.types` has no `mjs` entry, so `assets/pdf.worker-*.mjs`
 * — `pdf.js`'s worker, loaded by dynamic import — was served 200 as
 * `application/octet-stream`, and every browser refused to execute it. The
 * document viewer then failed on every PDF with
 *
 *   Could not open PDF: Setting up fake worker failed:
 *   "Failed to fetch dynamically imported module: .../pdf.worker-*.mjs"
 *
 * which reads as a missing file for an asset that is present. No citation
 * could be checked against its source in any containerised deployment.
 *
 * Nothing else caught it: `npm run build` is green, Vite's dev server sets
 * the type itself, and no unit test fetches an asset over HTTP. It surfaced
 * by driving the compose stack in a browser. Asserting the CONTENT TYPE, not
 * the status, is the difference between this test and one that would have
 * passed the whole time it was broken.
 */

const WEB_BASE = 'http://localhost:3005';

/** A JavaScript MIME type, per the HTML spec's module-script check. Anything
 *  else — `application/octet-stream`, `text/plain` — is refused by the
 *  browser AFTER a successful fetch. */
const JS_TYPES = /^(text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript)\b/;

async function assets(): Promise<string[]> {
  const index = await fetch(`${WEB_BASE}/`);
  expect(index.status, 'the SPA index must be served').toBe(200);
  const html = await index.text();
  // Every asset the entry document references directly. The `.mjs` chunks are
  // reached by dynamic import from inside the bundle, so they are collected
  // from the asset listing below rather than from here.
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(refs.length, 'the index must reference at least one built asset').toBeGreaterThan(0);
  return refs;
}

describe('the web tier serves built assets with executable MIME types', () => {
  it('serves every script the index references as JavaScript', async () => {
    for (const ref of await assets()) {
      if (!/\.m?js$/.test(ref)) continue;
      const res = await fetch(`${WEB_BASE}${ref}`);
      expect(res.status, `${ref} must be served`).toBe(200);
      expect(res.headers.get('content-type') ?? '', `${ref} must be executable`)
        .toMatch(JS_TYPES);
    }
  }, 30_000);

  it("serves pdf.js's worker as JavaScript, not as bytes", async () => {
    // Named specifically because it is the one that broke, and reached the
    // way a BROWSER reaches it: by following chunk references out of the
    // entry document. The worker is not named in the index's markup and not
    // named in the entry chunk either — it sits two hops in, behind the
    // route-level split — which is exactly why a smoke test of the entry
    // document missed it entirely. The hashed filenames are discovered, never
    // pinned, so a rebuild does not turn this into a false failure.
    const seen = new Set<string>();
    const queue = (await assets()).filter((r) => /\.m?js$/.test(r));
    let worker: string | undefined;

    while (queue.length > 0 && worker === undefined) {
      const ref = queue.shift()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const res = await fetch(`${WEB_BASE}${ref}`);
      expect(res.status, `${ref} must be served`).toBe(200);
      // Asserted on EVERY chunk walked, not only on the worker: the bug was
      // a MIME type, and any chunk carrying the wrong one is refused by the
      // browser the same way.
      expect(res.headers.get('content-type') ?? '', `${ref} must be executable`)
        .toMatch(JS_TYPES);
      const body = await res.text();
      const found = body.match(/[\w.-]*pdf\.worker[\w.-]*\.mjs/)?.[0];
      if (found) { worker = `/assets/${found.split('/').pop()}`; break; }
      // Chunks reference their siblings RELATIVE to the assets directory
      // (`"./App-<hash>.js"`), so the `assets/` prefix is optional here and
      // the basename is what gets normalised back into a path.
      for (const next of body.matchAll(/["'`](?:\.\/|\/)?(?:assets\/)?([\w.-]+\.m?js)["'`]/g)) {
        queue.push(`/assets/${next[1]}`);
      }
    }

    expect(worker, "the built app must reference pdf.js's worker").toBeDefined();
    const res = await fetch(`${WEB_BASE}${worker}`);
    expect(res.status, `${worker} must be served`).toBe(200);
    // THE ASSERTION. Before the `types` block in `infra/nginx/web.conf` this
    // was `application/octet-stream`: a 200 the browser fetched and then
    // refused to execute.
    expect(res.headers.get('content-type') ?? '', `${worker} must be executable`)
      .toMatch(JS_TYPES);
  }, 60_000);
});
