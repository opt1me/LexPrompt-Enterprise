import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type CryptoKey } from 'jose';
import { makeTokenVerifier, assertIssuerUsable, type AuthConfig } from '../src/oidc.ts';

const ENTRA: AuthConfig = {
  issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  audience: 'api://lexprompt',
  subjectClaim: 'oid',
  groupsClaim: 'groups',
  requiredClaims: { tid: '11111111-1111-1111-1111-111111111111' },
};

const KEYCLOAK: AuthConfig = {
  issuer: 'https://keycloak.local/realms/lexprompt',
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
    await expect(verify()(await entraToken() && await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, otherKey)))
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
    await expect(verify()(await entraToken({}, ) && await sign(ENTRA,
      { oid: 'o', tid: ENTRA.requiredClaims.tid }, privateKey, '-1m')))
      .rejects.toMatchObject({ code: 'sign_in_required' });
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
});

// S29's absence, mutation-tested in Step 7 and asserted here at rest.
describe('there is no authentication bypass anywhere in apps/api', () => {
  it('no source file mentions a bypass flag, an anonymous mode or a trusted header', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const SRC = path.resolve(__dirname, '../src');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const bad of ['SKIP_AUTH', 'DISABLE_AUTH', 'ALLOW_ANONYMOUS', 'x-trusted-user', 'AUTH_BYPASS']) {
        if (text.includes(bad)) offenders.push(`${path.basename(file)} mentions ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
