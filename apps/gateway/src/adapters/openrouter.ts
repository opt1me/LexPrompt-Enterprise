import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

/**
 * OpenRouter returns as ONE configurable backend among five, rather than as
 * the app's only route to a model. Its two identifying headers are kept
 * from `openrouter.ts` because OpenRouter uses them for attribution; the
 * referer is the gateway's own configured origin, never a browser's, since
 * no browser is anywhere near this call.
 */
export function makeOpenrouterAdapter(publicOrigin: string) {
  return openAiCompatible({
    id: 'openrouter',
    url: entry => `${trimSlash(entry.endpoint)}/v1/chat/completions`,
    headers: (_entry, credential) => ({
      Authorization: `Bearer ${credential.kind === 'bearer' ? credential.token : credential.key}`,
      // `publicOrigin` is a CONSTRUCTOR ARGUMENT, not a `process.env` read.
      // An adapter that read deployment configuration would breach S25 and
      // be caught by `adapterBoundary` (Step 7) — and it would also put a
      // configuration key behind a silent default in a file no
      // configuration surface lists, which is the shape P4 spent a whole
      // revision removing.
      'HTTP-Referer': publicOrigin,
      'X-Title': 'LexPrompt',
    }),
  });
}
