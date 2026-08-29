import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './sourceScan.ts';

/**
 * The local issuer has to mint a token `apps/api` will accept, and twice now
 * it has not — for two unrelated reasons, both presenting to a user as
 * "Sign in again", forever.
 *
 * This file is in the API's test workspace rather than an infra one on
 * purpose: the realm is not interesting in itself, it is interesting because
 * `makeTokenVerifier` reads exactly these claims. Every assertion below is
 * paired with the line in `oidc.ts` that refuses when it is missing.
 *
 * It cannot replace running the stack — a JSON file is not a running
 * Keycloak — but each of these was a silent absence, and a silent absence is
 * what a file check is good at.
 */

interface Mapper { name: string; protocolMapper: string; config?: Record<string, string> }
interface Scope { name: string; protocolMappers?: Mapper[] }
interface Client { clientId: string; defaultClientScopes?: string[] }

const realm = JSON.parse(readFileSync(
  path.join(ROOT, 'infra/keycloak/lexprompt-realm.json'), 'utf8',
)) as { clientScopes: Scope[]; clients: Client[] };

const scope = (name: string): Scope => {
  const found = realm.clientScopes.find(s => s.name === name);
  expect(found, `the realm declares no "${name}" client scope`).toBeDefined();
  return found!;
};

const web = (): Client => {
  const found = realm.clients.find(c => c.clientId === 'lexprompt-web');
  expect(found).toBeDefined();
  return found!;
};

describe('the seeded realm issues a token apps/api can accept', () => {
  /**
   * An import that supplies `clientScopes` REPLACES Keycloak's built-in set —
   * the realm file's own `profile` scope says so, having been added after
   * sign-in failed with `invalid_scope`. `basic` was missed in the same way,
   * and `basic` is where Keycloak 24+ keeps the `sub` mapper.
   *
   * The result: every token this stack issued carried no `sub` at all, and
   * `oidc.ts` refused each one with "the token carries no sub claim. Sign in
   * again." Signing in again produced another token with no `sub`. Observed
   * against the running stack, not inferred.
   */
  it('declares the basic scope, so tokens carry a sub claim at all', () => {
    const mappers = scope('basic').protocolMappers ?? [];
    expect(mappers.map(m => m.protocolMapper)).toContain('oidc-sub-mapper');
    const sub = mappers.find(m => m.protocolMapper === 'oidc-sub-mapper')!;
    // `oidc.ts` reads the claim off the ACCESS token, so an id-token-only
    // mapper would leave the same hole with the scope present.
    expect(sub.config?.['access.token.claim']).toBe('true');
  });

  it('gives lexprompt-web that scope by default, not merely as an option', () => {
    // A scope the client does not request is a mapper that never runs.
    expect(web().defaultClientScopes).toContain('basic');
  });

  // The audience half, which was already right — asserted here so the two
  // halves of "a token apps/api accepts" sit in one place.
  it('adds the lexprompt-api audience, which API_AUDIENCE demands', () => {
    const mappers = scope('lexprompt-api').protocolMappers ?? [];
    const audience = mappers.find(m => m.protocolMapper === 'oidc-audience-mapper');
    expect(audience?.config?.['included.client.audience']).toBe('lexprompt-api');
    expect(audience?.config?.['access.token.claim']).toBe('true');
    expect(web().defaultClientScopes).toContain('lexprompt-api');
  });

  it('declares the standard scopes the built-in set would otherwise have supplied', () => {
    // The rule that caught all three: an explicit clientScopes list is the
    // WHOLE list. Anything not named here does not exist in this realm.
    const names = realm.clientScopes.map(s => s.name).sort();
    expect(names).toEqual(['basic', 'email', 'groups', 'lexprompt-api', 'profile']);
  });

  /**
   * Keycloak's DESCRIPTION column is VARCHAR(255). A longer one aborts the
   * import and the container exits 1 — with the realm half-created, which
   * looks like a code failure rather than a text-length one. These
   * descriptions are long on purpose (they carry the reasoning above), so the
   * limit is worth a test rather than a memory.
   */
  it('keeps every description inside the column Keycloak stores it in', () => {
    const tooLong = realm.clientScopes
      .filter(s => ((s as { description?: string }).description ?? '').length > 255)
      .map(s => s.name);
    expect(tooLong).toEqual([]);
  });
});
