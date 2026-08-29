import {
  ModelError, isPurpose, isRetryableStatus, truncationRefusal,
  type InferRequest, type InferResponse, SERVICE_CONFIG_HINT } from '@lexprompt/core';
import type { GatewayConfig, ModelEntry } from './config.ts';
import type { Allowlist } from './allowlist.ts';
import type { AuditLogger } from './audit.ts';
import type { CredentialResolver, ResolvedCredential } from './credentials/types.ts';
import { redactCredential } from './credentials/resolve.ts';
import type { buildRegistry } from './adapters/registry.ts';
import type { AdapterCall, ProviderAdapter } from './adapters/types.ts';
import type { RateLimiter } from './rateLimit.ts';

const MAX_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Both names a cancelled request arrives under. `AbortSignal.timeout` aborts
 * with a `TimeoutError`, a caller's own controller with an `AbortError`, and
 * `undici` may surface either — so the NAME is used only to recognise "this
 * did not fail, it was stopped", and WHICH signal stopped it is read off the
 * signals themselves below. Getting that backwards is how a deliberate
 * cancellation gets retried three times while the UI looks busy.
 */
const isAbort = (e: unknown): boolean => {
  const name = (e as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
};

export interface TransportResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

export interface Transport {
  fetch(url: string, init: {
    method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
  }): Promise<TransportResponse>;
}

export interface CallContext {
  config: GatewayConfig;
  allowlist: Allowlist;
  audit: AuditLogger;
  credentials: CredentialResolver;
  transport: Transport;
  limiter: RateLimiter;
  /** Built once in `main.ts` from the loaded config, so an adapter needing
   *  configuration takes it as a constructor argument rather than reading
   *  it (S25, Task 8 Step 7). */
  registry: ReturnType<typeof buildRegistry>;
  workspaceId: string;
  actorIssuer: string;
  actorSubject: string;
  /** ALONGSIDE `actorIssuer`/`actorSubject`, never in place of them — see
   *  `AuditStart.actorUserId` (§6.5). Absent for a Stage 1 caller during a
   *  rolling deploy; `apps/api` always sets it from Stage 2 onward. */
  actorUserId?: string;
  /** The backoff, injectable for the same reason `AuditLogger` takes its
   *  clock: a test asserting how many attempts a 500 earns should not also
   *  wait three real seconds to find out. Production leaves it unset. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PreparedCall {
  entry: ModelEntry;
  adapter: ProviderAdapter;
  call: AdapterCall;
  credential: ResolvedCredential;
  callId: string;
  startedAt: number;
}

/**
 * Closes the pair a started record opens.
 *
 * Everything after `audit.start` runs inside a `try` that ends here, because
 * a `call.started` with no `call.finished` reads — correctly — as an egress
 * that began and may still be in flight. A refusal is not that. It is an
 * attempt that ended, and the log has to be able to say which.
 */
async function finishFailed(
  ctx: CallContext, callId: string, startedAt: number, error: ModelError, retries: number,
): Promise<void> {
  await ctx.audit.finish(callId, {
    status: error.status,
    ok: false,
    errorCode: error.code,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: Date.now() - startedAt,
    retries,
  });
}

/** Anything that is not already a `ModelError`, made into one — with the
 *  credential scrubbed, because the thrower had it in hand. */
function asModelError(
  err: unknown, credential: ResolvedCredential, callId: string,
): ModelError {
  if (err instanceof ModelError) return err;
  const message = (err as Error)?.message ?? 'Unknown failure';
  return new ModelError(redactCredential(message, credential), 'unknown', 500, callId);
}

/**
 * Everything a call needs, resolved and checked, before anything is sent.
 * Shared by `callModel` and the stream route, so the checks cannot differ
 * between a streamed and a non-streamed call.
 */
export async function prepare(
  ctx: CallContext, req: InferRequest, streaming: boolean,
): Promise<PreparedCall> {
  // An egress nobody can be attributed to is the one thing the audit record
  // exists to make impossible, and an empty string satisfies every type in
  // this file while making `actorSubject: ''` the answer to "who asked". The
  // gateway does not validate the caller's token — Task 15 authenticates the
  // caller, Task 17 fills these from it — but it does refuse to log a call
  // to nobody. A missing one is a bug in the caller, and one that would
  // otherwise be invisible until someone read the log looking for a name.
  if (!ctx.workspaceId || !ctx.actorSubject || !ctx.actorIssuer) {
    throw new ModelError(
      'This request did not say which workspace or which person it was for, so it '
      + 'could not be recorded against either and was not made.',
      'unknown', 400,
    );
  }

  if (!isPurpose(req.purpose)) {
    throw new ModelError(
      `The purpose ${JSON.stringify(req.purpose)} is not one this gateway serves.`,
      'purpose_not_allowed', 400,
    );
  }
  const entry = ctx.allowlist.resolve(req.modelChoiceId);

  // Checked rather than assumed: a body with no `user` would otherwise reach
  // `.length` below and become a TypeError wearing a 500 — a failure that
  // reads as "the gateway is broken" for what is a malformed request, and
  // whose message ("Cannot read properties of undefined") names nothing the
  // caller can act on.
  if (typeof req.user !== 'string' || req.user.trim() === '') {
    throw new ModelError(
      'This request carried no prompt text. LexPrompt will not ask a model to answer '
      + 'an empty question — the answer would look like a finding and mean nothing.',
      'unknown', 400,
    );
  }
  if (req.system !== undefined && typeof req.system !== 'string') {
    throw new ModelError(
      'This request carried a system prompt that is not text.', 'unknown', 400,
    );
  }

  // TEXT only, deliberately. `req.images` is not counted here and is not
  // meant to be: a scanned lease is several MB of base64 by construction,
  // and folding that into a limit sized for prose would refuse exactly the
  // reviews this gateway exists to serve. Images are bounded instead by
  // Fastify's `bodyLimit` (`server.ts`), which refuses with a 413 — loudly,
  // before anything is sent — so the ceiling is real, it is simply a
  // different one. `imageCount` is on every audit record either way.
  const promptChars = (req.system ? req.system.length + 2 : 0) + req.user.length;
  if (promptChars > ctx.config.maxPromptChars) {
    throw new ModelError(
      `This request is ${promptChars} characters, over this gateway's limit of `
      + `${ctx.config.maxPromptChars}. Review fewer documents at once, or ask an `
      + 'administrator to raise the limit.',
      'prompt_too_large', 413,
    );
  }

  ctx.limiter.check(ctx.workspaceId, ctx.actorSubject);
  // Counted HERE, on every attempt that clears the check, and not in the
  // success branch — which is where the request budget used to be counted,
  // by way of `record`. `check` read `record`'s events, `record` ran only
  // after a call succeeded, so `requestsPerMinutePer*` were limits on
  // SUCCESSES: under exactly the conditions a request throttle exists for
  // (a provider returning 500s, a retry storm, a client loop) the budget
  // read as entirely unspent while each failing call cost three upstream
  // attempts. The token budget is still counted on success only, and that
  // half is right — don't bill a caller for an answer they never got.
  ctx.limiter.recordAttempt(ctx.workspaceId, ctx.actorSubject);

  // Order matters and is load-bearing: the credential is resolved BEFORE
  // the audit record is written, so a credential failure never produces a
  // started record with no call; and the audit record is written before the
  // socket opens (P3), so a call never happens unlogged.
  const credential = await ctx.credentials.resolve(entry.credential);

  const callId = await ctx.audit.start({
    purpose: req.purpose,
    entry,
    workspaceId: ctx.workspaceId,
    actorIssuer: ctx.actorIssuer,
    actorSubject: ctx.actorSubject,
    ...(ctx.actorUserId ? { actorUserId: ctx.actorUserId } : {}),
    context: req.context ?? {},
    ...(req.system ? { system: req.system } : {}),
    user: req.user,
    imageCount: req.images?.length ?? 0,
    streaming,
  });
  const startedAt = Date.now();

  try {
    // ----------------------------------------------------------------
    // S27's per-call half. The startup gate (Task 4) makes an out-of-set
    // entry unloadable; this makes the refusal a RUNTIME fact with a
    // subject, which is what §18.2's "without the request reaching the
    // provider" is about and what §14's mutation (c) is written against.
    // Without it that DoD line is vacuously true — no loadable entry could
    // ever violate it — and a "cannot fail" assertion is how the startup
    // gate gets relaxed later with nothing going red.
    //
    // AFTER `audit.start`, deliberately: a refused call is still an
    // attempt, and the record of it is the thing a Risk reviewer asks for.
    // BEFORE `buildCall`, so nothing is shaped and nothing is sent.
    // ----------------------------------------------------------------
    if (!ctx.config.allowedJurisdictions.includes(entry.jurisdiction.bloc)) {
      throw new ModelError(
        `This model (${entry.provider}, ${entry.model}) is processed in `
        + `${entry.jurisdiction.bloc} · ${entry.jurisdiction.label}, which this deployment `
        + `does not permit (${ctx.config.allowedJurisdictions.join(', ')}). No request was sent.`,
        'jurisdiction_not_allowed',
        403,
        callId,
      );
    }

    const adapter = ctx.registry.get(entry.provider);
    const call = adapter.buildCall({
      entry,
      // Threaded through so the `recorded` adapter (Task 13) can route to
      // the fixture matching this call site; every other adapter ignores
      // it. `req.purpose` is already validated by `isPurpose` above.
      purpose: req.purpose,
      ...(req.system ? { system: req.system } : {}),
      user: req.user,
      ...(req.images ? { images: req.images } : {}),
      ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      maxTokens: req.maxTokens ?? ctx.config.defaultMaxTokens,
      stream: streaming,
    }, credential);

    return { entry, adapter, call, credential, callId, startedAt };
  } catch (err) {
    const modelError = asModelError(err, credential, callId);
    await finishFailed(ctx, callId, startedAt, modelError, 0);
    throw modelError;
  }
}

/**
 * A provider's status and (already redacted) message, classified.
 *
 * THE status -> code ladder, in one place, reachable synchronously. It was
 * inlined in `toModelError` and therefore reachable only from a path that
 * had a whole `TransportResponse` to read — which the STREAM route, whose
 * provider failure arrives as a decoded mid-stream event long after the
 * response object is done with, does not. That route hardcoded
 * `code: 'upstream_failed'` instead, so an Anthropic `authentication_error`
 * mid-stream reached a lawyer as a generic, retryable "the AI provider
 * failed" — for a rejected firm credential that no retry can ever fix,
 * while the identical failure on `/v1/infer` correctly said an
 * administrator has to fix it. Sibling drift with the wire in the middle.
 *
 * `message` MUST arrive redacted. This function composes it into outward
 * text; it is not the place a credential gets scrubbed, and both callers
 * scrub before calling.
 */
export function modelErrorFor(status: number, message: string, callId: string): ModelError {
  // A provider rejecting OUR credential is the firm's configuration
  // problem, not the user's sign-in — the distinction openrouter.ts's
  // isAuthError could not make, because the key was the user's.
  if (status === 401 || status === 403 || status === 402) {
    return new ModelError(
      `The AI provider rejected LexPrompt's credentials (${message}). This is a `
      + `configuration problem in the firm's deployment, ${SERVICE_CONFIG_HINT}.`,
      'service_misconfigured', 503, callId,
    );
  }
  if (status === 429) {
    return new ModelError(`The AI provider is rate-limiting this workspace (${message}).`,
      'rate_limited', 429, callId);
  }
  if (status >= 500) {
    return new ModelError(`The AI provider failed (${message}).`, 'upstream_failed', 502, callId);
  }
  return new ModelError(message, 'unknown', status, callId);
}

/** Turns a provider's failure response into a ModelError, with the
 *  credential scrubbed out of whatever the provider chose to echo back.
 *  Exported so the stream route (Task 12) can classify a pre-stream failure
 *  identically to the non-streamed path, rather than reimplementing it. */
export async function toModelError(
  response: TransportResponse,
  credential: ResolvedCredential,
  callId: string,
): Promise<ModelError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body?.error?.message) message = body.error.message;
  } catch { /* keep the status */ }
  return modelErrorFor(response.status, redactCredential(message, credential), callId);
}

