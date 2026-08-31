import type { FastifyInstance } from 'fastify';
import type { Bloc, ProviderId, ProviderStatus, ProvidersPage } from '@lexprompt/core';
import type { CredentialConfig, ModelEntry } from '../config.ts';

/**
 * §14's CREDENTIAL ADMIN ENDPOINT — *"the admin endpoint reports only whether
 * a credential is configured and when it was rotated"* — which the spec has
 * named since Stage 1 and nothing had built.
 *
 * ## It reports from CONFIGURATION, and never performs an acquisition
 *
 * `configured` means *a source is configured for this provider*. It never
 * means *a token was obtained*. Two reasons, and the second is the one that
 * would bite:
 *
 *  - An administrator refreshing a status screen would be minting managed-
 *    identity tokens, one per refresh, against a tenant.
 *  - A failing acquisition would make the STATUS PAGE the thing that is
 *    down. The one screen whose job is to say what is misconfigured must not
 *    be the screen that cannot load when something is.
 *
 * So nothing here touches `CredentialResolver`. `credentials.test.ts` asserts
 * that by counting token acquisitions across a request and finding zero.
 *
 * ## What is deliberately absent from the response
 *
 * No `key`, no `keyPrefix`, no `last4`, no `fingerprint`, no `length`. Each
 * has been argued for somewhere as a debugging aid, and each is a fact about
 * a secret on an endpoint an administrator would screenshot into a risk
 * pack. `ProviderStatus`'s own docstring carries the same list, so a field
 * added to one and not the other fails to compile.
 *
 * ## `/healthz` still reports nothing about configuration
 *
 * `registerHealth`'s docstring is the reasoning this route has to answer to:
 * *"a health endpoint listing models or providers would be an
 * unauthenticated read of the allowlist"*. This route is different in the
 * one way that matters — it sits BEHIND the gateway's existing caller
 * authentication, the same hook every other route sits behind, and invents
 * no second mechanism of its own.
 */

export interface AdminCredentialDeps {
  models: ModelEntry[];
  allowedJurisdictions: Bloc[];
  readEnv(name: string): string | undefined;
  /**
   * When a MOUNTED SECRET FILE was last written, or `undefined`.
   *
   * The only rotation instant this gateway can honestly report without
   * asking a provider for anything. A Key Vault secret's `updatedOn` would
   * be a second one and is deliberately NOT read here: fetching it is a
   * call to the vault on a status refresh, which is the acquisition this
   * route exists not to perform. Absent means *not recorded*, and the wire
   * type says so.
   *
   * Injected so this module touches no filesystem and every branch is
   * testable with no disk.
   */
  fileRotatedAt(path: string): Date | undefined;
}

/**
 * How a declared source authenticates.
 *
 * `managed-identity` is the ONLY value for which S2's no-key half is true.
 * Everything else means a key exists somewhere and the gateway is the only
 * process holding it — a weaker and still worth-saying claim, and the one
 * §18 item 8 requires a screen to make instead of the unconditional one.
 */
function authOf(source: CredentialConfig['source']): ProviderStatus['auth'] {
  return source === 'managed-identity' ? 'managed-identity' : 'key';
}

/**
 * Whether the source is configured, WITHOUT acquiring anything.
 *
 * For `env` and `file` that can be answered honestly and cheaply: the
 * variable is set and non-empty, or the file is there. For
 * `managed-identity` and `key-vault` it cannot be answered at all without
 * calling out, so a declared source counts as configured — which is what
 * `configured` means, and the wire type says so rather than leaving a reader
 * to assume it means "working".
 */
function isConfigured(
  credential: CredentialConfig, deps: AdminCredentialDeps,
): boolean {
  switch (credential.source) {
    case 'managed-identity':
    case 'key-vault':
      return true;
    case 'env':
      return (deps.readEnv(credential.var) ?? '').trim().length > 0;
    case 'file':
      return deps.fileRotatedAt(credential.path) !== undefined;
  }
}

function rotatedAtOf(
  credential: CredentialConfig, deps: AdminCredentialDeps,
): string | undefined {
  if (credential.source !== 'file') return undefined;
  return deps.fileRotatedAt(credential.path)?.toISOString();
}

export function registerAdminCredentials(
  app: FastifyInstance, deps: AdminCredentialDeps, log: (line: string) => void,
): void {
  app.get('/v1/admin/credentials', async (_req, reply): Promise<ProvidersPage | undefined> => {
    /** Which entry was being inspected when something threw. It is the only
     *  thing the failure path reports, and it holds no secret. */
    let failing: { provider: ProviderId; source: CredentialConfig['source'] } | undefined;
    try {
      const byProvider = new Map<ProviderId, ProviderStatus>();
      failing = undefined;
      for (const entry of deps.models) {
        failing = { provider: entry.provider, source: entry.credential.source };
        const existing = byProvider.get(entry.provider);
        if (existing) {
          existing.modelCount += 1;
          continue;
        }
        const rotatedAt = rotatedAtOf(entry.credential, deps);
        byProvider.set(entry.provider, {
          provider: entry.provider,
          auth: authOf(entry.credential.source),
          configured: isConfigured(entry.credential, deps),
          // ABSENT, never `rotatedAt: undefined`: `structuredClone` and
          // JSON treat the two differently, and a key that is present with
          // no value reads to an `in` check as a rotation instant that is
          // there.
          ...(rotatedAt ? { rotatedAt } : {}),
          modelCount: 1,
        });
      }
      return {
        providers: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
        declaredJurisdictions: deps.allowedJurisdictions,
      };
    } catch (err) {
      /*
       * THE ERROR PATH LEAKS NOTHING EITHER — the half that has caught real
       * leaks in real systems, and the half this route was first written
       * wrong.
       *
       * THE CAUGHT MESSAGE IS NOT REPORTED ANYWHERE. Not in the response,
       * and not in the log. The first draft sent it to the log through
       * `redactCredential`, removing every env-sourced value this process
       * could see — and the test that fires an error carrying a FILE-sourced
       * key went red, correctly: the set of values that could appear in a
       * failure here is not knowable without acquiring them, and acquiring
       * is the one thing this route must not do. A redactor that removes
       * some of the secrets is a partial defence presented as a complete
       * one, which is worse than none because it looks handled.
       *
       * So what is reported is what cannot be a secret: WHICH PROVIDER and
       * WHICH SOURCE KIND was being inspected, and the error's class name.
       * That is enough for an operator to go and look, and it carries no
       * value from any credential by construction rather than by filtering.
       *
       * `redactCredential` is the right tool one layer over, in `callModel`,
       * where the credential IS in hand and the complete set is known.
       */
      const where = failing ? `${failing.provider} (${failing.source} source)` : 'this deployment';
      log(
        `gateway: could not report credential status for ${where}: `
        + `${err instanceof Error ? err.constructor.name : 'a non-Error value'}. `
        + 'The message is deliberately not logged — it can carry the credential itself, and '
        + 'this process cannot know every value that would have to be removed without '
        + 'acquiring them.\n');
      void reply.code(503).send({
        error: {
          code: 'service_misconfigured',
          message: 'LexPrompt could not read this deployment\'s credential configuration. '
            + 'The gateway\'s own log names which provider and which kind of source it was '
            + 'reading; nothing about a credential is reported anywhere.',
        },
      });
      return undefined;
    }
  });
}
