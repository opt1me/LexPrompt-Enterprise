import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, errors, type CryptoKey,
} from 'jose';
import {
  makeTokenVerifier, assertIssuerUsable, discoverJwks, type AuthConfig,
} from '../src/oidc.ts';
import { walk, codeOf } from './sourceScan.ts';
import { buildTestApi } from './helpers/apiHarness.ts';

const ENTRA: AuthConfig = {
  issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  // In a tenant the issuer IS reachable, so the two coincide — which is why
  // `config.ts` defaults this to the issuer and Azure configures nothing.
  discoveryUrl: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  audience: 'api://lexprompt',
  subjectClaim: 'oid',
  groupsClaim: 'groups',
  requiredClaims: { tid: '11111111-1111-1111-1111-111111111111' },
};

const KEYCLOAK: AuthConfig = {
  issuer: 'https://keycloak.local/realms/lexprompt',
  discoveryUrl: 'https://keycloak.local/realms/lexprompt',
  audience: 'lexprompt-api',
  subjectClaim: 'sub',
  groupsClaim: 'groups',
  requiredClaims: {},
};

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

const sign = (cfg: AuthConfig, claims: Record<string, unknown>, key?: CryptoKey, expIn = '10m') =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(cfg.issuer).setAudience(cfg.audience)
    .setIssuedAt().setExpirationTime(expIn)
    .sign(key ?? privateKey);

const entraToken = (over: Record<string, unknown> = {}) => sign(ENTRA, {
  tid: '11111111-1111-1111-1111-111111111111',
  oid: 'oid-1', groups: ['group-a'], name: 'A. Gray', preferred_username: 'a@firm.com', ...over,
});

const keycloakToken = (over: Record<string, unknown> = {}) => sign(KEYCLOAK, {
  sub: 'kc-sub-1', groups: ['/reviewers'], name: 'A. Trainee', email: 't@firm.local', ...over,
});

describe('one code path, two issuers (§7, S28)', () => {
  it('validates an Entra token and reads oid as the subject', async () => {
    expect(await makeTokenVerifier(ENTRA, jwks)(await entraToken())).toEqual({
      issuer: ENTRA.issuer, subject: 'oid-1', groups: ['group-a'],
      name: 'A. Gray', email: 'a@firm.com',
    });
  });

  it('validates a Keycloak token and reads sub as the subject, with the SAME function', async () => {
    expect(await makeTokenVerifier(KEYCLOAK, jwks)(await keycloakToken())).toEqual({
      issuer: KEYCLOAK.issuer, subject: 'kc-sub-1', groups: ['/reviewers'],
      name: 'A. Trainee', email: 't@firm.local',
    });
  });

  // The point of S28: neither issuer's token is accepted by the other's
  // configuration, and it is the SAME code refusing both.
  it('rejects a Keycloak token under the Entra configuration, and the reverse', async () => {
    await expect(makeTokenVerifier(ENTRA, jwks)(await keycloakToken()))
      .rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(makeTokenVerifier(KEYCLOAK, jwks)(await entraToken()))
      .rejects.toMatchObject({ code: 'sign_in_required' });
  });
});