export async function callModel(
  ctx: CallContext,
  req: InferRequest,
  signal?: AbortSignal,
): Promise<InferResponse> {
  const { entry, adapter, call, credential, callId, startedAt } = await prepare(ctx, req, false);
  const sleep = ctx.sleep ?? defaultSleep;
  let retries = 0;
  let lastError: ModelError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(ctx.config.requestTimeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: TransportResponse;
    try {
      response = await ctx.transport.fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: composite,
      });
    } catch (err) {
      // A stop is never a retry. A cancellation is a deliberate decision —
      // openrouter.ts learned that the expensive way, where an abort was
      // retried three times over ~3s while the UI looked busy — and a
      // timeout has already spent the configured budget once, so spending
      // it twice more turns a slow provider into a three-times-slower
      // failure.
      if (isAbort(err)) {
        if (timeout.aborted && !signal?.aborted) {
          const timedOut = new ModelError(
            `The AI provider did not respond within ${ctx.config.requestTimeoutMs}ms. `
            + 'Nothing was returned; the request may or may not have been processed.',
            'upstream_failed', 504, callId,
          );
          await finishFailed(ctx, callId, startedAt, timedOut, retries);
          throw timedOut;
        }
        // The caller's own cancellation, propagated unwrapped so it is
        // recognisable as one rather than reported as a provider failure.
        await ctx.audit.finish(callId, {
          status: 0, ok: false, errorCode: 'unknown',
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - startedAt, retries,
        });
        throw err;
      }
      lastError = new ModelError(
        `Could not reach the AI provider: ${redactCredential((err as Error).message, credential)}`,
        'network', 0, callId,
      );
      if (attempt < MAX_ATTEMPTS - 1) { retries++; await sleep(1000 * 2 ** attempt); }
      continue;
    }

    if (response.ok) {
      const body = await response.json();
      let read: ReturnType<ProviderAdapter['readResponse']>;
      try {
        read = adapter.readResponse(body);
      } catch (err) {
        // A 200 the adapter cannot read is a failed call wearing a success,
        // and it is recorded as a failure. Not retried: the provider
        // answered, and asking again for the same malformed answer spends
        // the caller's time to learn the same thing.
        const unreadable = new ModelError(
          redactCredential((err as Error).message, credential), 'upstream_failed', 502, callId,
        );
        await ctx.audit.finish(callId, {
          status: response.status, ok: false, errorCode: 'upstream_failed',
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - startedAt, retries,
        });
        throw unreadable;
      }
      // C1. A completion the provider cut off at the token ceiling is a
      // failed call wearing a 200, exactly as a 200 with no message content
      // is — and it is refused HERE rather than returned with a flag,
      // because a flag is only as good as every consumer remembering to
      // read it. The decision itself lives in `truncationRefusal`
      // (packages/core) so the stream route and the browser's own
      // `readFrames` reach the same one rather than each carrying a copy.
      // Not retried: an identical request meets the identical ceiling.
      const truncated = truncationRefusal(read.stopReason, callId);
      if (truncated) {
        await ctx.audit.finish(callId, {
          status: response.status, ok: false, errorCode: 'answer_truncated',
          // The real counts, not zeroes: these tokens were genuinely spent,
          // and a support engineer asking "what did this cost" should get
          // the truth from the record even though the answer was refused.
          promptTokens: read.usage.promptTokens,
          completionTokens: read.usage.completionTokens,
          latencyMs: Date.now() - startedAt, retries,
        });
        throw truncated;
      }
      await ctx.audit.finish(callId, {
        status: response.status, ok: true,
        promptTokens: read.usage.promptTokens,
        completionTokens: read.usage.completionTokens,
        latencyMs: Date.now() - startedAt, retries,
      });
      ctx.limiter.record(ctx.workspaceId, ctx.actorSubject, read.usage);
      return {
        content: read.content,
        usage: read.usage,
        callId,
        provider: entry.provider,
        jurisdiction: entry.jurisdiction,
        stopReason: read.stopReason,
      };
    }

    const modelError = await toModelError(response, credential, callId);
    // §10: retry 429 and 5xx only; fail fast on 400/401/402/403. Read off
    // the PROVIDER's status, not the status this gateway will report — an
    // upstream 401 becomes a 503 outwards, and retrying on that would
    // retry every rejected credential three times.
    if (!isRetryableStatus(response.status)) {
      await finishFailed(ctx, callId, startedAt, modelError, retries);
      throw modelError;
    }
    lastError = modelError;
    if (attempt < MAX_ATTEMPTS - 1) { retries++; await sleep(1000 * 2 ** attempt); }
  }

  const final = lastError ?? new ModelError(
    'The AI provider could not be reached.', 'upstream_failed', 502, callId,
  );
  await finishFailed(ctx, callId, startedAt, final, retries);
  throw final;
}
