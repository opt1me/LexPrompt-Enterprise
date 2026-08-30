import { assertIssuerUsable, type AuthConfig } from './oidc.ts';
import { parseRoleMappings, type RoleMapping } from './auth/roles.ts';
import type { BlobCredentialConfig } from './blob/credential.ts';

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
  /**
   * The issuer's group claim, mapped to LexPrompt's three roles (§6.5).
   *
   * THERE IS NO DEFAULT AND NONE IS SHIPPED. A default would be this
   * codebase guessing at a firm's directory, and the guess would be wrong in
   * the direction that grants access. `loadConfig` refuses an empty list for
   * the mirror-image reason: with no mapping, every user who signs in is
   * told they have no access, which is a stack that is up, healthy and
   * useless to the entire firm.
   *
   * Seeded into `role_mapping` at startup on the migrator connection, so a
   * mapping removed here is removed from the database too — see
   * `seedRoleMappings`.
   */
  roleMappings: RoleMapping[];
  /**
   * Where the firm's document BYTES live (§6.5), and which identity reaches
   * them.
   *
   * `source` is `connection-string` locally (Azurite, over the `internal`
   * network) and `managed-identity` in Azure, and there is NO FALLBACK
   * between the two — `resolveBlobCredential` refuses rather than trying the
   * other, for the reason written at length there. The keys are read here
   * and validated there, so this module stays a reader and the rule stays in
   * one place.
   *
   * `connectionString` and `accountUrl` are both optional HERE and required
   * by the source that names them: an Azure deployment sets no connection
   * string at all, and the local stack sets no account URL, which is §5.1
   * row 5's asymmetry rather than an oversight.
   */
  blob: BlobCredentialConfig & { container: string };
  /**
   * Spike 1's two knobs (§15, §19), for the code that renders a scanned
   * PDF's pages to images so a vision model can read them at all.
   *
   * Named here rather than hard-coded in `parse/pageImages.ts` because both
   * of them bound work done on behalf of a signed-in user against a document
   * whose size this service does not control, and an operator whose reviews
   * are timing out on a 300-page scan needs a value to change rather than a
   * rebuild.
   *
   * `pageRenderTimeoutMs` is a HARD budget: exceeding it throws
   * `PageRenderTimeoutError` and the document is reported unreadable, never
   * returned half-rendered. A partly-rendered scan reads to a model as a
   * document that is silent on everything the missing pages said, which is
   * this project's founding defect wearing a successful return value.
   *
   * `pageImageMaxPages` is a SOFT cap: the renderer reports
   * `renderedPages < totalPages` and its caller says so. §15's third key,
   * `API_PAGE_IMAGE_LRU_BYTES`, is deliberately NOT here — there is no cache
   * for it to size yet, and a configuration key that changes nothing is a
   * knob an operator turns and then trusts. It arrives in Task 9, with the
   * cache it bounds.
   */
  pageRenderTimeoutMs: number;
  pageImageMaxPages: number;
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

/**
 * `parseRoleMappings` lives in `auth/roles.ts` next to the lookup that reads
 * what it produces, and throws a plain `Error` so it does not have to import
 * the configuration module that imports it. Here is where that becomes the
 * one error type this process treats as "your configuration is wrong", which
 * is what `main.ts` turns into the startup banner.
 */
function roleMappingsFrom(env: NodeJS.ProcessEnv): RoleMapping[] {
  let mappings: RoleMapping[];
  try {
    mappings = parseRoleMappings(env.API_ROLE_MAPPINGS);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  // The same posture as the gateway's jurisdiction refusal (P4) and the
  // API's issuer refusal (S29): a misconfiguration must not become a system
  // that runs and mostly works.
  if (mappings.length === 0) {
    throw new ConfigError(
      'API_ROLE_MAPPINGS is not set. LexPrompt maps the issuer\'s group claim to its three '
      + 'roles, and with no mapping every user who signs in is told they have no access — '
      + 'a deployment that runs and refuses everybody. Set it to a comma-separated list of '
      + '"issuer|group|role", one per group your directory uses. The issuer in each entry '
      + 'must be the one this API validates (API_ISSUER), which locally is the address the '
      + 'BROWSER obtains its token from, not the container-network one.',
    );
  }
  return mappings;
}

/**
 * The blob keys, READ here and VALIDATED in `resolveBlobCredential`.
 *
 * `source` is passed through UNCHECKED on purpose: an unrecognised value is
 * refused by `resolveBlobCredential` with a message naming the key and the
 * two values it accepts, and duplicating that check here would be a second
 * place for the list of sources to live. There is no default — a missing
 * `API_BLOB_CREDENTIAL_SOURCE` arrives as `''`, which is not one of the two
 * and is refused as such.
 */
function blobFrom(env: NodeJS.ProcessEnv): ApiConfig['blob'] {
  return {
    source: (env.API_BLOB_CREDENTIAL_SOURCE ?? '') as ApiConfig['blob']['source'],
    connectionString: env.API_BLOB_CONNECTION_STRING,
    accountUrl: env.API_BLOB_ACCOUNT_URL,
    container: env.API_BLOB_CONTAINER || 'documents',
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
    roleMappings: roleMappingsFrom(env),
    blob: blobFrom(env),
    pageRenderTimeoutMs: int(env, 'API_PAGE_RENDER_TIMEOUT_MS', 120_000),
    pageImageMaxPages: int(env, 'API_PAGE_IMAGE_MAX_PAGES', 100),
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
    `Page rendering: up to ${cfg.pageImageMaxPages} page(s) in ${cfg.pageRenderTimeoutMs}ms`,
    `Database: ${redactDsn(cfg.databaseUrl)}`,
    // The SOURCE and the container, never the material. A connection string
    // carries an account key, and a boot banner is the last place it should
    // appear — but WHICH identity this process was configured to hold the
    // firm's documents with is exactly the fact an operator needs on the
    // first screen of logs, because a fallback is what this refuses to do
    // and a silent one is what they would otherwise be looking for.
    `Documents: ${cfg.blob.container} (credential: ${cfg.blob.source}`
      + `${cfg.blob.source === 'managed-identity' ? `, ${cfg.blob.accountUrl ?? 'no account URL'}` : ''})`,
    // One line per mapping, printed every start. The answer to "why can
    // nobody sign in" — a group name that does not match what the issuer
    // actually emits, or an issuer string that is the container-network
    // address rather than the one the browser obtained its token from — is
    // then in the first screen of logs rather than in a database nobody can
    // reach.
    `Role mappings (${cfg.roleMappings.length}):`,
    ...cfg.roleMappings.map(m => `  ${m.issuer} | ${m.groupValue} -> ${m.role}`),
  ].join('\n');
}
