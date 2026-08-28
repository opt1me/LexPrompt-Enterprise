import { assertIssuerUsable, type AuthConfig } from './oidc.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ApiConfig {
  port: number;
  auth: AuthConfig;
  /** Where `apps/api` forwards a validated call. mTLS in compose, the
   *  gateway's Azure-internal URL in a firm deployment — never read by
   *  anything but the (Stage 2) proxy path this config feeds. */
  gatewayUrl: string;
  /** The single workspace §6 seeds. Stage 1 is honestly single-user: there
   *  is no workspace resolution here, only the one configured value. */
  workspaceId: string;
  /** The client certificate this process presents to the gateway when the
   *  gateway is configured for `GATEWAY_CALLER_AUTH=mtls` (local compose).
   *  Absent in a firm deployment, where the gateway trusts this process's
   *  managed identity instead. */
  mtls?: { caFile: string; certFile: string; keyFile: string };
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number; got ${JSON.stringify(raw)}.`);
  }
  return n;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(
      `${name} is not set. The API will not start without it.`,
    );
  }
  return value;
}

/**
 * `API_REQUIRED_CLAIMS` is a comma-separated list of `claim=value` pairs —
 * `tid=<tenant id>` for Entra, empty for Keycloak. Compared generically by
 * `makeTokenVerifier` (S28): this parser has no idea what the claim names
 * mean, which is the point.
 */
function parseRequiredClaims(raw: string | undefined): Record<string, string> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  const claims: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError(
        `API_REQUIRED_CLAIMS entry ${JSON.stringify(pair)} is not "claim=value".`,
      );
    }
    const claim = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!claim || !value) {
      throw new ConfigError(
        `API_REQUIRED_CLAIMS entry ${JSON.stringify(pair)} is not "claim=value".`,
      );
    }
    claims[claim] = value;
  }
  return claims;
}

function parseAuth(env: NodeJS.ProcessEnv): AuthConfig {
  const issuer = required(env, 'API_ISSUER');
  // S29: refused here, at load, so a deployed environment pointed at a
  // development issuer is a startup failure rather than a system that runs
  // and mostly works.
  assertIssuerUsable(issuer);
  return {
    issuer,
    audience: required(env, 'API_AUDIENCE'),
    subjectClaim: env.API_SUBJECT_CLAIM || 'sub',
    groupsClaim: env.API_GROUPS_CLAIM || 'groups',
    requiredClaims: parseRequiredClaims(env.API_REQUIRED_CLAIMS),
  };
}

function parseMtls(env: NodeJS.ProcessEnv): ApiConfig['mtls'] {
  const caFile = env.API_MTLS_CA_FILE;
  const certFile = env.API_MTLS_CERT_FILE;
  const keyFile = env.API_MTLS_KEY_FILE;
  if (!caFile && !certFile && !keyFile) return undefined;
  return {
    caFile: required(env, 'API_MTLS_CA_FILE'),
    certFile: required(env, 'API_MTLS_CERT_FILE'),
    keyFile: required(env, 'API_MTLS_KEY_FILE'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return {
    port: int(env, 'API_PORT', 8080),
    auth: parseAuth(env),
    gatewayUrl: required(env, 'API_GATEWAY_URL'),
    workspaceId: required(env, 'API_WORKSPACE_ID'),
    mtls: parseMtls(env),
  };
}

/** The boot banner — printed every start, mirroring the gateway's, so a
 *  misrouted deployment shows up in the first screen of logs. */
export function describeConfig(cfg: ApiConfig): string {
  return [
    `LexPrompt api — issuer=${cfg.auth.issuer}`,
    `Audience: ${cfg.auth.audience}`,
    `Workspace: ${cfg.workspaceId}`,
    `Gateway: ${cfg.gatewayUrl}${cfg.mtls ? ' (mTLS)' : ''}`,
  ].join('\n');
}
