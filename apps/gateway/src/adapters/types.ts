import type { InferUsage, ProviderId, Purpose, StopReason } from '@lexprompt/core';
import type { ModelEntry } from '../config.ts';
import type { ResolvedCredential } from '../credentials/types.ts';

export interface AdapterRequest {
  entry: ModelEntry;
  /**
   * What the call is for, in the app's own terms (§10's purpose allowlist).
   * Every OpenAI-shaped adapter ignores this — it exists so an adapter that
   * DOES need it (today, only `recorded`, Task 13, to route to the fixture
   * that matches the call site) can see it without every other adapter
   * having to. `callModel.ts`'s `prepare()` is the only place this is filled
   * in, from the already-validated `InferRequest.purpose`.
   */
  purpose?: Purpose;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
  maxTokens: number;
  stream: boolean;
}

/**
 * One decoded provider stream event. `end` means the provider said the
 * stream is complete — the gateway emits its `done` frame only after seeing
 * one, which is P2's rule at the upstream edge.
 *
 * `stop` is the reason the MODEL stopped, normalised (`StopReason`). It is
 * a separate event from `end` because both providers deliver the two facts
 * separately: an OpenAI-shaped stream carries `finish_reason` on a chunk
 * and then a bare `data: [DONE]`; Anthropic carries `stop_reason` on
 * `message_delta` and then `message_stop`. A field on `end` could not hold
 * a value that arrives before it.
 */
export type AdapterEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'usage'; usage: InferUsage }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'end' }
  | { kind: 'error'; status: number; message: string };

export interface AdapterCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A provider backend, as three functions and NO NETWORK.
 *
 * `buildCall` describes a request rather than making one; `readResponse`
 * and `decodeEvent` are pure. The one place that opens a socket, retries,
 * times out and aborts is `callModel.ts` — which is what keeps §10's retry
 * policy enforced once rather than five times, and what makes every
 * adapter testable with no network at all (P5).
 *
 * It said "three PURE functions and no IO" and that was not quite true, in
 * a way worth stating rather than leaving for the next reader to discover:
 * `recorded.buildCall` reads the filesystem to check that the fixture it is
 * about to name exists. That probe is deliberate — it is what turns a
 * missing fixture into a loud refusal at build time instead of a confusing
 * failure inside `transport.ts` — and `adapterBoundary.test.ts` does not
 * forbid it, because what that test guards is an adapter reaching into
 * gateway-core concerns, not an adapter touching a file. The invariant that
 * actually matters is the one now stated: no adapter opens a socket, and
 * none of them decides retry, budget, jurisdiction or logging.
 *
 * Adding a sixth provider: write one of these, add it to `registry.ts`, add
 * a stream fixture. Nothing else in the codebase changes.
 *
 * DELIBERATELY NARROWER THAN S25's five concerns, and the narrowing is
 * recorded in Task 26 Step 5. Credential acquisition lives in
 * `credentials/resolve.ts` (which of four sources a key comes from is a
 * deployment property, not a wire-protocol one) and error classification
 * lives in `isRetryableStatus` in `packages/core`, applied once in
 * `callModel.ts` — §10's own instruction that the retry policy runs once.
 *
 * The residual risk, named so the remedy is not improvised: retryability is
 * currently read off the HTTP status alone, which is right for every
 * provider here and wrong for one that signals it in a response body. Such
 * a provider adds an optional
 *   `classifyError?(status: number, body: unknown): 'retry' | 'fail'`
 * to THIS interface and implements it; `callModel` consults it when
 * present. It never becomes an `if` on a provider id in the core.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall;
  readResponse(body: unknown): { content: string; usage: InferUsage; stopReason: StopReason };
  /**
   * ZERO OR MORE events per raw SSE event — not one, and not `null`.
   *
   * It returned `AdapterEvent | null` until a raw chunk had to be able to
   * carry two facts at once. OpenAI's shape permits
   * `{"delta":{"content":"…"},"finish_reason":"length"}`: the last token of
   * the answer AND the news that the answer was cut off, in one event. With
   * a single-event return, one of those two had to be dropped — dropping
   * the delta loses a token (the defect `sse.ts` was written against),
   * dropping the `finish_reason` loses the truncation (the defect
   * `truncationRefusal` was written against). An array drops neither.
   */
  decodeEvent(rawEvent: string): AdapterEvent[];
}
