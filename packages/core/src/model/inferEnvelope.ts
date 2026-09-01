import { ModelError, isModelErrorCode, type InferResponse, type ModelErrorCode } from './protocol.ts';

/**
 * Reading the gateway's envelope — the success shape and the failure shape —
 * as pure functions over an already-parsed body.
 *
 * ## Why this is here and not in either caller
 *
 * Two processes now call `/v1/infer`: the browser, through
 * `src/lib/model/gatewayModelClient.ts`, and `apps/api`, through
 * `apps/api/src/run/modelClient.ts` (Stage 3 §9, so a review can run
 * server-side). They speak to the same endpoint and get the same two
 * envelopes back, but they hold them in different containers — a `fetch`
 * `Response` in one, undici's `{ status, json }` pair in the other — and
 * that difference was very nearly enough to justify writing the parsing
 * twice.
 *
 * It is not enough. What must not diverge is not the transport, it is the
 * JUDGEMENT: which bodies count as an answer, and what a refusal means. Two
 * copies of that would be this project's most repeated defect in the form
 * where nobody can read them side by side — one in a browser bundle, one in
 * a Node service — and the failure would look like "the same model gives a
 * different answer depending on where the review ran".
 *
 * So the container-handling stays with each caller and everything after
 * `JSON.parse` lives here.
 */

/**
 * The code a refusal carries when its BODY did not name one.
 *
 * `apps/api` is not the only thing that can answer with a 401. A reverse
 * proxy, an ingress, Azure Easy Auth or an expired-token rejection can all
 * emit one with an HTML page or some other envelope entirely, and reading
 * the code only out of `body.error.code` left every one of those as
 * `code: 'unknown'` — which `isSignInError` does not see, so the sign-in
 * gate that branch exists to build never fired. The user got "HTTP 401" and
 * a Retry that could only fail again, forever.
 *
 * `openrouter.ts`'s `isAuthError` was `status === 401 || status === 403`,
 * and that half of it is restored here rather than left to the body: 401 is
 * "we do not know who you are" (signing in again is the repair) and 403 is
 * "we know, and no" (`not_permitted`, which does NOT redirect). Both are in
 * `SIGN_IN_CODES`, so both reach `isAuthFailure`.
 *
 * Nothing else is guessed. A 502 from an ingress is not evidence that the
 * firm's deployment is misconfigured, and mapping it to
 * `service_misconfigured` would put a specific wrong reason — and the wrong
 * panel — in front of a reader. Everything but 401/403 stays `unknown`,
 * which is exactly what it is.
 */
export function codeFromStatus(status: number): ModelErrorCode {
  if (status === 401) return 'sign_in_required';
  if (status === 403) return 'not_permitted';
  return 'unknown';
}

/**
 * A failure status plus whatever its body parsed to becomes the `ModelError`
 * the gateway meant.
 *
 * `body` is `unknown` and may be `undefined`: a refusal whose body could not
 * be read at all is still a refusal, and inventing a code for it would put a
 * specific wrong reason in front of a reader — but the STATUS is not
 * nothing, and `codeFromStatus` says what it is worth.
 *
 * `body.error.code` is checked against `MODEL_ERROR_CODES` rather than cast
 * into the union. An unrecognised code string used to land outside both
 * classifier sets by accident: `isSignInError` and `isServiceConfigError`
 * would both read false for a refusal that was plainly one or the other. A
 * code nothing recognises falls through to the status, exactly like a body
 * that could not be read at all.
 */
/**
 * WHAT TO SAY WHEN THE BODY SAYS NOTHING.
 *
 * A refusal from LexPrompt's own API always carries an `error.message`
 * written for a reader. A failure from something in FRONT of it does not: an
 * nginx 502, an ingress 503, a gateway timeout, a proxy's HTML error page.
 * The fallback used to be the bare string `HTTP ${status}`, and that is what
 * a lawyer actually saw — "This verification was not saved: HTTP 502",
 * observed in a browser with the API stopped. It is true, it is useless, and
 * it is the only sentence in this app written in a vocabulary the reader does
 * not share.
 *
 * The status is still carried on the `ModelError` and still shown in
 * parentheses, because it is the one hard fact available and somebody
 * debugging a deployment needs it. What changes is that it is no longer the
 * whole message.
 *
 * `codeFromStatus` is deliberately NOT widened alongside this. Its own
 * docstring settles that question — a 502 from an ingress is not evidence the
 * firm's deployment is misconfigured, and a code drives which PANEL a reader
 * is shown. Saying what happened and guessing why are different acts.
 */
