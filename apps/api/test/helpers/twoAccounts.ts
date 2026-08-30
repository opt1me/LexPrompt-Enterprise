import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Role } from '@lexprompt/core';
import { ROOT } from '../sourceScan.ts';

/**
 * TWO REAL PEOPLE, HEADLESSLY.
 *
 * Every collaborative claim in Stage 4 rests on one reviewer being able to
 * change what another reviewer decided, and until this file existed the
 * repository could not produce a single signed-in request, let alone two by
 * different people. Stage 3's own report says it plainly: *"No request has
 * been made over HTTP as a signed-in user. The shipped realm has
 * `directAccessGrantsEnabled: false`."*
 *
 * ## Where the concession lives, and where it does not
 *
 * `lexprompt-web` — the client the shipped application signs in through —
 * keeps `directAccessGrantsEnabled: false`, and `keycloakRealm.test.ts`
 * asserts it. The password grant is on `lexprompt-test`, a client with no
 * standard flow, no redirect URIs and no mention in any source file under
 * `src/`, `apps/api/src` or `apps/gateway/src` — asserted in the same suite,
 * with the positive half of the pair pointed at this directory so a scanner
 * that read nothing would fail rather than pass.
 *
 * ## Two addresses, one issuer
 *
 * `KEYCLOAK_BASE` is the PUBLISHED address, `localhost:8088`, and it has to
 * be: `KC_HOSTNAME` pins the `iss` claim to that string whatever host a
 * request arrives on, and `apps/api` compares `iss` as an exact string
 * (`API_ISSUER: ${OIDC_ISSUER_BROWSER}`). A token obtained through
 * `keycloak:8080` would verify by signature and be refused by issuer — the
 * C1 failure, which presented as "Sign in again", forever.
 *
 * `API_BASE` goes through `web`'s nginx proxy, because `api` publishes no
 * port at all by construction (`docker-compose.yml`: `networks: [internal]`,
 * no `ports:`). There is no address at which `api` could be reached
 * directly from the host, and a helper that tried would fail with a
 * connection refused that names nothing.
 */
export const KEYCLOAK_BASE = 'http://localhost:8088';
export const REALM = 'lexprompt';
export const API_BASE = 'http://localhost:3005/api';

const TOKEN_URL = `${KEYCLOAK_BASE}/realms/${REALM}/protocol/openid-connect/token`;

interface RealmUser {
  username: string;
  credentials?: { type: string; value: string }[];
}

/**
 * The passwords, READ OUT OF THE REALM FILE rather than retyped here.
 *
 * A second copy of a credential is a copy that can drift, and the failure it
 * produces is a 400 from the token endpoint that reads identically to four
 * other causes. Reading the seed means the two cannot disagree.
 */
const PASSWORD_FOR: Record<string, string> = (() => {
  const realm = JSON.parse(readFileSync(
    path.join(ROOT, 'infra/keycloak/lexprompt-realm.json'), 'utf8',
  )) as { users: RealmUser[] };
  const out: Record<string, string> = {};
  for (const user of realm.users) {
    const password = user.credentials?.find(c => c.type === 'password')?.value;
    if (password) out[user.username] = password;
  }
  return out;
})();

export interface TestAccount {
  username: string;
  role: Role;
  token: string;
  /** The `app_user.id` — the API's OWN view of who this is, provisioned on
   *  first sight by `resolveActor`. NOT the Keycloak subject: every
   *  `*UserId` field in every record holds this one. */
  userId: string;
  displayName: string;
}

/**
 * One signed-in person, and a failure that says which of five things went
 * wrong.
 *
 * NOT `throw new Error(res.statusText)`. A 400 from the token endpoint means
 * the realm did not import, or the client is missing, or direct grants are
 * off, or the user does not exist, or the password here and the password in
 * the realm have drifted. Keycloak's body distinguishes them; a status line
 * does not, and the five repairs are not interchangeable.
 */
export async function signIn(username: string): Promise<TestAccount> {
  const password = PASSWORD_FOR[username];
  if (password === undefined) {
    throw new Error(
      `The seeded realm has no user "${username}". It seeds `
      + `${Object.keys(PASSWORD_FOR).join(', ')}.`);
  }
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'lexprompt-test',
    username,
    password,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Could not sign in as ${username} against ${TOKEN_URL}: ${res.status} ${await res.text()}`);
  }
  const { access_token: token } = await res.json() as { access_token: string };

  const me = await fetch(`${API_BASE}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!me.ok) {
    throw new Error(
      `Signed in as ${username} but ${API_BASE}/v1/me answered ${me.status}: ${await me.text()}`);
  }
  const who = await me.json() as { id: string; displayName: string; role: Role };
  return { username, role: who.role, token, userId: who.id, displayName: who.displayName };
}

/** The two people every collaborative assertion in this stage needs: a
 *  trainee in `reviewers` and a partner in `partners`. */
export async function twoAccounts(): Promise<{ trainee: TestAccount; partner: TestAccount }> {
  const [trainee, partner] = await Promise.all([signIn('trainee'), signIn('partner')]);
  return { trainee, partner };
}

/** A JSON request as one of them. Returns the `Response` rather than its
 *  body, because half the assertions in this stage are about a STATUS. */
export async function asUser(
  who: TestAccount, method: string, path_: string, body?: unknown,
): Promise<Response> {
  return fetch(`${API_BASE}${path_}`, {
    method,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
