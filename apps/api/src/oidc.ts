import { jwtVerify, createRemoteJWKSet, errors, type JWTVerifyGetKey } from 'jose';
import { ModelError, SERVICE_CONFIG_HINT } from '@lexprompt/core';

/**
 * The whole of what varies between the two environments (§7, §5.1 row 1).
 * Entra ID and Keycloak differ in these values and in nothing else — no
 * branch, no flag, no second module.
 *
 * `discoveryUrl` is the sixth field and the only one that is not a property
 * of the ISSUER: it is a property of where this process sits on the network.
 * It defaults to `issuer`, so a firm deployment still configures five
 * values; see its own comment for why the two cannot be one string.
 */
export interface AuthConfig {
  /**
   * The issuer string a token must CARRY, compared byte for byte by jose.
   *
   * This is the address the BROWSER saw when it obtained the token, because
   * that is the host the issuer stamped into `iss`.
   */
  issuer: string;
  /**
   * Where THIS PROCESS fetches that issuer's discovery document, and through
   * it its signing keys. `/.well-known/openid-configuration` is appended to
   * it exactly as it would be to `issuer`.
   *
   * TWO FACTS, NOT ONE, and conflating them is what made the compose stack
   * unable to authenticate anybody. Keycloak is published to the browser on
   * `http://localhost:8088` and reachable from inside the `internal` network
   * only as `http://keycloak:8080`; it stamps `iss` from the request host,
   * so the browser's token said `localhost:8088` while this service was
   * configured to demand `keycloak:8080`. The signature verified; the
   * issuer comparison did not, so every call returned 401 `sign_in_required`
   * and the only action the message offered — sign in again — produced the
   * same 401 forever.
   *
   * The fix is NOT to relax the issuer comparison. That comparison is what
   * stops a token minted by a development issuer being accepted by a firm's
   * deployment (S29), and it is tested for exactly that (`oidc.test.ts`).
   * The fix is to stop pretending one string answers both questions.
   *
   * In Azure the two coincide, because Entra is publicly reachable from the
   * container, so `config.ts` defaults this to `issuer` and a firm
   * deployment configures nothing extra.
   */
  discoveryUrl: string;
  audience: string;
  /** 'oid' for Entra (stable across the tenant); 'sub' elsewhere. */
  subjectClaim: string;
  /** Named, never assumed. */
  groupsClaim: string;
  /** { tid: <tenant id> } for Entra. Compared generically. */
  requiredClaims: Record<string, string>;
}

/**
 * Identity is (issuer, subject), never the email (§7).
 *
 * An email can be reassigned; an issuer-scoped subject cannot. The pair is
 * also what makes one implementation correct against both issuers: a
 * Keycloak `sub` and an Entra `oid` are both opaque stable strings, and
 * neither is ever compared with the other.
 */
export interface Principal {
  issuer: string;
  subject: string;
  groups: string[];
  name?: string;
  email?: string;
  /**
   * WHEN THIS TOKEN STOPS BEING ONE, in epoch milliseconds — the `exp` claim
   * `jwtVerify` has already enforced, carried forward rather than discarded.
   *
   * An HTTP request re-verifies on every call, so it has never needed this.
   * A WEBSOCKET is authenticated once, at the upgrade, and then lives as
   * long as the tab: without an expiry to close it on, a token's lifetime
   * meant nothing to a socket and revocation had no effect on a live
   * connection at all. `realtime/socket.ts` closes on it.
   *
   * ABSENT rather than `undefined`-valued when the token carries no `exp`
   * (nothing this deployment's issuers mint, but a claim is a claim): the
   * socket then falls back to re-checking the account, and an `in` test must
   * be able to tell "no expiry" from "expires at undefined".
   */
  expiresAt?: number;
}

/**
 * Refuses an issuer the API must not start with (S29).
 *
 * "Loopback, or a hostname with no dots": a bare compose service name
 * (`keycloak`) cannot be a public host, and a public issuer always has a
 * dotted domain. The rule looks arbitrary without that sentence, which is
 * why the sentence is here.
 */
