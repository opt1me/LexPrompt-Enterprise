import path from 'node:path';
import { openAiCompatible } from './openaiCompatible.ts';
import type { AdapterCall, AdapterRequest, ProviderAdapter } from './types.ts';
import type { ResolvedCredential } from '../credentials/types.ts';

/**
 * The honest jurisdiction for the offline `recorded` provider — exported so
 * an operator's `models.json` and its documentation can quote it verbatim.
 * `config.ts`'s honesty check (a recorded entry must declare `bloc: 'other'`)
 * is what actually enforces this; this constant just names the one correct
 * value rather than leaving it to be retyped correctly by hand each time.
 */
export const RECORDED_JURISDICTION = {
  bloc: 'other' as const,
  region: 'local',
  label: 'this machine — recorded responses, not a model',
};

/**
 * The offline provider (§5.1). An ADAPTER, not a bypass.
 *
 * It was a transport chosen by an environment flag, which is a second code
 * path selected by a branch on the environment — precisely what §5.1 and
 * S30 forbid, and what would make a green local run evidence about a system
 * nobody deploys. It is now registered, selected by an operator writing it
 * into `models.json` like any other provider, and refused in a firm
 * deployment by the jurisdiction gate that already exists (S27) rather than
 * by a guard somebody had to remember to write.
 *
 * It reuses `openAiCompatible`'s response and event decoders verbatim, which
 * is not laziness: it is what makes the fixture path decode through the same
 * code the four OpenAI-shaped providers decode through, so `adapterConformance`
 * is testing something rather than agreeing with itself.
 *
 * This is the one component of the local stack that can produce a confident
 * wrong answer — fluent, plausible, and about no document anybody uploaded —
 * so it is marked in four places: the returned `provider`, the audit record,
 * an `X-LexPrompt-Provider` response header, and a non-dismissible banner in
 * the app (routes/infer.ts, routes/inferStream.ts, Task 22).
 *
 * `buildCall` never opens a socket. It returns a filesystem PATH as `url`;
 * `transport.ts`'s one real socket recognises a non-`http(s)` URL as a
 * fixture path (produced only from here) and reads the file instead of
 * dialling out — the branch is on the URL SCHEME the adapter itself chose,
 * never on a provider id or an environment variable, so it is not a second
 * call path in the sense S30 forbids.
 */
export function makeRecordedAdapter(
  dir: string,
  readFile: (p: string) => string,
): ProviderAdapter {
  // `url`/`headers` below are never actually invoked — only `readResponse`
  // and `decodeEvent` are reused from this base, and both are pure
  // functions of their argument, not of the id/url/headers this adapter was
  // built with. That reuse is the whole point: the fixture path decodes
  // through the exact same code the four OpenAI-shaped providers do.
  const base = openAiCompatible({
    id: 'recorded',
    url: () => dir,
    headers: () => ({}),
  });

  return {
    id: 'recorded',

    buildCall(req: AdapterRequest, _credential: ResolvedCredential): AdapterCall {
      // The credential is deliberately ignored and never enters the
      // headers: a recorded provider needs none, and a call that carried
      // one would put a real key on a path that never reaches a network.
      const purpose = req.purpose ?? 'default';
      // A streamed call reads from `streams/<purpose>.txt` (SSE-shaped, for
      // `transport.ts`'s chunked delivery); a non-streamed call reads
      // `<purpose>.json` (one OpenAI-shaped envelope). Two different file
      // shapes for the two different response shapes `readResponse` and
      // `decodeEvent` expect — routing a streamed call to a `.json` file
      // would hand the SSE reader a single JSON blob and fail silently.
      const ext = req.stream ? 'txt' : 'json';
      const segments = req.stream ? ['streams'] : [];
      const candidates = [`${purpose}.${ext}`, `default.${ext}`];
      const found = candidates.find((name) => {
        try {
          readFile(path.join(dir, ...segments, name));
          return true;
        } catch {
          return false;
        }
      });
      if (!found) {
        throw new Error(
          `No recorded fixture for purpose ${JSON.stringify(purpose)}`
          + `${req.stream ? ' (stream)' : ''} in ${dir}. `
          + 'A missing fixture is a failure, never an empty answer.',
        );
      }
      return {
        url: path.join(dir, ...segments, found).replace(/\\/g, '/'),
        headers: {},
        body: {},
      };
    },

    // Both reused verbatim from the OpenAI-shaped base, including its
    // refusal to return an empty answer when a fixture has no message
    // content (readResponse) and its OpenAI SSE decoding (decodeEvent).
    readResponse: base.readResponse,
    decodeEvent: base.decodeEvent,
  };
}

// NOTE: no module-level instance and no `process.env` read. `buildRegistry`
// (Task 8) constructs this from `config.recordedDir`, because an adapter
// that read its own configuration would breach S25 and be caught by
// `adapterBoundary` — and it would put a configuration key behind a silent
// default in a file no configuration surface lists, which is the shape P4
// spent a whole revision removing.
