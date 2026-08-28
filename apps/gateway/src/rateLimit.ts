import { ModelError, type InferUsage } from '@lexprompt/core';

/**
 * The seam `callModel` calls before it sends anything and after a call
 * succeeds. **Task 14 supplies the real implementation behind it.**
 *
 * It exists NOW, with its two call sites already in `callModel`, because
 * re-threading the one call path later is exactly the change this stage
 * should not have to make twice: a limiter added afterwards has to be
 * inserted between the credential, the audit record and the socket, and
 * getting that ordering right a second time is a second chance to get it
 * wrong.
 *
 * `check` THROWS to refuse — it does not return a boolean. A boolean is a
 * value a caller can forget to read, and a limiter whose refusal can be
 * ignored by omission is not a limit. It throws a `ModelError` with
 * `budget_exhausted` (a code `packages/core` already carries for it).
 *
 * Both methods are synchronous, deliberately: a limiter that counts is a
 * counter. If Task 14 needs IO it widens BOTH signatures to
 * `Promise<void>` and adds an `await` at each of the two call sites in
 * `callModel.ts` — a change that must be made in the open, not smuggled in
 * as an unawaited promise, which would let a refused call proceed anyway.
 */
export interface RateLimiter {
  /** Called before the credential is resolved and before anything is sent.
   *  Throws to refuse. */
  check(workspaceId: string, actorSubject: string): void;
  /** Called after a successful call, with what it actually cost. */
  record(workspaceId: string, actorSubject: string, usage: InferUsage): void;
}

/**
 * Enforces NOTHING, and is named so that reading a wiring line says so.
 *
 * Task 14 (this one) replaces it in production wiring (`wiring.ts`'s
 * `buildDeps`, which is what `main.ts` actually calls) with
 * `WindowRateLimiter` below. It is kept — deliberately, not by oversight —
 * because a handful of route and stream tests (`infer.route.test.ts`,
 * `test/helpers/streamHarness.ts`) build a `CallContext` to exercise
 * something unrelated to budgets, and giving those tests a limiter that
 * enforces nothing is the correct fixture for them: it keeps rate-limit
 * behaviour out of tests that are not about rate limiting, the same reason a
 * real one would be the wrong choice there. It is called
 * `unlimitedRateLimiter` and not `defaultRateLimiter` on purpose: a
 * permissive implementation behind a reassuring name is this project's most
 * repeated defect — a correct mechanism with no path to it, where nothing
 * looks wrong at the call site because the call site is right. Anyone
 * reading `limiter: unlimitedRateLimiter` can see that whatever it is wired
 * into currently has no budget, which is the true statement — and
 * `wiring.test.ts` asserts it is never the one production actually uses.
 */
export const unlimitedRateLimiter: RateLimiter = {
  check(): void { /* Deliberately permissive — see the comment above. */ },
  record(): void { /* Deliberately permissive — see the comment above. */ },
};

interface Window { at: number; tokens: number }

/**
 * §10's budgets, per workspace and per actor, in requests and in tokens.
 *
 * In-process, which is correct while the gateway runs as one replica and is
 * the honest limit of it: Stage 2 or a scale-out needs a shared store, and
 * the interface exists so that is one implementation and no call sites.
 * Recorded as a Stage 2 interface at the end of this plan rather than left
 * for someone to discover under load.
 */
interface WindowRateLimiterOptions {
  requestsPerMinutePerActor: number;
  requestsPerMinutePerWorkspace: number;
  tokensPerHourPerActor: number;
  tokensPerHourPerWorkspace: number;
  now(): number;
}

export class WindowRateLimiter implements RateLimiter {
  #opts: WindowRateLimiterOptions;
  #events = new Map<string, Window[]>();

  constructor(opts: WindowRateLimiterOptions) { this.#opts = opts; }

  #recent(key: string, windowMs: number): Window[] {
    const cutoff = this.#opts.now() - windowMs;
    const kept = (this.#events.get(key) ?? []).filter(e => e.at > cutoff);
    this.#events.set(key, kept);
    return kept;
  }

  check(workspaceId: string, actorSubject: string): void {
    // Keyed on (workspace, subject). The subject is issuer-scoped, so two
    // issuers' subjects can never collide in one deployment — and a
    // deployment has one issuer anyway.
    const actor = `a:${workspaceId}:${actorSubject}`;
    const ws = `w:${workspaceId}`;
    const o = this.#opts;

    if (this.#recent(actor, 60_000).length >= o.requestsPerMinutePerActor) {
      throw new ModelError(
        `You have reached this workspace's limit of ${o.requestsPerMinutePerActor} requests a `
        + 'minute. Nothing is lost — try again shortly.',
        'budget_exhausted', 429);
    }
    if (this.#recent(ws, 60_000).length >= o.requestsPerMinutePerWorkspace) {
      throw new ModelError(
        `This workspace has reached its limit of ${o.requestsPerMinutePerWorkspace} requests a `
        + 'minute across everyone using it. Nothing is lost — try again shortly.',
        'budget_exhausted', 429);
    }
    const actorTokens = this.#recent(actor, 3_600_000).reduce((n, e) => n + e.tokens, 0);
    if (actorTokens >= o.tokensPerHourPerActor) {
      throw new ModelError(
        `You have reached this workspace's hourly token budget (${o.tokensPerHourPerActor}). `
        + 'Nothing is lost — try again later, or ask an administrator to raise it.',
        'budget_exhausted', 429);
    }
    const wsTokens = this.#recent(ws, 3_600_000).reduce((n, e) => n + e.tokens, 0);
    if (wsTokens >= o.tokensPerHourPerWorkspace) {
      throw new ModelError(
        `This workspace has reached its hourly token budget (${o.tokensPerHourPerWorkspace}) `
        + 'across everyone using it. Nothing is lost — try again later.',
        'budget_exhausted', 429);
    }
  }

  record(workspaceId: string, actorSubject: string, usage: InferUsage): void {
    const at = this.#opts.now();
    const tokens = usage.promptTokens + usage.completionTokens;
    for (const key of [`a:${workspaceId}:${actorSubject}`, `w:${workspaceId}`]) {
      this.#events.set(key, [...(this.#events.get(key) ?? []), { at, tokens }]);
    }
  }
}
