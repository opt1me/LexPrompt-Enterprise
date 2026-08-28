import {
  isProviderId, type AllowedModel, type Bloc, type Jurisdiction, type ProviderId,
} from '@lexprompt/core';
import { PENDING } from './adapters/registry.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type CredentialConfig =
  | { source: 'managed-identity'; scope: string }
  | { source: 'key-vault'; vaultUrl: string; secretName: string }
  | { source: 'env'; var: string }
  | { source: 'file'; path: string };

/**
 * An allowlist entry as the gateway holds it.
 *
 * `endpoint` and `credential` are the two fields that must NEVER leave this
 * process. `toAllowedModel` (Task 5) is the only route from one of these to
 * something a browser may see.
 */
export interface ModelEntry extends AllowedModel {
  endpoint: string;
  apiVersion?: string;
  credential: CredentialConfig;
}

/**
 * S26: every allowlist entry carries a dated note recording the terms the
 * operator agreed with that provider. §12 Q5's subprocessor answer reads it.
 *
 * It is the OPERATOR's record of their own contract, not a judgement this
 * software passes on a provider — which is why `lastCheckedAt` is a
 * staleness marker prompting them to re-read their own agreement, and why
 * Stage 2's admin screen renders it rather than scoring it.
 *
 * Optional in Stage 1 because nothing renders it yet; on `ModelEntry` from
 * the start because Task 5's `toAllowedModel` enumerates the wire keys
 * explicitly and a test asserts the exact key list — so adding it later is
 * a schema change plus a wire-type change plus a test edit, and §12 Q5 is
 * unanswerable until then.
 */
export interface DataHandling {
  /** What the operator agreed: retention, training, sub-processing. */
  summary: string;
  /** ISO date the operator last checked the provider's terms. */
  lastCheckedAt: string;
  /** A link or document reference to the agreement itself. */
  reference?: string;
}

export type CallerAuthConfig =
  | { mode: 'none' }
  | { mode: 'mtls'; caFile: string; certFile: string; keyFile: string; allowedSubject: string }
  | { mode: 'entra'; tenantId: string; audience: string; allowedObjectIds: string[] };

export interface GatewayConfig {
  port: number;
  models: ModelEntry[];
  allowedJurisdictions: Bloc[];
  maxPromptChars: number;
  requestTimeoutMs: number;
  defaultMaxTokens: number;
  /** §10's budgets, consumed only by `WindowRateLimiter` (Task 14). Named to
   *  match its constructor options exactly, so there is no second mapping
   *  between a config field and a limiter option to drift out of step. */
  requestsPerMinutePerActor: number;
  requestsPerMinutePerWorkspace: number;
  tokensPerHourPerActor: number;
  tokensPerHourPerWorkspace: number;
  /** Sent as OpenRouter's `HTTP-Referer` attribution header. Read HERE and
   *  passed into the adapter factory, never read inside an adapter: S25
   *  says an adapter owns request shaping and nothing else, and reading
   *  deployment configuration is exactly the class of thing the adapter
   *  boundary test (Task 8) exists to catch. */
  publicOrigin: string;
  /** Where the `recorded` provider's fixtures live (Task 13). Same reason. */
  recordedDir: string;
  /** The environment reader itself, so `credentials/envOrFile.ts` takes it
   *  as a dependency rather than reaching for `process.env` — which would
   *  put a second env reader outside this module and break `configSurface`
   *  (Task 26). `DefaultCredentialResolver` already accepts it. */
  readEnv: (name: string) => string | undefined;
  caller: CallerAuthConfig;
}
// Deliberately absent: `environment`, `upstream`, `stubDir`. S30 forbids any
// module branching on the environment, and a config field called
// `environment` is where that starts. Offline working is a provider on the
// allowlist (Task 13), not a mode. NOTHING in this file reads NODE_ENV.