describe('token validation', () => {
  const verify = () => makeTokenVerifier(ENTRA, jwks);

  it('rejects a token signed by another key', async () => {
    // m11: this used to read `await entraToken() && await sign(...)` — the
    // first token was minted, discarded, and the `&&` yielded the second. It
    // read as though both participated in the assertion. Only one ever did.
    const wrongKey = await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, otherKey);
    await expect(verify()(wrongKey))
      .rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
  });

  // Isolates the issuer check from the audience check: the two fixture
  // configs above also differ in audience, so a token signed for the wrong
  // issuer is already caught by jose's audience comparison even if the
  // issuer were never checked at all. This test signs a token whose
  // audience DOES match, so only a real issuer check can reject it.
  it('rejects a token minted by another issuer, even when the audience matches', async () => {
    const otherIssuerSameAudience = await new SignJWT({
      oid: 'oid-1', tid: ENTRA.requiredClaims.tid,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0')
      .setAudience(ENTRA.audience)
      .setIssuedAt().setExpirationTime('10m')
      .sign(privateKey);
    await expect(verify()(otherIssuerSameAudience)).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('rejects a token for another audience', async () => {
    const t = await new SignJWT({ oid: 'o', tid: ENTRA.requiredClaims.tid })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ENTRA.issuer).setAudience('api://something-else')
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    await expect(verify()(t)).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('rejects an expired token', async () => {
    const expired = await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, privateKey, '-1m');
    await expect(verify()(expired)).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  // The tenant check, as a CONFIGURED required claim rather than a code
  // branch. This test is the difference between "never special-cases Entra"
  // being true and being intended.
  it('rejects a token whose required claim does not match', async () => {
    await expect(verify()(await entraToken({ tid: '22222222-2222-2222-2222-222222222222' })))
      .rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('enforces required claims generically, not just tid', async () => {
    const cfg = { ...KEYCLOAK, requiredClaims: { realm: 'lexprompt' } };
    await expect(makeTokenVerifier(cfg, jwks)(await sign(cfg, { sub: 's', realm: 'other' })))
      .rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(makeTokenVerifier(cfg, jwks)(await sign(cfg, { sub: 's', realm: 'lexprompt' })))
      .resolves.toMatchObject({ subject: 's' });
  });

  it('rejects a token missing the configured subject claim, rather than inventing an actor', async () => {
    await expect(verify()(await sign(ENTRA, { tid: ENTRA.requiredClaims.tid })))
      .rejects.toThrow(/oid/);
  });

  it('rejects an empty or malformed token without throwing something unhandled', async () => {
    await expect(verify()('')).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(verify()('not.a.token')).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('never puts the token into the error message', async () => {
    const token = await sign(ENTRA, { oid: 'o' }, otherKey);
    await expect(verify()(token)).rejects.not.toThrow(new RegExp(token.slice(0, 24)));
  });
});

// ===================================================================
// Entra group overage (§7). Keycloak CANNOT reproduce this — no seeded
// user is in enough groups — so this is a unit test over a crafted token,
// and it is the clearest case in Stage 1 where a green local run proves
// nothing about the tenant.
// ===================================================================
describe('group overage is its own error, never "in no mapped group"', () => {
  const verify = () => makeTokenVerifier(ENTRA, jwks);

  it('reports overage when the groups claim is ABSENT and _claim_names points at it', async () => {
    const t = await entraToken({
      groups: undefined,
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/oid-1/getMemberObjects' } },
    });
    await expect(verify()(t)).rejects.toMatchObject({ code: 'group_overage', status: 403 });
  });

  it('names overage and tells the user to contact an admin, not to sign in again', async () => {
    const t = await entraToken({ groups: undefined, _claim_names: { groups: 'src1' } });
    await expect(verify()(t)).rejects.toThrow(/too many groups[\s\S]*administrator/i);
  });

  // The distinction the whole case exists for. Three states, three outcomes.
  it('an EMPTY groups array is not overage — it is genuinely no groups', async () => {
    const p = await verify()(await entraToken({ groups: [] }));
    expect(p.groups).toEqual([]);
  });

  it('an ABSENT groups claim with no _claim_names is not overage either', async () => {
    const p = await verify()(await entraToken({ groups: undefined }));
    expect(p.groups).toEqual([]);
  });

  it('a populated groups claim is neither', async () => {
    const p = await verify()(await entraToken({ groups: ['a', 'b'] }));
    expect(p.groups).toEqual(['a', 'b']);
  });

  it('detects overage on any configured groups claim name, not just "groups"', async () => {
    const cfg = { ...ENTRA, groupsClaim: 'roles' };
    const t = await sign(cfg, {
      oid: 'o', tid: cfg.requiredClaims.tid, _claim_names: { roles: 'src1' },
    });
    await expect(makeTokenVerifier(cfg, jwks)(t))
      .rejects.toMatchObject({ code: 'group_overage' });
  });
});

// ===================================================================
// C1: keys are fetched from the address this process can REACH, while the
// issuer string that is validated stays the one the browser saw.
//
// `discoverJwks` takes the whole `AuthConfig` rather than a string so that
// `discoverJwks(config.auth.issuer)` cannot compile — a `string` parameter
// is a seam a caller can close by accident, and `main.ts` has no test under
// it. These tests hold the behaviour; the signature holds the call site.
// ===================================================================
describe('discovery is fetched from discoveryUrl, never from the issuer (C1)', () => {
  const SPLIT: AuthConfig = {
    ...KEYCLOAK,
    issuer: 'http://localhost:8088/realms/lexprompt',
    discoveryUrl: 'http://keycloak:8080/realms/lexprompt',
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches the well-known document at the DISCOVERY address', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        json: async () => ({
          jwks_uri: 'http://keycloak:8080/realms/lexprompt/protocol/openid-connect/certs',
        }),
      };
    });
    await discoverJwks(SPLIT);
    expect(seen).toEqual([
      'http://keycloak:8080/realms/lexprompt/.well-known/openid-configuration',
    ]);
    expect(seen[0]).not.toContain('localhost:8088');
  });

  it('falls back to the issuer\'s own address when the two coincide', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return { ok: true, json: async () => ({ jwks_uri: 'https://keycloak.local/certs' }) };
    });
    await discoverJwks(KEYCLOAK);
    expect(seen).toEqual([
      'https://keycloak.local/realms/lexprompt/.well-known/openid-configuration',
    ]);
  });

  // m5: no signal meant a hung issuer hung startup before `app.listen`, so
  // the process was alive and answering nothing — `/healthz` included.
  it('bounds the fetch with a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: { signal?: AbortSignal }) => {
      signal = init?.signal;
      return { ok: true, json: async () => ({ jwks_uri: 'https://keycloak.local/certs' }) };
    });
    await discoverJwks(KEYCLOAK);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('names the address it could not reach, rather than throwing a bare fetch error', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    await expect(discoverJwks(SPLIT)).rejects.toThrow(/keycloak:8080/);
    await expect(discoverJwks(SPLIT)).rejects.toThrow(/will not start/);
  });

  it('refuses a discovery document that names no jwks_uri', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }));
    await expect(discoverJwks(SPLIT)).rejects.toThrow(/jwks_uri/);
  });
});

