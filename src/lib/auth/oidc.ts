import { UserManager, WebStorageStateStore, ErrorResponse, type User } from 'oidc-client-ts';
import { ModelError } from '@lexprompt/core';
import { config } from '../config';

/**
 * Standards OIDC — authorization code with PKCE, against a CONFIGURED
 * issuer (§7, S28). Entra ID in a firm deployment, Keycloak in compose, and
 * this file does not know which: `authority` is a configured URL and
 * everything else comes from that issuer's discovery document.
 *
 * NOT MSAL, deliberately. MSAL is Entra's own library, and using it would
 * either tie this path to one issuer or produce a second path for the
 * other — two implementations of one idea, at the front door. If you are
 * reading this because you were about to add `@azure/msal-browser` back:
 * that is the change S28 exists to prevent.
 */
export const userManager = new UserManager({
  authority: config.oidcIssuer,
  client_id: config.oidcClientId,
  redirect_uri: window.location.origin,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',              // authorization code…
  scope: config.oidcScope,            // …with PKCE, which oidc-client-ts does by default
  // sessionStorage, not localStorage: a token is the one thing in this app
  // that should NOT outlive the tab. Everything else the app stores is the
  // user's own work; this is a credential.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
  loadUserInfo: false,                // the access token carries what we need
});

/** OIDC's own vocabulary for "no amount of silence will produce a token —
 *  a person has to be present": the `error` values a conformant authorize
 *  endpoint returns for a `prompt=none` (silent) request it cannot satisfy.
 *
 *  The task brief that shaped this file named the case `InteractionRequiredAuthError`,
 *  which is `@azure/msal-browser`'s class for the same idea — not something
 *  `oidc-client-ts` throws (it has no such export; a rejected silent renewal
 *  surfaces as an `ErrorResponse` carrying one of the codes below, per the
 *  OIDC spec's prompt=none section). Reaching for the MSAL name here would
 *  have been exactly the "second sign-in path" mistake this task exists to
 *  avoid, just one layer further in. */
const INTERACTION_REQUIRED_CODES: ReadonlySet<string> = new Set([
  'login_required', 'interaction_required', 'consent_required', 'account_selection_required',
]);

function isInteractionRequired(err: unknown): boolean {
  return err instanceof ErrorResponse && !!err.error && INTERACTION_REQUIRED_CODES.has(err.error);
}

/**
 * The single source of a bearer token for every request the browser makes.
 *
 * A silent renew is attempted first; a failure that the issuer reports as
 * needing a person present (`isInteractionRequired`) starts an interactive
 * redirect and rejects — it must never resolve with an empty string, which
 * would send `apps/api` a request with no `Authorization` header at all and
 * produce an anonymous 401 rather than a clear "sign in again". Any other
 * failure (network, a misconfigured issuer) is a `sign_in_required`
 * `ModelError` instead: the caller can show it, but there is nothing a
 * redirect would fix.
 */
export async function getAccessToken(): Promise<string> {
  let user: User | null = await userManager.getUser();
  if (!user || user.expired) {
    try {
      user = await userManager.signinSilent();
    } catch (err) {
      if (isInteractionRequired(err)) {
        await userManager.signinRedirect();
        throw new ModelError(
          'Your session needs you to sign in again. Redirecting…',
          'sign_in_required', 401,
        );
      }
      throw new ModelError(
        `Your sign-in could not be renewed (${(err as Error).message}). Sign in again.`,
        'sign_in_required', 401,
      );
    }
  }
  if (!user?.access_token) {
    throw new ModelError('You are not signed in. Sign in to continue.', 'sign_in_required', 401);
  }
  return user.access_token;
}
