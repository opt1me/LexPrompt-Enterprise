import { describe, it, expect } from 'vitest';
import {
  loadConfig, ConfigError, describeConfig, DEFAULT_MAX_BODY_BYTES,
} from '../src/config.ts';

/**
 * `config.ts` shipped with no tests at all, which matters more here than it
 * would elsewhere: this loader is where S29's issuer refusal actually runs.
 * A refusal nothing exercises is a refusal nobody would notice losing.
 */
const BASE = {
  API_ISSUER: 'https://login.microsoftonline.com/tid/v2.0',
  API_AUDIENCE: 'api://lexprompt',
  API_GATEWAY_URL: 'https://gateway.internal',
  API_WORKSPACE_ID: 'ws-1',
  API_DATABASE_URL: 'postgres://lexprompt_app:app-dev@postgres:5432/lexprompt',
  // The ENGINE's own connection, on the third role (Stage 3 Task 10). It has
  // no default and no fallback to API_DATABASE_URL on purpose: the app role
  // can write a disposition and lexprompt_worker cannot, so a fallback would
  // give the review engine back the ability to overwrite a lawyer's
  // verification with every test in this repository still green.
  API_WORKER_DATABASE_URL: 'postgres://lexprompt_worker:worker-dev@postgres:5432/lexprompt',
  API_DATABASE_MIGRATION_URL: 'postgres://lexprompt_migrator:migrator-dev@postgres:5432/lexprompt',
  // Required, with no default — see `roleMappingsFrom`. It is in BASE rather
  // than in each case because "the API refuses to start unset" is asserted in
  // roleMappingConfig.test.ts, where the refusal is the subject; here it is
  // just another key a complete configuration has to carry.
  API_ROLE_MAPPINGS: 'https://login.microsoftonline.com/tid/v2.0|reviewers|reviewer',
} as NodeJS.ProcessEnv;

