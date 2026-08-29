import { ModelError, isServiceConfigError, isSignInError } from '@lexprompt/core';

/**
 * A failure a Retry button cannot fix.
 *
 * The successor to `openrouter.ts`'s `isAuthError`, which meant exactly one
 * thing — "there is nothing a retry can do about this, and it must never be
 * presented as if it were a model's answer" — and covered both halves of
 * that with a single 401/403 check. The gateway now separates the two
 * halves, because they are two different people's problems:
 *
 *   `isSignInError`        the person at the keyboard signs in again
 *   `isServiceConfigError` an administrator fixes the firm's configuration
 *
 * `Finding.authError` is persisted and keeps its name and its meaning
 * (`reviewMigration.ts` reads it), so the *flagging* decision stays one
 * predicate. Task 23 splits the SENTENCE each caller shows, which is the
 * part that genuinely differs; this is deliberately the shared half, and it
 * lives in one place rather than as nine copies of the same disjunction.
 */
export function isAuthFailure(error: unknown): boolean {
  return isSignInError(error) || isServiceConfigError(error);
}

/**
 * Task 17: whether `GET /v1/me` answered "authenticated, but told plainly
 * there is no access" (§7) — a user in no mapped group, a disabled account,
 * or a group-overage account the API cannot even resolve to groups.
 *
 * `group_overage` also satisfies `isServiceConfigError` above, and that is
 * not a conflict: the two predicates serve different call sites for
 * different reasons. `isServiceConfigError` classifies a *model-call*
 * failure (`/v1/infer`, mid-review) for `handleModelError`, where "an
 * administrator must fix this" is the whole of what the reader needs.
 * `App.tsx`'s BOOT-TIME access gate needs the finer distinction this
 * function makes — group overage gets its own headline ("could not read
 * your groups"), never "not in any group", because the two are different
 * facts and telling a partner in forty groups they have no access is a
 * wrong answer delivered with total confidence. Checked FIRST, ahead of
 * `isServiceConfigError`, wherever both are in play — see `App.tsx`'s gate.
 */
export function isAccessRefusedError(error: unknown): error is ModelError {
  return error instanceof ModelError
    && (error.code === 'no_role' || error.code === 'account_disabled' || error.code === 'group_overage');
}
