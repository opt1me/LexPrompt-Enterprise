import { describe, it, expect } from 'vitest';
import { modelErrorFrom } from './inferEnvelope.ts';

/**
 * WHAT A READER IS TOLD WHEN NOTHING IN FRONT OF LEXPROMPT WROTE THEM A
 * SENTENCE.
 *
 * A refusal from `apps/api` always carries an `error.message` composed for a
 * reader — `infer.route.test.ts` already holds that line for this hop's own
 * envelope, after the browser was caught rendering the bare string
 * "HTTP 413" to a lawyer. This file is the residual case that fix did not
 * cover: a failure from something IN FRONT of the API, which writes no
 * envelope at all. An nginx 502, an ingress 503, a proxy's HTML error page.
 *
 * Observed live: with `api` stopped, verifying a finding produced the toast
 * "This verification was not saved: HTTP 502". The refusal was correct, the
 * badge correctly stayed unverified — and the only thing the reader was told
 * was a number.
 */

describe('modelErrorFrom, when the body carries no LexPrompt envelope', () => {
  it('never produces a message that is only a status number', () => {
    // The regression guard, stated as the property rather than as one case:
    // any of these bodies, at any of these statuses, must yield a sentence.
    for (const status of [400, 404, 408, 413, 429, 500, 502, 503, 504]) {
      for (const body of [undefined, null, '<html>502 Bad Gateway</html>', {}, { error: {} }]) {
        const message = modelErrorFrom(status, body).message;
        expect(message, `${status} / ${JSON.stringify(body)}`).not.toMatch(/^HTTP \d+$/);
        expect(message.length, `${status} / ${JSON.stringify(body)}`).toBeGreaterThan(30);
      }
    }
  });

  it('says the server is not answering, and that nothing is lost, for 502/503/504', () => {
    for (const status of [502, 503, 504]) {
      const message = modelErrorFrom(status, undefined).message;
      expect(message).toContain('not answering');
      // The promise that matters to somebody who has just been refused a
      // write: their earlier work is on the server, not in this tab. It is
      // the same sentence `makeApiClient`'s network branch makes, because it
      // is the same situation reached by a different route.
      expect(message).toContain('nothing is lost');
      // The number survives. Somebody debugging a deployment needs it; it is
      // simply no longer the whole message.
      expect(message).toContain(`HTTP ${status}`);
    }
  });

  it('does not claim a 4xx with no envelope has a reason it does not have', () => {
    const message = modelErrorFrom(400, undefined).message;
    expect(message).toContain('gave no reason');
    expect(message).toContain('HTTP 400');
  });

  it('still prefers the envelope\'s own message whenever there is one', () => {
    // The whole fallback is for bodies that say nothing. A real refusal's
    // wording is written for the reader and must never be replaced by a
    // generic sentence about the status it happened to arrive on.
    const written = 'This needs the partner role, and your LexPrompt role is reviewer.';
    const failure = modelErrorFrom(403, { error: { code: 'not_permitted', message: written } });
    expect(failure.message).toBe(written);
    expect(failure.code).toBe('not_permitted');
  });

  it('leaves the code alone — saying what happened is not guessing why', () => {
    // `codeFromStatus`'s own docstring settles this: a 502 from an ingress is
    // not evidence the firm's deployment is misconfigured, and the code is
    // what decides which panel a reader is shown. The message got better; the
    // classification deliberately did not move.
    expect(modelErrorFrom(502, undefined).code).toBe('unknown');
    expect(modelErrorFrom(401, undefined).code).toBe('sign_in_required');
    expect(modelErrorFrom(403, undefined).code).toBe('not_permitted');
  });
});
