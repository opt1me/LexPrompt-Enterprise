import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError, describeConfig } from '../src/config.ts';

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

  it('refuses a non-positive or non-numeric port rather than falling back', () => {
    for (const bad of ['0', '-1', 'eight']) {
      expect(() => loadConfig({ ...BASE, API_PORT: bad }), bad).toThrow(ConfigError);
    }
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
});