// ===================================================================
// M2: "could not complete the check" is not "completed and found nobody".
//
// `jwtVerify` resolves the key set INSIDE the try, so a JWKS endpoint that
// is down, a key rotated inside jose's cooldown, a DNS failure in the
// container and a malformed JWKS all used to land in the same branch as an
// expired token — and every user in the firm was told, simultaneously, that
// THEIR sign-in could not be verified and to sign in again. Restarting the
// identity provider produced a support queue pointed at the wrong thing.
// ===================================================================
describe('an unreachable or unreadable key set is not a bad sign-in (M2)', () => {
  /** A `JWTVerifyGetKey` that fails the way a network does. */
  const brokenKeys = (err: Error) => (async () => { throw err; }) as never;

  it('answers a JWKS fetch failure with service_misconfigured, not sign_in_required', async () => {
    const verify = makeTokenVerifier(ENTRA, brokenKeys(new TypeError('fetch failed')));
    await expect(verify(await entraToken()))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('says the user\'s sign-in is not the problem, and never says "sign in again"', async () => {
    const verify = makeTokenVerifier(ENTRA, brokenKeys(new TypeError('fetch failed')));
    await expect(verify(await entraToken())).rejects.toThrow(/not the problem/i);
    await expect(verify(await entraToken())).rejects.not.toThrow(/sign in again/i);
  });

  it('treats a rotated signing key (JWKSNoMatchingKey) as infrastructure, not as the user', async () => {
    const verify = makeTokenVerifier(ENTRA, brokenKeys(new errors.JWKSNoMatchingKey()));
    await expect(verify(await entraToken()))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('treats a JWKS timeout and a malformed JWKS the same way', async () => {
    for (const err of [new errors.JWKSTimeout(), new errors.JWKSInvalid('bad')]) {
      const verify = makeTokenVerifier(ENTRA, brokenKeys(err));
      await expect(verify(await entraToken()), err.name)
        .rejects.toMatchObject({ code: 'service_misconfigured' });
    }
  });

  // The other half. If everything became 503 the distinction would be lost
  // in the opposite direction, and a genuinely expired token would be
  // reported as the firm's problem.
  it('still answers a REAL token fault with sign_in_required', async () => {
    const verify = makeTokenVerifier(ENTRA, jwks);
    // expired
    await expect(verify(await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, privateKey, '-1m')))
      .rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
    // wrong signature
    await expect(verify(await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, otherKey)))
      .rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
    // wrong issuer
    await expect(verify(await keycloakToken()))
      .rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
    // malformed
    await expect(verify('not.a.token')).rejects.toMatchObject({ code: 'sign_in_required' });
  });
});

// m3: an unreadable groups claim is not an empty one.
describe('the groups claim is read, or refused — never silently emptied (m3)', () => {
  const verify = () => makeTokenVerifier(ENTRA, jwks);

  it('reads a bare-string groups claim as the one group it is', async () => {
    const p = await verify()(await entraToken({ groups: 'group-a' }));
    expect(p.groups).toEqual(['group-a']);
  });

  it('refuses a groups claim in a shape it cannot read, rather than reporting no groups', async () => {
    await expect(verify()(await entraToken({ groups: 42 })))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
    await expect(verify()(await entraToken({ groups: { a: 1 } })))
      .rejects.toThrow(/cannot read/i);
  });

  it('still reads an array, and still reads an absent claim as no groups', async () => {
    expect((await verify()(await entraToken({ groups: ['a', 'b'] }))).groups).toEqual(['a', 'b']);
    expect((await verify()(await entraToken({ groups: undefined }))).groups).toEqual([]);
  });
});

describe('the API refuses to start on an unusable issuer (S29)', () => {
  it('refuses an empty issuer', () => {
    expect(() => assertIssuerUsable('')).toThrow(/no issuer/i);
  });

  it('refuses a non-HTTPS issuer that is not loopback', () => {
    expect(() => assertIssuerUsable('http://idp.example.com/realms/x'))
      .toThrow(/https[\s\S]*loopback/i);
  });

  it('allows http on loopback, which is what compose serves', () => {
    expect(() => assertIssuerUsable('http://localhost:8088/realms/lexprompt')).not.toThrow();
    expect(() => assertIssuerUsable('http://127.0.0.1:8088/realms/lexprompt')).not.toThrow();
    expect(() => assertIssuerUsable('http://keycloak:8080/realms/lexprompt')).not.toThrow();
  });

  it('allows any https issuer', () => {
    expect(() => assertIssuerUsable('https://login.microsoftonline.com/t/v2.0')).not.toThrow();
  });

  // m4: `!host.includes('.')` is TRUE of the empty string, so every
  // hostless URL scheme walked through the S29 refusal and failed later, at
  // the discovery fetch, as an unhandled rejection with a stack instead of
  // the banner this check exists to produce.
  it('refuses a scheme that is not http or https, however hostless', () => {
    for (const bad of ['file:///etc/passwd', 'data:text/plain,x', 'ftp://issuer/realm']) {
      expect(() => assertIssuerUsable(bad), bad).toThrow(/scheme/i);
    }
  });

  // The discovery URL is held to the same rule, and says so when it fails:
  // it is the address the SIGNING KEYS come from.
  it('names what it is refusing, so a discovery URL failure is not read as an issuer one', () => {
    expect(() => assertIssuerUsable('http://idp.example.com/x', 'discovery URL'))
      .toThrow(/discovery URL/);
    expect(() => assertIssuerUsable('', 'discovery URL')).toThrow(/no discovery URL/i);
  });
});

// ===================================================================
// S29's absence. THE CLAIM IS "there is no authentication bypass anywhere in
// apps/api", and it used to be tested by grepping five literal strings —
// SKIP_AUTH, DISABLE_AUTH, ALLOW_ANONYMOUS, x-trusted-user, AUTH_BYPASS.
//
// A five-word denylist cannot support that sentence. Adding this to
// `requireUser`, above the Authorization read, passed every guard on the
// branch:
//
//     const impersonate = req.headers['x-lexprompt-actor'];
//     if (typeof impersonate === 'string') {
//       req.principal = { issuer: 'local', subject: impersonate, groups: [] };
//       return;
//     }
//
// — green here (none of the five words appear), green in configSurface (it
// reads a header, not the environment), and green in both "no token -> 401"
// tests, which send no header either. A client could name any colleague as
// the actor on every call in the firm's audit log: the single failure this
// service exists to prevent.
//
// So the guard is now structural and behavioural rather than lexical. The
// word list stays as a third layer, but nothing rests on it.
// ===================================================================
describe('there is no authentication bypass anywhere in apps/api', () => {
  const SRC = path.resolve(__dirname, '../src');

  // (1) STRUCTURAL: a principal has exactly one origin.
  //
  // `req.principal` is what every route trusts. If it is written in exactly
  // one place, and that place is the return value of `verify()`, then there
  // is no second path by which a caller-controlled value becomes an actor —
  // whatever it is spelled. The impersonation mutation above adds a second
  // assignment and fails here on the count alone.
  it('writes req.principal in exactly ONE place, and only from verify()', () => {
    const writes: string[] = [];
    for (const file of walk(SRC)) {
      const code = codeOf(file);
      for (const line of code.split(/\r?\n/)) {
        if (/\.principal\s*=[^=]/.test(line)) writes.push(`${path.basename(file)}: ${line.trim()}`);
      }
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^server\.ts: /);
    expect(writes[0]).toContain('await verify(');
  });

  // (2) BEHAVIOURAL: every route refuses an unauthenticated caller, whatever
  // else that caller sends.
  //
  // The routes are DISCOVERED from the source rather than listed, so a route
  // added tomorrow is covered the day it is written — and the hostile
  // headers are sent on every one of them, so a bypass keyed off any of them
  // turns a 401 into a 200 here. This is also the test m12 asked for:
  // `/v1/infer/stream`, the route that bypasses Fastify's reply machinery
  // entirely, had nothing pinning its 401.
  const HOSTILE_HEADERS = {
    'x-lexprompt-actor': 'sub-a-colleague',
    'x-trusted-user': 'sub-a-colleague',
    'x-forwarded-user': 'sub-a-colleague',
    'x-remote-user': 'sub-a-colleague',
    'x-user-id': 'sub-a-colleague',
    'x-auth-request-user': 'sub-a-colleague',
  };

  const routes = (): { method: string; url: string }[] => {
    const found: { method: string; url: string }[] = [];
    for (const file of walk(SRC)) {
      for (const m of codeOf(file).matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        found.push({ method: m[1].toUpperCase(), url: m[2] });
      }
    }
    return found;
  };

  // `/healthz` is the ONE exclusion, by URL, in `buildServer`'s own hook —
  // named here so it cannot grow into a list quietly.
  const AUTH_EXEMPT = ['/healthz'];

  it('discovers the routes it is about to check, so it cannot pass vacuously', () => {
    const urls = routes().map(r => `${r.method} ${r.url}`).sort();
    expect(urls).toEqual([
      'GET /healthz',
      'GET /v1/models',
      'POST /v1/infer',
      'POST /v1/infer/stream',
    ]);
  });

  it('refuses EVERY non-health route with 401 when no token is sent, whatever headers are', async () => {
    const checked: string[] = [];
    for (const route of routes()) {
      if (AUTH_EXEMPT.includes(route.url)) continue;
      const { app, calls } = buildTestApi({ principal: null });
      const res = await app.inject({
        method: route.method as 'GET', url: route.url,
        headers: HOSTILE_HEADERS,
        ...(route.method === 'POST'
          ? { payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi',
                         actorSubject: 'sub-a-colleague', actorIssuer: 'https://evil.example' } }
          : {}),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.json(), `${route.method} ${route.url}`)
        .toMatchObject({ error: { code: 'sign_in_required' } });
      expect(calls.infer, `${route.method} ${route.url}`).toHaveLength(0);
      expect(calls.stream, `${route.method} ${route.url}`).toHaveLength(0);
      checked.push(`${route.method} ${route.url}`);
    }
    expect(checked).toHaveLength(3);
  });

  it('answers /healthz without a token — the one exemption, and it reaches no gateway', async () => {
    const { app, calls } = buildTestApi({ principal: null });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(calls.infer).toHaveLength(0);
  });

  // (3) The original word list, kept as a cheap third layer — but over
  // `codeOf`, so a comment explaining that SKIP_AUTH must never exist is not
  // itself a build failure (m10, and `sourceScan.ts`'s own docstring).
  it('no source file mentions a bypass flag, an anonymous mode or a trusted header', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = codeOf(file);
      for (const bad of ['SKIP_AUTH', 'DISABLE_AUTH', 'ALLOW_ANONYMOUS', 'x-trusted-user', 'AUTH_BYPASS']) {
        if (code.includes(bad)) offenders.push(`${path.basename(file)} mentions ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