export function assertIssuerUsable(issuer: string, what = 'issuer'): void {
  if (!issuer) {
    throw new Error(
      `No ${what} is configured. The API will not start without one: a misconfiguration `
      + 'must not become a system that runs and mostly works.',
    );
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`The configured ${what} ${JSON.stringify(issuer)} is not a URL.`);
  }
  // Scheme first, and http/https ONLY.
  //
  // The host checks below are all this function used to do, and
  // `!host.includes('.')` is true of the EMPTY string — so
  // `file:///etc/passwd`, or a `data:` URL, sailed through the S29 refusal
  // with a hostname of `''`. It still failed later, at the discovery fetch,
  // as an unhandled rejection with a stack rather than as the "LexPrompt
  // api will not start" banner this check exists to produce.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `The configured ${what} ${issuer} uses the ${url.protocol} scheme. An OIDC `
      + `${what} is fetched over HTTP; nothing else is a ${what} this API can use.`,
    );
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname;
  // Plaintext is permitted for loopback and for a SINGLE-LABEL hostname.
  //
  // The second half is wider than the spec's words (§7, S29 say "does not
  // resolve to loopback") and it is deliberate, because the compose stack
  // reaches Keycloak at `http://keycloak:8080` — a container-network
  // service name, which is not loopback and cannot be made loopback from
  // inside another container. Requiring https there would mean shipping a
  // dev CA into the identity provider before anyone can run the stack.
  //
  // It is NOT called `loopback`, because it is not loopback, and a variable
  // that names a stricter check than it performs is how the next reader
  // concludes plaintext is impossible off localhost. A single-label name is
  // not resolvable on the public internet, which is the property being
  // leaned on — but it IS resolvable on a corporate network, so
  // `http://sso` in a firm deployment would be accepted here. That is a
  // real residual risk and it is written down rather than hidden behind a
  // reassuring identifier.
  const plaintextPermitted = host === 'localhost' || host === '127.0.0.1'
    || host === '::1' || host === '[::1]'
    || !host.includes('.');
  if (!plaintextPermitted) {
    throw new Error(
      `The configured ${what} ${issuer} is not https, and its host ${JSON.stringify(host)} `
      + 'is neither loopback nor a single-label container-network name. '
      + 'This is the check that makes a deployed environment pointed at a development '
      + `${what} a startup failure rather than a silent one.`,
    );
  }
}

/** How long the startup discovery fetch may hang before the process says so.
 *  Deliberately not configurable: it is a property of "a startup step must
 *  not hang forever", not of a deployment. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Reads the issuer's own discovery document and builds a key set from the
 * `jwks_uri` it names — never from a URL template, which would be an
 * issuer-specific assumption wearing a helper's clothes.
 *
 * It takes the whole `AuthConfig` and reads `discoveryUrl` ITSELF rather
 * than taking a string, and that is deliberate. A `string` parameter is a
 * seam a caller can close by accident — `discoverJwks(config.auth.issuer)`
 * compiles, reads correctly, and reinstates C1 in full — and `main.ts` is a
 * composition root with no test standing under it. Taking the config makes
 * the wrong call a type error instead of a silent regression.
 *
 * The fetch is bounded. Without a signal a hung issuer hangs `main()` before
 * `app.listen`, so the process is alive and answering nothing at all —
 * including `/healthz`, which is how an orchestrator would otherwise be told
 * to replace it.
 */
