import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { ModelError } from '@lexprompt/core';

/**
 * The whole of what varies between the two environments (§7, §5.1 row 1).
 * Entra ID and Keycloak differ in these five values and in nothing else —
 * no branch, no flag, no second module.
 */
export interface AuthConfig {
  issuer: string;
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
}

/**
 * Refuses an issuer the API must not start with (S29).
 *
 * "Loopback, or a hostname with no dots": a bare compose service name
 * (`keycloak`) cannot be a public host, and a public issuer always has a
 * dotted domain. The rule looks arbitrary without that sentence, which is
 * why the sentence is here.
 */
export function assertIssuerUsable(issuer: string): void {
  if (!issuer) {
    throw new Error(
      'No issuer is configured. The API will not start without one: a misconfiguration '
      + 'must not become a system that runs and mostly works.',
    );
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`The configured issuer ${JSON.stringify(issuer)} is not a URL.`);
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1'
    || host === '::1' || host === '[::1]'
    || !host.includes('.');
  if (!loopback) {
    throw new Error(
      `The configured issuer ${issuer} is not https and does not resolve to loopback. `
      + 'This is the check that makes a deployed environment pointed at a development '
      + 'issuer a startup failure rather than a silent one.',
    );
  }
}

/** Reads the issuer's own discovery document and builds a key set from the
 *  `jwks_uri` it names — never from a URL template, which would be an
 *  issuer-specific assumption wearing a helper's clothes. */
export async function discoverJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${response.status}.`);
  }
  const doc = await response.json() as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery for ${issuer} names no jwks_uri.`);
  return createRemoteJWKSet(new URL(doc.jwks_uri));
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
      groups: Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [],
      name: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email
        : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    };
  };
}