const BLOCS: readonly Bloc[] = ['UK', 'EU', 'US', 'other'];

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number; got ${JSON.stringify(raw)}.`);
  }
  return n;
}

function str(value: unknown, entryId: string, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new ConfigError(`Model "${entryId}" is missing ${field}.`);
  }
  return value;
}

function parseJurisdiction(raw: unknown, entryId: string): Jurisdiction {
  const j = raw as Partial<Jurisdiction> | undefined;
  if (!j || typeof j !== 'object') {
    throw new ConfigError(
      `Model "${entryId}" has no jurisdiction. Every model must declare where it is `
      + 'processed — an unstated jurisdiction is how a firm ends up believing it is UK-only.',
    );
  }
  if (!BLOCS.includes(j.bloc as Bloc)) {
    throw new ConfigError(
      `Model "${entryId}" has jurisdiction.bloc ${JSON.stringify(j.bloc)}; `
      + `expected one of ${BLOCS.join(', ')}.`,
    );
  }
  return {
    bloc: j.bloc as Bloc,
    region: str(j.region, entryId, 'jurisdiction.region'),
    label: str(j.label, entryId, 'jurisdiction.label'),
  };
}

/** S26's note. Optional — but if present it must be complete and dated,
 *  because a half-filled record of an agreement is worse than none. */
function parseDataHandling(raw: unknown, entryId: string): DataHandling | undefined {
  if (raw === undefined || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  const lastCheckedAt = str(d.lastCheckedAt, entryId, 'dataHandling.lastCheckedAt');
  if (!/^\d{4}-\d{2}-\d{2}/.test(lastCheckedAt)) {
    throw new ConfigError(
      `Model "${entryId}" has dataHandling.lastCheckedAt ${JSON.stringify(lastCheckedAt)}; `
      + 'expected an ISO date. An undated record of an agreement cannot go stale, '
      + 'which is the one thing it needs to be able to do.',
    );
  }
  return {
    summary: str(d.summary, entryId, 'dataHandling.summary'),
    lastCheckedAt,
    ...(typeof d.reference === 'string' && d.reference ? { reference: d.reference } : {}),
  };
}

function parseCredential(raw: unknown, entryId: string): CredentialConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  switch (c.source) {
    case 'managed-identity':
      return { source: 'managed-identity', scope: str(c.scope, entryId, 'credential.scope') };
    case 'key-vault':
      return {
        source: 'key-vault',
        vaultUrl: str(c.vaultUrl, entryId, 'credential.vaultUrl'),
        secretName: str(c.secretName, entryId, 'credential.secretName'),
      };
    case 'env':
      return { source: 'env', var: str(c.var, entryId, 'credential.var') };
    case 'file':
      return { source: 'file', path: str(c.path, entryId, 'credential.path') };
    default:
      throw new ConfigError(
        `Model "${entryId}" has credential.source ${JSON.stringify(c.source)}; `
        + 'expected managed-identity, key-vault, env or file.',
      );
  }
}

function parseCaller(env: NodeJS.ProcessEnv): CallerAuthConfig {
  const mode = env.GATEWAY_CALLER_AUTH;
  // `mode: 'none'` is deliberately NOT reachable from configuration. It
  // exists as a type so unit tests can construct one directly, and there is
  // no environment variable that produces it — which is stronger than
  // refusing it under NODE_ENV=production, and is the only version
  // compatible with S30's "no module branches on the environment". Local
  // development uses mTLS like the compose stack does; there is no mode that
  // turns the caller check off (S29's shape, applied to the gateway's own
  // front door).
  if (mode === 'mtls') {
    return {
      mode: 'mtls',
      caFile: str(env.GATEWAY_MTLS_CA_FILE, 'gateway', 'GATEWAY_MTLS_CA_FILE'),
      certFile: str(env.GATEWAY_MTLS_CERT_FILE, 'gateway', 'GATEWAY_MTLS_CERT_FILE'),
      keyFile: str(env.GATEWAY_MTLS_KEY_FILE, 'gateway', 'GATEWAY_MTLS_KEY_FILE'),
      allowedSubject: str(env.GATEWAY_MTLS_ALLOWED_SUBJECT, 'gateway', 'GATEWAY_MTLS_ALLOWED_SUBJECT'),
    };
  }
  if (mode === 'entra') {
    return {
      mode: 'entra',
      tenantId: str(env.GATEWAY_ENTRA_TENANT_ID, 'gateway', 'GATEWAY_ENTRA_TENANT_ID'),
      audience: str(env.GATEWAY_ENTRA_AUDIENCE, 'gateway', 'GATEWAY_ENTRA_AUDIENCE'),
      allowedObjectIds: (env.GATEWAY_ENTRA_ALLOWED_OIDS ?? '')
        .split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  throw new ConfigError(
    `GATEWAY_CALLER_AUTH must be mtls or entra; got ${JSON.stringify(mode)}. `
    + 'There is no value that disables the caller check.',
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): GatewayConfig {
  const modelsFile = env.GATEWAY_MODELS_FILE;
  if (!modelsFile) {
    throw new ConfigError(
      'GATEWAY_MODELS_FILE is not set. The gateway will not start without an allowlist: '
      + 'starting with none would mean either refusing every call or, worse, somebody later '
      + 'making "no allowlist" mean "anything allowed".',
    );
  }

  let raw: { models?: unknown[] };
  try {
    raw = JSON.parse(readFile(modelsFile)) as { models?: unknown[] };
  } catch (err) {
    throw new ConfigError(
      `GATEWAY_MODELS_FILE (${modelsFile}) could not be read as JSON: ${(err as Error).message}`,
    );
  }

  const entries = Array.isArray(raw.models) ? raw.models : [];
  if (entries.length === 0) {
    throw new ConfigError(`${modelsFile} lists no models. Configure at least one model.`);
  }

  const models: ModelEntry[] = entries.map((item) => {
    const m = item as Record<string, unknown>;
    const id = str(m.id, String(m.id ?? '(unnamed)'), 'id');
    if (!isProviderId(m.provider)) {
      throw new ConfigError(
        `Model "${id}" names provider ${JSON.stringify(m.provider)}, `
        + 'which is not a provider this gateway has an adapter for.',
      );
    }
    // The registry (Task 8) is filled in over three tasks; PENDING is its
    // honest record of what has no adapter yet. A model naming one of those
    // ids is a real `ProviderId` (isProviderId above passes it) that would
    // otherwise start clean and only fail on its first call — refusing here
    // instead means the operator sees the problem at startup, in the same
    // banner as every other misconfigured entry, not from a user's failed
    // request.
    if (PENDING.includes(m.provider)) {
      throw new ConfigError(
        `Model "${id}" names provider ${m.provider}, whose adapter is not implemented yet.`,
      );
    }
    const dataHandling = parseDataHandling(m.dataHandling, id);
    return {
      id,
      provider: m.provider as ProviderId,
      model: str(m.model, id, 'model'),
      label: str(m.label, id, 'label'),
      jurisdiction: parseJurisdiction(m.jurisdiction, id),
      contextLength: Number(m.contextLength ?? 0),
      supportsImages: m.supportsImages === true,
      supportsStructuredOutput: m.supportsStructuredOutput === true,
      isDefault: m.isDefault === true,
      // Conditional spreads, not `field: maybeUndefined`: `structuredClone`
      // (how IndexedDB — and this same shape, later, JSON — round-trips a
      // record) preserves an `undefined`-valued key, so a plain assignment
      // here would leave `'dataHandling' in entry` (and `'apiVersion' in
      // entry`) true even when the operator never set one. CLAUDE.md names
      // this exact trap; the "absent dataHandling" test below is what a
      // literal `dataHandling: parseDataHandling(...)` assignment fails.
      ...(dataHandling !== undefined ? { dataHandling } : {}),
      endpoint: str(m.endpoint, id, 'endpoint'),
      ...(typeof m.apiVersion === 'string' ? { apiVersion: m.apiVersion } : {}),
      credential: parseCredential(m.credential, id),
    };
  });

  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new ConfigError(`Duplicate model id "${m.id}".`);
    seen.add(m.id);
  }
  if (models.filter(m => m.isDefault).length !== 1) {
    throw new ConfigError('Exactly one model must be marked isDefault.');
  }

  // NO DEFAULT, deliberately (owner decision 5). Which jurisdictions a firm
  // accepts is a judgement about the contracts and data provisions it holds
  // with its providers — settled with legal input, long before anyone edits
  // this file. A default would make that judgement silently, on their
  // behalf, and the system would then enforce it as though somebody had
  // chosen it. Unset is a startup failure instead: strictly more fail-closed
  // than any default could be, because a refusal cannot be mistaken for a
  // decision.
  const declared = (env.GATEWAY_ALLOWED_JURISDICTIONS ?? '').trim();
  if (!declared) {
    throw new ConfigError(
      'GATEWAY_ALLOWED_JURISDICTIONS is not set, and it has no default. It lists the '
      + `processing jurisdictions this deployment permits (any of ${BLOCS.join(', ')}), `
      + 'and it must state the policy the operator has settled with their providers — '
      + 'LexPrompt will not guess it. Set it to the jurisdictions your contracts and data '
      + 'provisions cover.',
    );
  }
  const allowedJurisdictions = declared
    .split(',').map(s => s.trim()).filter(Boolean) as Bloc[];
  for (const bloc of allowedJurisdictions) {
    if (!BLOCS.includes(bloc)) {
      throw new ConfigError(
        `GATEWAY_ALLOWED_JURISDICTIONS contains ${JSON.stringify(bloc)}; `
        + `expected one of ${BLOCS.join(', ')}.`,
      );
    }
  }

  // A recorded model must declare that it is recorded. Everything else in
  // this design lets an operator declare a jurisdiction and be trusted; here
  // the value is a fact about the software rather than about a deployment,
  // and an entry claiming `UK South` for stored fixtures would defeat every
  // one of the four markings at once (Task 13, §5.1). Checked here, on the
  // provider field's VALUE, in the configuration validator — not as a
  // provider-specific branch in the call path.
  for (const m of models) {
    if (m.provider === 'recorded' && m.jurisdiction.bloc !== 'other') {
      throw new ConfigError(
        `Model "${m.id}" uses the recorded provider and must declare `
        + `jurisdiction.bloc "other" — recorded responses come from this machine, `
        + `not from ${m.jurisdiction.label}.`,
      );
    }
  }

  // Every provider that actually opens a socket must say so in its endpoint.
  //
  // `transport.ts` branches on the URL's SCHEME: anything that is not
  // http(s) is read from the filesystem, which is how the `recorded`
  // provider replays a fixture without a second code path. That branch is
  // safe only while no other adapter can produce such a URL — and until
  // this check existed that was true by CONVENTION, not by construction.
  // An endpoint written `api.openai.com/v1` (no scheme), or one a typo
  // turned into a bare path, would have sent a real provider call into
  // `readFileSync` instead: either an ENOENT blaming a fixture for what is
  // actually a malformed endpoint, or — if the path happened to exist —
  // a local file parsed as a model response. Both are the quiet wrong
  // answer this project refuses; the loud one is a startup failure naming
  // the entry.
  //
  // `http://` is permitted only on loopback, mirroring the rule §7 already
  // applies to the API's OIDC issuer: a developer may run a provider stub
  // on localhost, and a deployment pointed at plaintext anywhere else is a
  // misconfiguration rather than a choice. `recorded` is exempt because its
  // `buildCall` never reads `endpoint` at all — it builds a fixture path
  // from `recordedDir`.
  for (const m of models) {
    if (m.provider === 'recorded') continue;
    let url: URL;
    try {
      url = new URL(m.endpoint);
    } catch {
      throw new ConfigError(
        `Model "${m.id}" has endpoint ${JSON.stringify(m.endpoint)}, which is not a `
        + 'URL. An endpoint must be an absolute https:// URL — a bare host or path '
        + 'would be read as a local file rather than called over the network.',
      );
    }
    const loopback = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
    if (url.protocol === 'https:') continue;
    if (url.protocol === 'http:' && loopback) continue;
    throw new ConfigError(
      `Model "${m.id}" has endpoint ${JSON.stringify(m.endpoint)}. An endpoint must be `
      + 'https://, or http:// on loopback for local development. '
      + `${url.protocol}// would not be sent over the network.`,
    );
  }

  // P4. An operator routing privileged text outside the permitted blocs
  // must have written that bloc down. There is no runtime warning to scroll
  // past and no documentation note to not read.
  for (const m of models) {
    if (!allowedJurisdictions.includes(m.jurisdiction.bloc)) {
      throw new ConfigError(
        `Model "${m.id}" (provider ${m.provider}) is processed in `
        + `${m.jurisdiction.bloc} · ${m.jurisdiction.label}, which is not in `
        + `GATEWAY_ALLOWED_JURISDICTIONS (${allowedJurisdictions.join(', ')}). `
        + `Remove the model, or add ${m.jurisdiction.bloc} to `
        + 'GATEWAY_ALLOWED_JURISDICTIONS to record that your provisions with this '
        + 'provider cover processing there.',
      );
    }
  }

  return {
    port: int(env, 'GATEWAY_PORT', 8081),
    models,
    allowedJurisdictions,
    maxPromptChars: int(env, 'GATEWAY_MAX_PROMPT_CHARS', 400_000),
    requestTimeoutMs: int(env, 'GATEWAY_REQUEST_TIMEOUT_MS', 120_000),
    defaultMaxTokens: int(env, 'GATEWAY_DEFAULT_MAX_TOKENS', 4096),
    requestsPerMinutePerActor: int(env, 'GATEWAY_RPM_PER_ACTOR', 60),
    requestsPerMinutePerWorkspace: int(env, 'GATEWAY_RPM_PER_WORKSPACE', 600),
    tokensPerHourPerActor: int(env, 'GATEWAY_TOKENS_PER_HOUR_PER_ACTOR', 2_000_000),
    tokensPerHourPerWorkspace: int(env, 'GATEWAY_TOKENS_PER_HOUR_PER_WORKSPACE', 20_000_000),
    publicOrigin: env.GATEWAY_PUBLIC_ORIGIN ?? 'https://lexprompt.local',
    recordedDir: env.GATEWAY_RECORDED_DIR ?? 'apps/gateway/fixtures/recorded',
    // The one `process.env` reader in this process is `main.ts`, which hands
    // the whole object to `loadConfig`. Passing the accessor on from here
    // keeps that true for the credential resolver too.
    readEnv: (name: string) => env[name],
    caller: parseCaller(env),
  };
}

/**
 * The boot banner. Printed every start, because the answer to "where does
 * our contract text go" belongs in the first screen of this service's logs
 * rather than in a document somebody has to find.
 */
export function describeConfig(cfg: GatewayConfig): string {
  const rows = cfg.models.map(m =>
    `  ${m.isDefault ? '*' : ' '} ${m.id.padEnd(24)} ${m.provider.padEnd(15)} `
    + `${m.jurisdiction.bloc} · ${m.jurisdiction.label} (auth: ${m.credential.source})`);
  return [
    `LexPrompt gateway — caller-auth=${cfg.caller.mode}`,
    `Permitted jurisdictions: ${cfg.allowedJurisdictions.join(', ')}`,
    'Allowlisted models:',
    ...rows,
  ].join('\n');
}
