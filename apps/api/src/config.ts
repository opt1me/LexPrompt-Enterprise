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
  /**
   * The largest request body this hop accepts, DECLARED rather than
   * inherited (M5).
   *
   * Fastify's default is 1 MiB. The gateway declares its own limit from
   * `GATEWAY_MAX_PROMPT_CHARS` (400,000 chars × 4 = 1,600,000 bytes by
   * default), so with nothing set here the MIDDLE hop was the tightest one
   * in the chain — and it was tighter by an amount no administrator was
   * told about and no `GATEWAY_*` key could raise, because `apps/api` does
   * not read one and structurally must not.
   *
   * What rides in the body is why that mattered. `InferRequest.images`
   * carries base64 page images, and the gateway's size check counts text
   * only, so a multi-page SCANNED document — this project's founding defect
   * lives on that path — passed the limit the operator configured and died
   * at the one nobody declared, as a raw `FST_ERR_CTP_BODY_TOO_LARGE` in
   * Fastify's own envelope, which the browser's client cannot even parse
   * into a code.
   *
   * Whether image bytes should count toward the gateway's declared prompt
   * limit at all is a separate question and an owner's to answer; this
   * value only stops `apps/api` from being a silent, tighter, unnamed cap.
   */
  maxBodyBytes: number;
  /** The app role's connection. Every request runs as `lexprompt_app`, which
   *  by design cannot UPDATE or DELETE a published playbook version (P10).
   *  Set in BOTH environments — the value differs, the key does not — so
   *  this is `sameEverywhere` and not a §5.1 divergence. */
  databaseUrl: string;
  /** The migrator role's connection, used ONLY by `runMigrations` at startup
   *  and by nothing else. It owns the schema; the app role does not. Two
   *  roles is what makes an immutability grant a fact about the database
   *  rather than a fact about the code that happens not to write. */
  databaseMigrationUrl: string;
  databasePoolMax: number;
}

/**
 * 16 MiB — ten times the gateway's default text cap, chosen so a scanned
 * document's page images are not refused by the hop that never counted them.
 *
 * Not zero-cost and not arbitrary: a body this size is accepted only from a
 * caller that has already passed `requireUser`, so it is a signed-in member
 * of the firm, and the value is named in the refusal when it is exceeded.
 */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // `Number.isInteger`, not `Number.isFinite`: a port of 1.5 is finite and
  // positive, so it passed this check and failed later inside `listen` —
  // past the startup banner this loader exists to fail in front of.
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${name} must be a positive whole number; got ${JSON.stringify(raw)}.`,
    );
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
  // Defaults to the issuer, so Azure — where Entra is publicly reachable and
  // the two addresses coincide — configures nothing extra, and so this key
  // being absent means exactly what it meant before the key existed.
  //
  // Held to the SAME S29 refusal as the issuer, and that is not tidiness: it
  // is the address the SIGNING KEYS are fetched from, so an operator who
  // could point it anywhere could point it at a key set of their own and
  // sign a token carrying any `iss` they liked. It is at least as
  // security-relevant as the issuer string it is allowed to differ from.
  const discoveryUrl = env.API_DISCOVERY_URL || issuer;
  assertIssuerUsable(discoveryUrl, 'discovery URL');
  return {
    issuer,
    discoveryUrl,
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
    maxBodyBytes: int(env, 'API_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    databaseUrl: required(env, 'API_DATABASE_URL'),
    databaseMigrationUrl: required(env, 'API_DATABASE_MIGRATION_URL'),
    databasePoolMax: int(env, 'API_DATABASE_POOL_MAX', 10),
  };
}

/** A DSN in a log line must never carry its password. `postgres://u:p@h/db`
 *  becomes `postgres://u@h/db`. Returned verbatim when it does not parse,
 *  because a malformed DSN is worth seeing in full at boot and there is no
 *  password in it to leak — it is not a DSN. */
export function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    url.password = '';
    return url.toString();
  } catch {
    return dsn;
  }
}

/** The boot banner — printed every start, mirroring the gateway's, so a
 *  misrouted deployment shows up in the first screen of logs. */
export function describeConfig(cfg: ApiConfig): string {
  return [
    `LexPrompt api — issuer=${cfg.auth.issuer}`,
    // Printed only when it DIFFERS, and printed at all because C1's symptom
    // was invisible: the issuer this process demands and the address it
    // fetches keys from were one line of configuration pretending to be one
    // fact. A reader of these four lines can now see both.
    ...(cfg.auth.discoveryUrl === cfg.auth.issuer
      ? []
      : [`Keys discovered at: ${cfg.auth.discoveryUrl} (same issuer, reachable address)`]),
    `Audience: ${cfg.auth.audience}`,
    `Workspace: ${cfg.workspaceId}`,
    `Gateway: ${cfg.gatewayUrl}${cfg.mtls ? ' (mTLS)' : ''}`,
    `Max request body: ${cfg.maxBodyBytes} bytes`,
    `Database: ${redactDsn(cfg.databaseUrl)}`,
  ].join('\n');
}