function messageFromStatus(status: number): string {
  // 502/503/504 all mean the same thing to a reader: something in front of
  // LexPrompt answered instead of LexPrompt. Not a refusal — an interruption.
  // The second sentence is the one that matters, and it is the same promise
  // `makeApiClient`'s network branch makes, because it is the same situation
  // reached by a different route.
  if (status === 502 || status === 503 || status === 504) {
    return `LexPrompt's server is not answering (HTTP ${status}). Your work is on the server, `
      + 'not in this browser, so nothing is lost — but nothing can be read or saved until it '
      + 'is back.';
  }
  if (status === 408) {
    return `The request to LexPrompt's server timed out (HTTP ${status}). Nothing was saved. `
      + 'Try again.';
  }
  if (status === 429) {
    return `LexPrompt's server is refusing requests for the moment (HTTP ${status}). `
      + 'Wait a little and try again.';
  }
  if (status >= 500) {
    return `LexPrompt's server failed on this request (HTTP ${status}) and gave no reason. `
      + 'Nothing was saved.';
  }
  // A 4xx with no envelope is still a refusal, and saying so is more than the
  // number said on its own. What it does NOT do is invent a reason.
  return `LexPrompt's server refused this request (HTTP ${status}) and gave no reason.`;
}

export function modelErrorFrom(status: number, body: unknown): ModelError {
  const error = (body as { error?: { code?: unknown; message?: unknown; callId?: unknown } } | null)?.error;
  const code = isModelErrorCode(error?.code) ? error.code : undefined;
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : messageFromStatus(status);
  const callId = typeof error?.callId === 'string' ? error.callId : undefined;
  const failure = new ModelError(message, code ?? codeFromStatus(status), status, callId);
  // THE ROW THAT WON TRAVELS WITH THE REFUSAL.
  //
  // `ConflictError` has put `current` on the 409 envelope since Stage 3, as
  // a TOP-LEVEL key beside `error` (`registerErrorEnvelope`) — and until
  // Stage 4 nothing on this side read it, so every caller of a refused write
  // could say only that something had changed. Read here rather than in the
  // browser's `toModelError`, because `apps/api` reaches the same envelope
  // through undici and this is the one place the JUDGEMENT about a body
  // lives; a second reader is the drift this module's own docstring exists
  // to prevent.
  //
  // Assigned only when the key is PRESENT, so `current` stays absent rather
  // than becoming an undefined-valued key that `structuredClone` would
  // preserve and an `in` check would read as a row that is there.
  const current = (body as { current?: unknown } | null)?.current;
  if (current !== undefined) failure.current = current;
  return failure;
}

/**
 * A 2xx body that claims to be an `InferResponse`, checked rather than cast.
 *
 * A 200 is not a contract. Reading the body as an `InferResponse` is a cast,
 * so a body that parses as JSON but is not one — an intermediary's
 * interstitial, an ingress error page served as 200, a future `apps/api`
 * change — arrives with `content === undefined` and no complaint. In the
 * browser `draftEmail` then handed `setEmailContent(undefined)` to a modal
 * gated on `!== null`, and a lawyer got an empty client email with a working
 * Copy button: the blank-CSV-cell defect, in a new place. On the server the
 * same body would become a `Finding` whose `summary` is `undefined` — which
 * `extractClause`'s empty-summary guard would catch, but only because that
 * guard exists; nothing should be relying on a second net.
 *
 * This is deliberately NOT a restatement of `openrouter.ts`'s "returned no
 * message content" guard. That one was about a PROVIDER's reply, it has a
 * live successor in the gateway's `openaiCompatible.readResponse`, and a
 * second provider-shaped copy of it here is precisely the sibling drift this
 * project has paid for six times. This one checks the GATEWAY's own
 * envelope, on the side of the wire that consumes it.
 */
export function inferResponseFrom(body: unknown): InferResponse {
  const envelope = body as InferResponse | null;
  if (typeof envelope?.content !== 'string') {
    throw new ModelError(
      "LexPrompt's server answered without an answer in it. Nothing was returned that could "
      + 'be shown, so nothing is being shown. Try again, and tell your IT team if it repeats.',
      'upstream_failed', 502,
      typeof envelope?.callId === 'string' ? envelope.callId : undefined,
    );
  }
  return envelope;
}
