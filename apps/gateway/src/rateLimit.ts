import type { InferUsage } from '@lexprompt/core';

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
 * `main.ts` wires this until Task 14 lands. It is called
 * `unlimitedRateLimiter` and not `defaultRateLimiter` on purpose: a
 * permissive implementation behind a reassuring name is this project's most
 * repeated defect — a correct mechanism with no path to it, where nothing
 * looks wrong at the call site because the call site is right. Anyone
 * reading `limiter: unlimitedRateLimiter` in `main.ts` can see that the
 * deployment currently has no budget, which is the true statement.
 */
export const unlimitedRateLimiter: RateLimiter = {
  check(): void { /* Task 14 replaces this with the real budget check. */ },
  record(): void { /* Task 14 replaces this with the real usage accounting. */ },
};
