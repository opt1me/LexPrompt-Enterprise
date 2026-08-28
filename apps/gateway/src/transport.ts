import { readFileSync } from 'node:fs';
import { request as undiciRequest } from 'undici';
import type { Transport, TransportResponse } from './callModel.ts';

/**
 * Splits `bytes` into three uneven chunks, so a local (recorded) stream
 * exercises the same chunk-boundary path a real network delivery would —
 * `adapterConformance`'s per-byte case aside, a whole-file `.txt` read
 * would otherwise mean the recorded provider is the one stream nothing ever
 * tests through the real route layer's chunk handling.
 */
function unevenChunks(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length < 3) return [bytes];
  const cut1 = Math.max(1, Math.floor(bytes.length * 0.31));
  const cut2 = Math.max(cut1 + 1, Math.floor(bytes.length * 0.68));
  return [bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)];
}

async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const chunk of unevenChunks(bytes)) yield chunk;
}

/**
 * Reads a fixture the `recorded` adapter's `buildCall` pointed at, rather
 * than opening a socket. `url` here is a filesystem path — never a network
 * location — produced only by `recorded.ts`'s `buildCall`.
 *
 * Two shapes, matching the two files `recorded.ts` can have chosen: a
 * `.json` fixture is one complete OpenAI-shaped envelope, read whole and
 * handed back as a normal (non-streamed) response body; a `.txt` fixture
 * under `streams/` is SSE text, delivered as three uneven byte chunks so
 * the streamed route's chunk-boundary handling is actually exercised
 * locally rather than only in `adapterConformance`'s synthetic fixtures.
 */
function readRecordedFixture(url: string): TransportResponse {
  if (url.endsWith('.txt')) {
    const raw = readFileSync(url, 'utf8');
    const bytes = new TextEncoder().encode(raw);
    return {
      status: 200,
      ok: true,
      json: async () => {
        throw new Error(
          `${url} is a recorded STREAM fixture (SSE text), not a JSON response body.`,
        );
      },
      text: async () => raw,
      body: chunksOf(bytes),
    };
  }
  const body = JSON.parse(readFileSync(url, 'utf8')) as unknown;
  return {
    status: 200,
    ok: true,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * The one real socket in this process, behind the one interface every other
 * module sees.
 *
 * It is a module of its own rather than a literal in `main.ts` because
 * `smoke.ts` needs the same one, and two hand-written `undici` wrappers is
 * precisely the sibling drift this project has paid for repeatedly — here it
 * would mean the live smoke run exercising a slightly different transport
 * from the one a deployment uses, which is the only thing that run is for.
 *
 * It contains no retry, no timeout and no logging. Those belong to
 * `callModel`, once, around every provider.
 *
 * The one branch below is on the URL's SCHEME, not on a provider id and not
 * on an environment variable — S30 forbids exactly the latter two. A
 * `file:`-shaped URL is produced only by the `recorded` adapter's
 * `buildCall`; every other adapter always builds an `https://` URL, so this
 * branch is unreachable for them and adds no second call path for anything
 * that actually calls a provider.
 */
export const undiciTransport: Transport = {
  async fetch(url, init): Promise<TransportResponse> {
    if (!/^https?:/i.test(url)) {
      return readRecordedFixture(url);
    }
    const res = await undiciRequest(url, {
      method: init.method as 'POST',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      json: () => res.body.json(),
      text: () => res.body.text(),
      body: res.body,
    };
  },
};