export async function discoverJwks(auth: AuthConfig): Promise<JWTVerifyGetKey> {
  const url = `${auth.discoveryUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `OIDC discovery could not reach ${url}: ${(err as Error).message}. `
      + 'This API validates tokens against keys it reads from the issuer, so it '
      + 'will not start until that address answers.',
    );
  }
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${url}: HTTP ${response.status}.`);
  }
  const doc = await response.json() as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery for ${url} names no jwks_uri.`);
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/**
 * The jose error codes that mean THE TOKEN is bad — as opposed to meaning
 * the check could not be completed at all.
 *
 * `jwtVerify` awaits `createRemoteJWKSet`'s callable INSIDE the same try, so
 * a JWKS endpoint that is down, a signing key rotated inside jose's
 * cooldown, a DNS failure inside the container and a malformed JWKS all
 * arrive in the same catch as an expired token. Answering all of them with
 * "your sign-in could not be verified, sign in again" tells every user in
 * the firm, simultaneously, that their own session is the problem — and
 * signing in again cannot fix any of them. That is the distinction
 * `server.ts` calls load-bearing: "sign in again" and "ask your admin" are
 * different instructions.
 *
 * This is an ALLOWLIST rather than a denylist, so an error class nobody
 * anticipated classifies as "could not complete the check". That is the
 * safe direction: it sends someone to look, rather than looping a user
 * through a sign-in that will not help.
 *
 * `JWKSNoMatchingKey` is deliberately NOT here. A `kid` the key set does not
 * carry is far more often an issuer that rotated its keys than a forged
 * token, and jose's own cooldown means a legitimate rotation produces it for
 * every user at once.
 */
const TOKEN_FAULT_CODES: ReadonlySet<string> = new Set([
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JOSEAlgNotAllowed.code,
]);

function isTokenFault(err: unknown): boolean {
  return err instanceof errors.JOSEError && TOKEN_FAULT_CODES.has(err.code);
}

/**
 * Reads the groups claim, and REFUSES a shape it cannot read rather than
 * reporting it as "in no groups".
 *
 * This is the same conflation the overage branch below exists to prevent, on
 * a different input shape: `Array.isArray(raw) ? … : []` turned every
 * unreadable claim into an empty membership list. Some issuers emit a single
 * group as a bare string, which is read here as the one group it is. A
 * number, an object or anything else is a claim this code does not
 * understand, and an administrator — not the user — is the person who can do
 * something about it.
 *
 * Nothing reads `Principal.groups` in Stage 1, so this refusal is unreachable
 * against either supported issuer today. It is written now because the moment
 * groups gate anything, "unreadable" silently reading as "denied" is a wrong
 * answer delivered confidently.
 */
function readGroups(raw: unknown, claim: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return raw ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  throw new ModelError(
    `Your sign-in carries a "${claim}" claim in a shape LexPrompt cannot read, so it `
    + 'cannot tell which groups you are in. Reading it as "no groups" would deny you '
    + 'access for a reason that is not true. Signing in again will not change the shape '
    + `of the claim — ask your administrator to check how "${claim}" is mapped, `
    + `${SERVICE_CONFIG_HINT}.`,
    'service_misconfigured', 503,
  );
}

/**
 * Validates a token against a CONFIGURED issuer. There is no Entra branch
 * here and there must never be one (S28): the tenant check is a required
 * claim, the subject is a named claim, and the group claim is a named claim.
 */
export function makeTokenVerifier(
  config: AuthConfig,
  jwks: JWTVerifyGetKey,
): (token: string) => Promise<Principal> {
  return async (token: string): Promise<Principal> => {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      });
      payload = result.payload;
    } catch (err) {
      // The token never reaches the message: an error string ends up in a
      // log, a browser console and a support ticket.
      if (!isTokenFault(err)) {
        // The check could not be COMPLETED. Nothing the person at the
        // keyboard does resolves this, so it must not be answered with an
        // instruction addressed to them. See TOKEN_FAULT_CODES.
        throw new ModelError(
          'LexPrompt could not check your sign-in, because it could not reach or read '
          + `the keys your identity provider publishes (${(err as Error).message}). `
          + 'Your sign-in is not the problem and signing in again will not help. This is '
          + `a configuration or availability problem in the deployment, ${SERVICE_CONFIG_HINT}.`,
          'service_misconfigured', 503,
        );
      }
      throw new ModelError(
        `Your sign-in could not be verified (${(err as Error).message}). Sign in again.`,
        'sign_in_required', 401,
      );
    }

    for (const [claim, expected] of Object.entries(config.requiredClaims)) {
      if (payload[claim] !== expected) {
        throw new ModelError(
          `Your sign-in could not be verified (the ${claim} claim does not match this `
          + 'deployment). Sign in again.',
          'sign_in_required', 401,
        );
      }
    }

    const subject = payload[config.subjectClaim];
    if (typeof subject !== 'string' || !subject) {
      throw new ModelError(
        `Your sign-in could not be verified (the token carries no ${config.subjectClaim} `
        + 'claim). Sign in again.',
        'sign_in_required', 401,
      );
    }

    // §7: a missing group claim is not the same fact as an empty one.
    //
    // When a user belongs to more groups than a token can carry, Entra omits
    // `groups` entirely and emits `_claim_names` pointing at Microsoft Graph.
    // Read naively that is indistinguishable from "in no mapped group" — so a
    // partner in forty groups would be told they have no access, which is a
    // wrong answer delivered confidently. Three states, three outcomes:
    // populated, genuinely empty, and overage.
    //
    // Keycloak cannot reproduce this (§5.1): no seeded user is in enough
    // groups, so the local path is always the simple one and always works.
    // That is why this is specified and unit-tested rather than discovered.
    const raw = payload[config.groupsClaim];
    const claimNames = payload._claim_names as Record<string, unknown> | undefined;
    if (raw === undefined && claimNames && config.groupsClaim in claimNames) {
      throw new ModelError(
        'Your account is in too many groups for LexPrompt to read them from your sign-in '
        + '(group overage). This is not a problem you can fix by signing in again — ask '
        + 'your administrator to grant LexPrompt directory read access, or to reduce your '
        + 'group memberships.',
        'group_overage', 403,
      );
    }

    return {
      issuer: config.issuer,
      subject,
      // `exp` is SECONDS in a JWT and milliseconds everywhere in this
      // codebase. Spread-on-condition so a token with no `exp` produces no
      // key at all rather than one valued `undefined`.
      ...(typeof payload.exp === 'number'
        ? { expiresAt: payload.exp * 1_000 } : {}),
      groups: readGroups(raw, config.groupsClaim),
      name: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email
        : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    };
  };
}
