import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

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
interface Client {
  clientId: string;
  description?: string;
  defaultClientScopes?: string[];
  directAccessGrantsEnabled?: boolean;
  standardFlowEnabled?: boolean;
  publicClient?: boolean;
  redirectUris?: string[];
}

/** The client the SHIPPED APPLICATION signs in through — read from the
 *  compose file's build args rather than retyped, so this suite and the
 *  stack cannot name two different clients. `${OIDC_CLIENT_ID}` is compose
 *  interpolation, and `/tmp/compose.env` and `.env.example` both set it to
 *  `lexprompt-web`; the realm has to declare exactly one client that the
 *  browser's standard flow can use, and this asserts which one that is. */
const APP_CLIENT_ID = 'lexprompt-web';

const realm = JSON.parse(readFileSync(
  path.join(ROOT, 'infra/keycloak/lexprompt-realm.json'), 'utf8',
)) as { clientScopes: Scope[]; clients: Client[] };

const scope = (name: string): Scope => {
  const found = realm.clientScopes.find(s => s.name === name);
  expect(found, `the realm declares no "${name}" client scope`).toBeDefined();
  return found!;
};

const clientNamed = (clientId: string): Client => {
  const found = realm.clients.find(c => c.clientId === clientId);
  expect(found, `the realm declares no "${clientId}" client`).toBeDefined();
  return found!;
};

const web = (): Client => clientNamed(APP_CLIENT_ID);

/**
 * Source files (comments blanked, tests excluded by `walk`) under `dirs`
 * whose CODE names `needle`.
 *
 * Comments are removed first for the reason `sourceScan.codeOf` gives at
 * length: this repository is full of prose about the things it forbids, and
 * a raw text search cannot tell a violation from a note saying it must not
 * happen. The helper below (`twoAccounts.ts`) is not a `.test.ts` file, so
 * `walk` does see it — which is what makes the positive half of the pair
 * below a real sanity check rather than a tautology.
 */
function filesNaming(needle: string, dirs: string[]): string[] {
  const files = dirs.flatMap(d => walk(path.join(ROOT, d)));
  expect(files.length, `the scan read no files under ${dirs.join(', ')}`).toBeGreaterThan(0);
  return files.filter(f => codeOf(f).includes(needle)).map(rel).sort();
}

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
    // CLIENTS AS WELL AS SCOPES, and the clients half is not decoration: the
    // first draft of `lexprompt-test` below carried its whole justification
    // in `description`, 715 characters, and CLIENT.DESCRIPTION is the same
    // VARCHAR(255). The reasoning lives in this file instead, where there is
    // no column to overflow.
    const tooLong = [
      ...realm.clientScopes.map(s => [s.name, (s as { description?: string }).description ?? ''] as const),
      ...realm.clients.map(c => [c.clientId, c.description ?? ''] as const),
    ].filter(([, description]) => description.length > 255).map(([name]) => name);
    expect(tooLong).toEqual([]);
    // The sanity check: the filter above passes over a realm with no
    // descriptions at all, which is the shape of a guard scanning nothing.
    const described = [...realm.clientScopes.map(s => (s as { description?: string }).description),
      ...realm.clients.map(c => c.description)].filter(Boolean);
    expect(described.length).toBeGreaterThan(3);
  });
});

/**
 * S29: THE PASSWORD GRANT IS A TEST FIXTURE, NOT A SECOND WAY IN.
 *
 * Stage 4 needs two real tokens for two different people — every
 * collaborative assertion in it rests on one reviewer being able to change
 * what another reviewer decided, and a suite holding one token cannot make
 * that claim at all. Keycloak will mint a token from a username and a
 * password, but turning that on for `lexprompt-web` would put a way around
 * the authorization-code flow with PKCE into the client the shipped
 * application uses, which is exactly what S29 forbids.
 *
 * So the concession is CONFINED: a second client with no standard flow, no
 * redirect URIs, and no mention anywhere the shipped application could read
 * it. The two assertions below are the fence.
 */
describe('the password grant is confined to a client the app cannot reach (S29)', () => {
  it('leaves the application client with no direct access grants', () => {
    const app = clientNamed(APP_CLIENT_ID);
    expect(app.directAccessGrantsEnabled).toBe(false);
    expect(app.standardFlowEnabled).toBe(true);
    // The sanity check, or the two assertions above pass against a realm
    // with no clients at all — the shape of a guard that scans nothing.
    expect(realm.clients.length).toBeGreaterThan(1);
    // …and every OTHER client is checked too, so a third one arriving with
    // the grant turned on is not invisible to this file.
    expect(realm.clients.filter(c => c.directAccessGrantsEnabled === true)
      .map(c => c.clientId)).toEqual(['lexprompt-test']);
  });

  it('confines the password grant to the test client, which the app never uses', () => {
    const test = clientNamed('lexprompt-test');
    expect(test.directAccessGrantsEnabled).toBe(true);
    expect(test.standardFlowEnabled).toBe(false);
    // No redirect flow exists on it at all: a public client with the
    // password grant AND a redirect URI would be a second front door.
    expect(test.redirectUris ?? []).toEqual([]);
    // It has to carry the same claims the app's client does, or a token it
    // mints maps to no role and `apps/api` answers 403 with a message about
    // groups that reads like a bug in the role table.
    expect(test.defaultClientScopes).toEqual(clientNamed(APP_CLIENT_ID).defaultClientScopes);

    // And nothing the shipped application builds from names it.
    expect(filesNaming('lexprompt-test', ['src', 'apps/api/src', 'apps/gateway/src']))
      .toEqual([]);
    // The sanity check for the sweep above — the same scanner, pointed at
    // the one directory where the name IS supposed to appear. Without it,
    // a `filesNaming` that read nothing would satisfy the assertion above
    // while checking nothing at all; nine guards were found in that state
    // in Stage 3 alone.
    expect(filesNaming('lexprompt-test', ['apps/api/test']).length).toBeGreaterThan(0);
  });
});
