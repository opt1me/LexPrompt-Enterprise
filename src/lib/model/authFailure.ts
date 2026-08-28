import { isServiceConfigError, isSignInError } from '@lexprompt/core';

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
