import { ModelError, SERVICE_CONFIG_HINT } from '@lexprompt/core';
import { GatewayUnreadableError } from './gatewayClient.ts';

/**
 * The two things `apps/api` must NOT forward to a browser verbatim, shared by
 * both routes that forward to the gateway rather than written twice.
 *
 * Verbatim pass-through is right for almost everything the gateway answers —
 * `model_not_allowed` 400, `jurisdiction_not_allowed` 403,
 * `prompt_too_large` 413 — and both routes are tested for those. These two
 * are the exceptions, and they are exceptions for the same reason: they are
 * facts about the DEPLOYMENT that arrive shaped like facts about the user.
 */

/**
 * A 401 from the gateway is never about the person at the keyboard (M6).
 *
 * By the time either route calls the gateway, `requireUser` has already
 * validated the user's token; the only thing left for the gateway to refuse
 * is `apps/api`'s OWN identity, and `apps/gateway/src/callerAuth.ts` answers
 * 401 `not_permitted` in five places for exactly that — an absent or
 * unrecognised client-certificate subject, a missing or invalid Entra token.
 * The gateway has no other 401: a provider rejecting the firm's credential
 * is turned into a 503 `service_misconfigured` by `modelErrorFor` before it
 * ever leaves that service.
 *
 * Forwarded verbatim, those 401s reached the browser as `not_permitted`,
 * which `isSignInError` classifies as "sign in again" — a lawyer told to
 * re-authenticate over a mismatch between two services' credentials, on a
 * deployment where signing in a hundred times changes nothing. This is the
 * reachable half of what `assertCanAuthenticateToGateway` cannot cover:
 * `apps/api` never sees `GATEWAY_CALLER_AUTH`, so it cannot know at startup
 * that its mTLS material is the wrong credential for a gateway running
 * `entra`. It starts cleanly, reports healthy, and every call 401s.
 *
 * `apps/api` is the only hop that can tell the difference, because it is the
 * only one that knows the 401 came from its OWN call rather than from the
 * user's token.
 */
export function callerAuthRefusal(status: number): ModelError | undefined {
  if (status !== 401) return undefined;
  return new ModelError(
    'LexPrompt\'s own request to the firm\'s AI service was refused: the service did '
    + 'not accept this deployment\'s credentials. Your sign-in is not the problem and '
    + 'signing in again will not help — the API and the gateway are configured with '
    + `different caller-authentication settings. This is a configuration problem in the `
    + `deployment, ${SERVICE_CONFIG_HINT}.`,
    'service_misconfigured', 503,
  );
}

/**
 * "Could not reach it" and "reached it and could not read the reply" are
 * different diagnoses, and only the second one is what an unreadable body
 * means (m7).
 *
 * `gateway.infer` and `gateway.models` throw from two places: the request
 * itself (DNS, ECONNREFUSED, a TLS handshake the certificate did not
 * satisfy) and the JSON read of a reply that did arrive. Both used to be
 * reported as "LexPrompt could not reach the firm's AI service" — confident,
 * and wrong in the second case, which is the sentence an administrator would
 * act on when the thing to look at is what the gateway actually returned.
 */
export function unreachableGateway(err: unknown, what: string): ModelError {
  if (err instanceof GatewayUnreadableError) {
    return new ModelError(
      `LexPrompt reached the firm's AI service, but could not read its reply to the `
      + `${what} request (HTTP ${err.status}: ${err.message}). This is a configuration `
      + `problem in the deployment, ${SERVICE_CONFIG_HINT}.`,
      'service_misconfigured', 503,
    );
  }
  // The underlying message is kept, DELIBERATELY (m8), and it can carry the
  // gateway's internal host or address — `connect ECONNREFUSED
  // 10.x.x.x:8081`, or an Azure-internal FQDN. Every reader of this body has
  // already passed `requireUser`, so they are a signed-in member of the
  // firm, and "LexPrompt could not reach the firm's AI service" with nothing
  // after it is a sentence nobody can act on: the difference between a
  // refused connection, a DNS failure and a rejected certificate is the
  // whole of what an administrator needs. Loud beats quiet, and this is the
  // deliberate half of that trade rather than an oversight.
  return new ModelError(
    `LexPrompt could not reach the firm's AI service. This is a configuration problem `
    + `in the deployment, ${SERVICE_CONFIG_HINT}. (${(err as Error).message})`,
    'service_misconfigured', 503,
  );
}