describe('loadConfig (apps/api)', () => {
  it('reads a complete configuration and defaults what may be defaulted', () => {
    const cfg = loadConfig({ ...BASE });
    expect(cfg.port).toBe(8080);
    expect(cfg.auth.subjectClaim).toBe('sub');
    expect(cfg.auth.groupsClaim).toBe('groups');
    expect(cfg.auth.requiredClaims).toEqual({});
    expect(cfg.mtls).toBeUndefined();
  });

  // ---- C1: the issuer to VALIDATE and the address to FETCH KEYS FROM ----
  //
  // Two facts, and modelling them as one made the compose stack unable to
  // authenticate anybody: Keycloak stamps `iss` from the request host, so a
  // browser's token said `localhost:8088` while `api` — which can only reach
  // Keycloak as `keycloak:8080` on the internal network — was configured to
  // demand the second string. The signature verified; the issuer comparison
  // did not; every call returned 401 `sign_in_required` and the only remedy
  // the message named produced the same 401 again.
  it('defaults the discovery URL to the issuer, so a tenant configures nothing extra', () => {
    const cfg = loadConfig({ ...BASE });
    expect(cfg.auth.discoveryUrl).toBe(cfg.auth.issuer);
  });

  it('reads a discovery URL that DIFFERS from the issuer, which is the whole seam', () => {
    const cfg = loadConfig({
      ...BASE,
      API_ISSUER: 'http://localhost:8088/realms/lexprompt',
      API_DISCOVERY_URL: 'http://keycloak:8080/realms/lexprompt',
    });
    expect(cfg.auth.issuer).toBe('http://localhost:8088/realms/lexprompt');
    expect(cfg.auth.discoveryUrl).toBe('http://keycloak:8080/realms/lexprompt');
  });

  // The seam must not become a way around S29. The keys the API validates
  // with come from this address, so an operator who could point it anywhere
  // could sign a token carrying any `iss` at all.
  it('holds the discovery URL to the SAME refusal as the issuer', () => {
    expect(() => loadConfig({ ...BASE, API_DISCOVERY_URL: 'http://idp.example.com/x' }))
      .toThrow(/discovery URL/);
    expect(() => loadConfig({ ...BASE, API_DISCOVERY_URL: 'file:///etc/passwd' }))
      .toThrow(/discovery URL/);
  });

  // The security-relevant path: S29 refuses at load, so a deployment
  // pointed at a development issuer fails at startup rather than serving.
  it('refuses a missing issuer', () => {
    const env = { ...BASE }; delete env.API_ISSUER;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('refuses a plaintext issuer on a routable host, at load', () => {
    expect(() => loadConfig({ ...BASE, API_ISSUER: 'http://login.example.com/v2.0' }))
      .toThrow(/not https/i);
  });

  it('permits a plaintext loopback issuer, so local development runs', () => {
    const cfg = loadConfig({ ...BASE, API_ISSUER: 'http://localhost:8081/realms/lexprompt' });
    expect(cfg.auth.issuer).toBe('http://localhost:8081/realms/lexprompt');
  });

  it('permits a single-label container-network issuer, which compose needs', () => {
    const cfg = loadConfig({ ...BASE, API_ISSUER: 'http://keycloak:8080/realms/lexprompt' });
    expect(cfg.auth.issuer).toBe('http://keycloak:8080/realms/lexprompt');
  });

  it('refuses a missing audience, gateway URL or workspace', () => {
    for (const key of ['API_AUDIENCE', 'API_GATEWAY_URL', 'API_WORKSPACE_ID'] as const) {
      const env = { ...BASE }; delete env[key];
      expect(() => loadConfig(env), key).toThrow(ConfigError);
    }
  });

  // Each new required key refuses BY NAME when unset, exactly like the
  // existing required keys above — a database DSN that silently defaulted
  // to nothing would connect to nowhere with no explanation.
  it('refuses a missing database URL or migration URL, by name', () => {
    for (const key of [
      'API_DATABASE_URL', 'API_DATABASE_MIGRATION_URL', 'API_WORKER_DATABASE_URL',
    ] as const) {
      const env = { ...BASE }; delete env[key];
      expect(() => loadConfig(env), key).toThrow(ConfigError);
      expect(() => loadConfig(env), key).toThrow(new RegExp(key));
    }
  });

  it('defaults the database pool size, and reads an operator-set one', () => {
    expect(loadConfig({ ...BASE }).databasePoolMax).toBe(10);
    expect(loadConfig({ ...BASE, API_DATABASE_POOL_MAX: '25' }).databasePoolMax).toBe(25);
    expect(() => loadConfig({ ...BASE, API_DATABASE_POOL_MAX: '0' })).toThrow(ConfigError);
  });

  it('refuses a non-positive or non-numeric port rather than falling back', () => {
    // m15: `1.5` is finite and positive, so it used to pass this loader and
    // fail later inside `listen` — past the startup banner that exists so a
    // configuration fault is named where an operator will read it.
    for (const bad of ['0', '-1', 'eight', '1.5', '8080.5']) {
      expect(() => loadConfig({ ...BASE, API_PORT: bad }), bad).toThrow(ConfigError);
    }
  });

  // ---- M5: this hop declares its body limit rather than inheriting one ----
  it('declares a body limit larger than the gateway\'s own default text cap', () => {
    const cfg = loadConfig({ ...BASE });
    // Fastify's undeclared default is 1 MiB and the gateway accepts
    // GATEWAY_MAX_PROMPT_CHARS × 4 = 1,600,000 bytes by default, so anything
    // at or below 1 MiB makes the MIDDLE hop the tightest — and tightest by
    // an amount no GATEWAY_* key can raise, because apps/api does not read
    // one and structurally must not. Base64 page images from a scanned
    // document ride in this body and are not counted by the gateway's
    // text-only size check at all.
    expect(cfg.maxBodyBytes).toBeGreaterThan(1_600_000);
    expect(cfg.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it('reads an operator-set body limit, and refuses a nonsense one', () => {
    expect(loadConfig({ ...BASE, API_MAX_BODY_BYTES: '2000000' }).maxBodyBytes).toBe(2_000_000);
    expect(() => loadConfig({ ...BASE, API_MAX_BODY_BYTES: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, API_MAX_BODY_BYTES: 'lots' })).toThrow(ConfigError);
  });

  // A half-configured mTLS identity is worse than none: it reads as
  // "mTLS is on" while lacking the material to present a certificate.
  it('refuses a PARTIALLY configured mTLS identity rather than ignoring it', () => {
    expect(() => loadConfig({ ...BASE, API_MTLS_CA_FILE: '/certs/ca.pem' }))
      .toThrow(ConfigError);
    expect(() => loadConfig({
      ...BASE, API_MTLS_CA_FILE: '/certs/ca.pem', API_MTLS_CERT_FILE: '/certs/api.pem',
    })).toThrow(ConfigError);
  });

  it('reads a complete mTLS identity', () => {
    const cfg = loadConfig({
      ...BASE,
      API_MTLS_CA_FILE: '/certs/ca.pem',
      API_MTLS_CERT_FILE: '/certs/api.pem',
      API_MTLS_KEY_FILE: '/certs/api.key',
    });
    expect(cfg.mtls).toEqual({
      caFile: '/certs/ca.pem', certFile: '/certs/api.pem', keyFile: '/certs/api.key',
    });
  });

  it('parses required claims generically, and refuses a malformed entry', () => {
    expect(loadConfig({ ...BASE, API_REQUIRED_CLAIMS: 'tid=abc, foo=bar' }).auth.requiredClaims)
      .toEqual({ tid: 'abc', foo: 'bar' });
    for (const bad of ['tid', '=abc', 'tid=', 'tid=a,broken']) {
      expect(() => loadConfig({ ...BASE, API_REQUIRED_CLAIMS: bad }), bad).toThrow(ConfigError);
    }
  });

  it('never puts a certificate path or a secret in the boot banner beyond the flag', () => {
    const banner = describeConfig(loadConfig({
      ...BASE,
      API_MTLS_CA_FILE: '/certs/ca.pem',
      API_MTLS_CERT_FILE: '/certs/api.pem',
      API_MTLS_KEY_FILE: '/certs/api.key',
    }));
    expect(banner).toContain('(mTLS)');
    expect(banner).not.toContain('/certs/api.key');
  });

  // C1's symptom was invisible in the logs: the issuer this process demanded
  // and the address it fetched keys from were one line pretending to be one
  // fact. The banner shows both, and only when they differ.
  it('shows the discovery address in the banner when it differs from the issuer', () => {
    const split = describeConfig(loadConfig({
      ...BASE,
      API_ISSUER: 'http://localhost:8088/realms/lexprompt',
      API_DISCOVERY_URL: 'http://keycloak:8080/realms/lexprompt',
    }));
    expect(split).toContain('issuer=http://localhost:8088/realms/lexprompt');
    expect(split).toContain('http://keycloak:8080/realms/lexprompt');

    const same = describeConfig(loadConfig({ ...BASE }));
    expect(same).not.toMatch(/Keys discovered at/);
  });

  it('never prints a database password in the boot banner', () => {
    const cfg = loadConfig({ ...BASE, API_DATABASE_URL: 'postgres://app:hunter2@db:5432/lex' });
    const banner = describeConfig(cfg);
    // The positive assertion is what makes the negative one mean something:
    // without it, a banner that dropped the Database line entirely passes.
    expect(banner).toContain('postgres://app@db:5432/lex');
    expect(banner).not.toContain('hunter2');
  });
});
