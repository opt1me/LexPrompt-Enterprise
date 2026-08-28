import type { InferUsage, ProviderId, Purpose } from '@lexprompt/core';
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

/** One decoded provider stream event. `end` means the provider said the
 *  stream is complete — the gateway emits its `done` frame only after
 *  seeing one, which is P2's rule at the upstream edge. */
export type AdapterEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'usage'; usage: InferUsage }
  | { kind: 'end' }
  | { kind: 'error'; status: number; message: string };

export interface AdapterCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A provider backend, as three PURE functions and no IO.
 *
 * `buildCall` describes a request rather than making one; `readResponse`
 * and `decodeEvent` are pure. The one place that opens a socket, retries,
 * times out and aborts is `callModel.ts` — which is what keeps §10's retry
 * policy enforced once rather than five times, and what makes every
 * adapter testable with no network at all (P5).
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
  readResponse(body: unknown): { content: string; usage: InferUsage };
  decodeEvent(rawEvent: string): AdapterEvent | null;
}
