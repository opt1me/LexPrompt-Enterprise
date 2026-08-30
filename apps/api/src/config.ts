import { assertIssuerUsable, type AuthConfig } from './oidc.ts';
import { parseRoleMappings, type RoleMapping } from './auth/roles.ts';
import type { BlobCredentialConfig } from './blob/credential.ts';
// IMPORTED, not restated. `assertBackoffOutlivedByHeartbeat` below is only
// correct while it counts the same number of missed heartbeats the reaper
// actually counts, and a second `3` here is precisely the sibling drift this
// project has six findings about.
import { MISSED_HEARTBEATS_BEFORE_DEAD } from './run/reaper.ts';

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
   * The RUN WORKER's connection, and REQUIRED — there is deliberately no
   * fallback to `databaseUrl` (§9, §14).
   *
   * The whole of "the worker cannot touch a human's judgement" is a fact
   * about the database rather than about the code: `lexprompt_worker` holds
   * no grant on `finding_disposition` or `finding_disposition_event`, and
   * `006_dispositions.sql` revokes both explicitly so a future blanket grant
   * cannot undo it. A fallback here would hand every worker slot the APP
   * role's connection, which holds `select, insert, update` on both of them
   * — and the guarantee would evaporate with nothing on any screen, in any
   * log, or in any test to say so. The worker would keep working. That is
   * the failure this key's absence of a default exists to make loud.
   */
  databaseWorkerUrl: string;
  /** Sized against `runWorkers` at startup — see the refusal in
   *  `assertWorkerPoolFits`. Its own pool, not a share of the app's: two
   *  roles means two connections, which is the price of the grant above. */
  workerPoolMax: number;
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
   * `API_PAGE_IMAGE_LRU_BYTES`, was deliberately absent while there was no
   * cache for it to size — a configuration key that changes nothing is a
   * knob an operator turns and then trusts. Task 9 built the cache, so the
   * key arrives with it, below.
   */
  pageRenderTimeoutMs: number;
  pageImageMaxPages: number;
  /**
   * §15's third key, and the cache it bounds now exists (Task 9).
   *
   * Page images are the largest objects this process holds: a base64 JPEG
   * per page, roughly a third larger than the bytes it was rendered from.
   * The browser bounds its own cache by DOCUMENT COUNT
   * (`PAGE_IMAGE_CACHE_MAX_DOCUMENTS = 10`), which is fine for one person's
   * tab and wrong for a server: ten documents is a few megabytes of
   * three-page contracts and gigabytes of hundred-page scans. Bounded by
   * BYTES here for that reason, and the difference is deliberate rather
   * than a drift.
   */
  pageImageLruBytes: number;
  /**
   * The wire ceiling on one clause's page images, and it exists because
   * Spike 1 found the real limit is not the renderer.
   *
   * A 100-page scan is roughly 31 MB of base64 — already over
   * `API_MAX_BODY_BYTES` before the gateway's own prompt cap is consulted.
   * A request that large is refused by the middle hop with a 413, which is
   * a loud failure and therefore acceptable; what is NOT acceptable is the
   * repair somebody reaches for next, which is to send the pages that fit.
   * A partly-sent scan reads to a model as a document that is silent on
   * everything the missing pages said — this project's founding defect,
   * wearing a successful HTTP status.
   *
   * So the cell is REFUSED by name, before the call, naming the document,
   * its page count and this key. Defaulted well under `maxBodyBytes` because
   * the images are not the only thing in the body.
   *
   * NOT BATCHED, and that is a decision rather than an omission: splitting
   * one clause's images across several calls means merging several model
   * answers into one finding, which is a synthesis no document contains and
   * a second extraction pipeline beside `extractClause`. The honest lever an
   * operator has is fewer pages (`API_PAGE_IMAGE_MAX_PAGES`) or a larger
   * body (`API_MAX_BODY_BYTES`), and both are named in the refusal.
   */
  runImageBytesMax: number;
  /**
   * The queue's caps (§9, P26). Every one of them DECLARED, because three
   * undeclared-cap defects have already been found in this repository —
   * Fastify's `bodyLimit`, nginx's `client_max_body_size`, busboy's
   * `fieldSize` — and every one was a library default nobody had written
   * down. A queue adds five more, and none of them is a library's to choose.
   *
   * `runWorkers` — how many cells this process runs at once. Each slot holds
   * a worker-pool connection for the length of its write transaction.
   *
   * `runLeaseMs` — how long a claimed cell is this worker's. A lease that
   * expires while the cell is legitimately still working hands the same
   * clause to a second worker, so it MUST exceed `runCellTimeoutMs`;
   * `assertLeaseOutlastsCell` refuses at startup when it does not.
   *
   * `runCellTimeoutMs` — the hard budget for one cell's model call. The
   * browser has no equivalent (a person watching a spinner is the timeout),
   * which is exactly why the server needs one.
   *
   * `runHeartbeatMs` — how often a live run says it is alive, and the unit
   * the reaper counts in (three missed intervals is dead).
   *
   * `runAttemptsMax` — §9's bound of 3. A cell that exhausts them becomes an
   * `error` finding carrying its last error text, which is something a
   * person can retry by hand; it is never a cell that quietly never
   * finishes.
   *
   * `runRetryBackoffMs` — how long a cell that failed RETRYABLY waits before
   * another worker may claim it. Found by running a 200-cell review against
   * the real stack: the gateway's own rate limiter answered 429 for 140 of
   * them, `extractClause` turned each into an error finding, and the run
   * reported 140 failures for a condition that would have cleared in under a
   * minute. A 429 or a 5xx is the one failure a retry genuinely fixes — the
   * browser's own client has always retried them (`isRetryableStatus`) — and
   * an immediate retry would simply burn all three attempts inside a second
   * against a limiter that counts per minute. The wait is what makes the
   * attempt bound mean something.
   *
   * `runPollMs` — how long an idle worker waits before asking again. There
   * is no LISTEN/NOTIFY here deliberately: a notification lost while a
   * worker was between transactions is a run that stops with cells queued,
   * and polling cannot lose one.
   *
   * `workspaceRunConcurrency` — the ceiling across ALL of a workspace's
   * runs, so one forty-cell review cannot starve a three-cell retry (§9's
   * own sentence, and Task 8's test).
   *
   * `parseWorkers` — the same, for the parse queue, which is separate
   * because a document being read and a clause being reviewed compete for
   * nothing except this process.
   *
   * `parseTimeoutMs` — THE PARSE QUEUE'S OWN BOUND, and its absence was the
   * fourth undeclared-cap defect on the scanned-document path. Every other
   * loop in this service declares one; this one had no timeout, no attempt
   * counter, no reaper and nothing that reported a document stuck
   * `pending`. `parseWorkers` defaults to 1 and the claim is strict FIFO
   * (`order by added_at asc, id asc`) with no skipping, so ONE slow document
   * blocks every other document in the deployment, in every workspace, for
   * as long as it takes — and a genuine hang blocks them forever, while the
   * only sentence anybody can reach is *"try again in a moment"*.
   * `statement_timeout` does not help: `pdfjs` is CPU work in Node, not a
   * query. Exceeding this marks the document `failed` with a message that
   * names the key, which is a loud answer and, crucially, takes it OUT of
   * `pending` so the queue moves.
   *
   * `parseStuckReportMs` — how long a document may sit `pending` before the
   * worker says so on stderr. Not a failure and not a bound: a busy queue is
   * not a broken one, and a document waiting behind nine others is normal.
   * It exists because the alternative is a queue whose only symptom is a
   * user being told to try again in a moment, forever.
   */
  runWorkers: number;
  runLeaseMs: number;
  runCellTimeoutMs: number;
  runHeartbeatMs: number;
  runAttemptsMax: number;
  runRetryBackoffMs: number;
  runPollMs: number;
  workspaceRunConcurrency: number;
  parseWorkers: number;
  parseTimeoutMs: number;
  parseStuckReportMs: number;
  /**
   * The outbox's retention and its page size (§6.5, P22).
   *
   * `eventRetentionDays` is 7 because the outbox is "a reconnection buffer,
   * not an archive". A cursor older than the oldest surviving event gets
   * `{ resyncRequired: true }` and NOT a silently short list: a client that
   * asked for everything after 400 and received everything after 900 has a
   * hole it cannot see, which is the quiet-wrong-answer shape one layer down
   * from a finding.
   */
  eventRetentionDays: number;
  eventPageMax: number;
  /**
   * The live socket's caps (§8, Stage 4). DECLARED, like every other cap in
   * this module, because an undeclared one is a limit an operator hits with
   * no key to change and no sentence naming it — three of those have already
   * shipped in this repository.
   *
   * `wsPingMs` — how often the server sends a `ping` FRAME (not a protocol
   * ping: a browser answers those in the network stack with no JavaScript
   * involved, which proves the socket is alive and proves nothing about
   * whether the page still is). Two unanswered pings close the connection,
   * and the browser renders `stale` on the same threshold — so this number
   * decides how long a reviewer can be looking at a screen that has quietly
   * stopped being live, which is §19's named defect.
   *
   * IT MUST STAY BELOW EVERY IDLE TIMEOUT IN FRONT OF IT. `infra/nginx/
   * web.conf`'s socket location sets `proxy_read_timeout 3600s`, and
   * Container Apps' ingress idle timeout defaults to four minutes. At 25s
   * this is comfortably inside both; raising it past either would kill every
   * idle socket and the app would look like a network with a fault.
   *
   * `wsMaxConnections` — per replica. `wsMaxSubscriptions` — per socket; §8
   * says one connection per tab, multiplexed, and a review screen holds two
   * or three. `wsMaxFrameBytes` — the largest frame a client may send, which
   * is small because a client only ever sends `subscribe`, `unsubscribe` and
   * `pong`.
   */
  /**
   * How often each replica reads the outbox forward for the subscriptions
   * it holds, whether or not a notification arrived (§8, P39).
   *
   * THIS IS THE FLOOR LIVE CHANGE DEGRADES TO, and that is why it is
   * declared rather than picked. The `pg_notify` issued inside
   * `appendEvent`'s transaction normally makes delivery immediate; this is
   * what still delivers everything when the listener connection has
   * dropped, and the failure it covers is silent -- the app keeps working,
   * one tick slower, which nobody reports as a fault.
   */
  hubTickMs: number;
  wsPingMs: number;
  wsMaxConnections: number;
  wsMaxSubscriptions: number;
  wsMaxFrameBytes: number;
  /**
   * §8's presence heartbeat and the TTL that expires it (Stage 4 Task 22).
   *
   * `presenceHeartbeatMs` is the interval THE SERVER ASKS THE BROWSER FOR,
   * sent on the `hello` frame and beaten at by `src/lib/api/socket.ts`. It
   * is not a browser constant: a TTL raised in a deployment's environment
   * while a bundle kept beating at a compiled-in interval would expire a
   * roster between beats, and a colleague flickering in and out reads as
   * somebody repeatedly opening and closing the review.
   *
   * `presenceTtlMs` is how long a beat is believed. It is the number that
   * makes *"a stale presence indicator that claims someone is there is
   * worse than no indicator"* a property of the code rather than a hope: a
   * reviewer must not defer to a colleague who left ten minutes ago, and
   * fifteen seconds is short enough that deferring to a roster entry is
   * deferring to something that was true within the last quarter minute.
   *
   * The TTL MUST OUTLAST THE HEARTBEAT, and by a margin — see
   * `assertPresenceOutlivesBeat`.
   */
  presenceHeartbeatMs: number;
  presenceTtlMs: number;
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

/**
 * The socket's caps, as ONE exported object rather than four literals inside
 * `loadConfig`.
 *
 * `DEFAULT_MAX_BODY_BYTES` is the precedent and the reason is the same: three
 * test harnesses stand a real server up, and each would otherwise invent its
 * own ping interval and its own ceiling — so a suite would be exercising
 * numbers no deployment uses, which is the quieter half of an undeclared cap.
 * One home, read by `loadConfig` and by every harness.
 */
export const WS_CAP_DEFAULTS = {
  pingMs: 25_000,
  maxConnections: 500,
  maxSubscriptions: 20,
  maxFrameBytes: 16 * 1024,
  // §8, verbatim: a 10-second heartbeat and a 15-second TTL. Here rather
  // than as two literals inside `loadConfig` for the reason the four above
  // are: three harnesses stand a real server up, and a suite exercising a
  // TTL no deployment uses is the quieter half of an undeclared cap.
  presenceHeartbeatMs: 10_000,
  presenceTtlMs: 15_000,
} as const;

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

/**
 * How many pool connections the request path needs while every worker slot
 * is busy.
 *
 * The worker has its OWN pool (`databaseWorkerUrl`, a different ROLE), so it
 * does not compete with request handlers for `databasePoolMax` — the shape
 * the plan's own sketch assumed. What it does compete for is Postgres's
 * `max_connections`, which is why both pools are named in the banner and in
 * the refusal below.
 */
export const POOL_HEADROOM = 1;

/**
 * The pool-size check, at startup, loudly — the new cap tier and the one
 * with no precedent in this repository.
 *
 * Each worker slot holds a connection from the WORKER pool for the length of
 * its write transaction; the reaper and the pruner hold one from the APP
 * pool. If the worker pool is smaller than the number of slots, a slot
 * blocks on `pool.connect()` for as long as another slot's transaction runs
 * — the run still progresses, but at a rate nothing in the configuration
 * explains, and every symptom points at the database.
 *
 * The same posture as every other startup refusal in this system: a
 * misconfiguration must not become a service that runs and mostly works.
 */
export function assertWorkerPoolFits(cfg: ApiConfig): void {
  if (cfg.workerPoolMax < cfg.runWorkers + cfg.parseWorkers + POOL_HEADROOM) {
    throw new ConfigError(
      `API_WORKER_POOL_MAX is ${cfg.workerPoolMax}, which is not enough for `
      + `API_RUN_WORKERS=${cfg.runWorkers} plus API_PARSE_WORKERS=${cfg.parseWorkers} plus `
      + `${POOL_HEADROOM} of headroom. Every worker slot holds a connection for the length of `
      + 'its transaction, so a pool smaller than the slot count makes slots wait on each other '
      + 'for a reason no configuration value states. Raise the pool or lower the worker count. '
      + `The app pool (API_DATABASE_POOL_MAX=${cfg.databasePoolMax}) is separate and is not `
      + "part of this arithmetic — the worker connects as a different ROLE — but the two "
      + "together must fit inside Postgres's own max_connections.",
    );
  }
}

/**
 * A lease must outlast the cell it covers.
 *
 * `API_RUN_LEASE_MS` shorter than `API_RUN_CELL_TIMEOUT_MS` means a cell
 * whose model call is still legitimately running has its lease expire, is
 * re-leased by a second worker, and is answered twice — two writers on one
 * finding, which is the thing this stage exists to end. Worse, the first
 * worker's write then lands on a cell it no longer holds. The write path
 * abandons quietly in that case (it re-reads the lease before writing), so
 * the symptom is not an error: it is a run that takes twice as long and
 * spends twice the model budget, with nothing anywhere saying why.
 */
export function assertLeaseOutlastsCell(cfg: ApiConfig): void {
  if (cfg.runLeaseMs <= cfg.runCellTimeoutMs) {
    throw new ConfigError(
      `API_RUN_LEASE_MS is ${cfg.runLeaseMs}ms and API_RUN_CELL_TIMEOUT_MS is `
      + `${cfg.runCellTimeoutMs}ms. A lease must outlast the cell it covers, or a cell whose `
      + 'model call is still running is re-leased by a second worker and answered twice — two '
      + 'writers on one finding, at twice the cost, with nothing to show for it. Raise the '
      + 'lease above the cell timeout.',
    );
  }
}

/**
 * A run must still be heartbeating while its cells sit out a retry backoff.
 *
 * A cell parked after a retryable 429/5xx keeps `state = 'leased'` and sets
 * `leased_by = null`, which is exactly the shape the claim query understands.
 * But the worker pool's `active` set — the runs it beats a heartbeat for — is
 * built from `leased_by like '<workerId>#%'`, so a parked cell contributes
 * nothing to it; and parked cells still consume the per-run concurrency
 * budget, so no replacement cell can be claimed for that run. If every
 * in-flight cell of a run is parked, the run's `heartbeat_at` FREEZES for the
 * length of the backoff.
 *
 * The reaper calls a run dead after `MISSED_HEARTBEATS_BEFORE_DEAD` (3)
 * intervals. At the defaults this survives by fifteen seconds — 30s of
 * backoff against 45s of staleness — which is not a margin anybody chose.
 * Set `API_RUN_RETRY_BACKOFF_MS=60000`, a perfectly reasonable answer to a
 * per-minute rate limiter and the exact case that key's own docstring
 * describes, and every rate-limited run is reaped as `failed` with *"This run
 * stopped without finishing"* while it was doing precisely what it was
 * configured to do.
 *
 * `caps.test.ts`'s preamble names this failure — "a heartbeat that is too
 * slow reaps a healthy run" — and the instance was missing. STRICTLY less
 * than, with no fudge: equality is the case where the sweep and the wake-up
 * race, and a race is not a margin.
 */
export function assertBackoffOutlivedByHeartbeat(cfg: ApiConfig): void {
  const stale = cfg.runHeartbeatMs * MISSED_HEARTBEATS_BEFORE_DEAD;
  if (cfg.runRetryBackoffMs >= stale) {
    throw new ConfigError(
      `API_RUN_RETRY_BACKOFF_MS is ${cfg.runRetryBackoffMs}ms and API_RUN_HEARTBEAT_MS is `
      + `${cfg.runHeartbeatMs}ms, so the reaper calls a run dead after ${stale}ms `
      + `(${MISSED_HEARTBEATS_BEFORE_DEAD} missed heartbeats). A run whose cells are all `
      + 'parked waiting out a retry stops heartbeating for the length of that backoff, so a '
      + 'backoff at or above the staleness window marks a healthy, rate-limited run as failed '
      + 'with "This run stopped without finishing". Lower the backoff, or raise the heartbeat '
      + 'interval above a third of it.',
    );
  }
}

/**
 * A PRESENCE TTL THAT DOES NOT OUTLAST THE HEARTBEAT EXPIRES EVERYBODY.
 *
 * The failure is not an outage and would never be reported as one: every
 * colleague appears, vanishes, and reappears on a cycle, so the roster reads
 * as people opening and closing the review rather than as a misconfiguration
 * — and a reader who learns to distrust it has lost the whole feature while
 * the app looks like it is working.
 *
 * A MARGIN of one whole heartbeat rather than "strictly greater", because a
 * beat is not instantaneous: it crosses a network, a proxy and, across
 * replicas, a `pg_notify`. A TTL of 11s against a 10s beat would expire a
 * roster on any second of latency, which is a race rather than a margin —
 * the same reasoning `assertBackoffOutlivedByHeartbeat` gives one screen up,
 * applied to the one signal that is allowed to be wrong and therefore has to
 * say so honestly.
 */
export function assertPresenceOutlivesBeat(cfg: ApiConfig): void {
  if (cfg.presenceTtlMs < cfg.presenceHeartbeatMs * 1.5) {
    throw new ConfigError(
      `API_PRESENCE_TTL_MS is ${cfg.presenceTtlMs}ms and API_PRESENCE_HEARTBEAT_MS is `
      + `${cfg.presenceHeartbeatMs}ms. A roster entry has to survive at least one missed `
      + 'beat, or every colleague expires between heartbeats and the presence roster reads '
      + 'as people opening and closing the review — a failure nobody reports, which costs '
      + 'the whole feature while the app looks like it is working. Set the TTL to at least '
      + `${Math.ceil(cfg.presenceHeartbeatMs * 1.5)}ms, or lower the heartbeat interval.`,
    );
  }
}

/** The image budget must fit inside the body limit that carries it. */
export function assertImagesFitTheBody(cfg: ApiConfig): void {
  if (cfg.runImageBytesMax >= cfg.maxBodyBytes) {
    throw new ConfigError(
      `API_RUN_IMAGE_BYTES_MAX is ${cfg.runImageBytesMax} and API_MAX_BODY_BYTES is `
      + `${cfg.maxBodyBytes}. The page images ride INSIDE the request body, alongside the `
      + 'prompt, so an image budget at or above the body limit means the refusal an operator '
      + 'reads is a raw 413 from the hop rather than a sentence naming the scan. Lower the '
      + 'image budget or raise the body limit.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  // DERIVED from the body limit rather than a constant beside it.
  //
  // A fixed 12 MB default plus a hard `assertImagesFitTheBody` made an
  // operator who LOWERED `API_MAX_BODY_BYTES` — a perfectly reasonable thing
  // to do — unable to start, over a key they had never set. Three quarters
  // of the declared body is the images' share; the rest is the prompt, the
  // schema and the envelope around them. An operator who names the key
  // explicitly is still held to the check below, because two values they
  // both chose and that contradict each other is a configuration fault.
  const maxBodyBytes = int(env, 'API_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
  const cfg: ApiConfig = {
    port: int(env, 'API_PORT', 8080),
    auth: parseAuth(env),
    gatewayUrl: required(env, 'API_GATEWAY_URL'),
    workspaceId: required(env, 'API_WORKSPACE_ID'),
    mtls: parseMtls(env),
    maxBodyBytes,
    databaseUrl: required(env, 'API_DATABASE_URL'),
    databaseMigrationUrl: required(env, 'API_DATABASE_MIGRATION_URL'),
    databasePoolMax: int(env, 'API_DATABASE_POOL_MAX', 10),
    databaseWorkerUrl: requiredWorkerUrl(env),
    workerPoolMax: int(env, 'API_WORKER_POOL_MAX', 4),
    roleMappings: roleMappingsFrom(env),
    blob: blobFrom(env),
    pageRenderTimeoutMs: int(env, 'API_PAGE_RENDER_TIMEOUT_MS', 120_000),
    pageImageMaxPages: int(env, 'API_PAGE_IMAGE_MAX_PAGES', 100),
    pageImageLruBytes: int(env, 'API_PAGE_IMAGE_LRU_BYTES', 256 * 1024 * 1024),
    runImageBytesMax: int(env, 'API_RUN_IMAGE_BYTES_MAX', Math.floor(maxBodyBytes * 3 / 4)),
    runWorkers: int(env, 'API_RUN_WORKERS', 2),
    runLeaseMs: int(env, 'API_RUN_LEASE_MS', 600_000),
    runCellTimeoutMs: int(env, 'API_RUN_CELL_TIMEOUT_MS', 300_000),
    runHeartbeatMs: int(env, 'API_RUN_HEARTBEAT_MS', 15_000),
    runAttemptsMax: int(env, 'API_RUN_ATTEMPTS_MAX', 3),
    runRetryBackoffMs: int(env, 'API_RUN_RETRY_BACKOFF_MS', 30_000),
    runPollMs: int(env, 'API_RUN_POLL_MS', 1_000),
    workspaceRunConcurrency: int(env, 'API_WORKSPACE_RUN_CONCURRENCY', 8),
    parseWorkers: int(env, 'API_PARSE_WORKERS', 1),
    parseTimeoutMs: int(env, 'API_PARSE_TIMEOUT_MS', 180_000),
    parseStuckReportMs: int(env, 'API_PARSE_STUCK_REPORT_MS', 300_000),
    eventRetentionDays: int(env, 'API_EVENT_RETENTION_DAYS', 7),
    eventPageMax: int(env, 'API_EVENT_PAGE_MAX', 500),
    hubTickMs: int(env, 'API_HUB_TICK_MS', 1_000),
    wsPingMs: int(env, 'API_WS_PING_MS', WS_CAP_DEFAULTS.pingMs),
    wsMaxConnections: int(env, 'API_WS_MAX_CONNECTIONS', WS_CAP_DEFAULTS.maxConnections),
    wsMaxSubscriptions: int(env, 'API_WS_MAX_SUBSCRIPTIONS', WS_CAP_DEFAULTS.maxSubscriptions),
    wsMaxFrameBytes: int(env, 'API_WS_MAX_FRAME_BYTES', WS_CAP_DEFAULTS.maxFrameBytes),
    presenceHeartbeatMs: int(
      env, 'API_PRESENCE_HEARTBEAT_MS', WS_CAP_DEFAULTS.presenceHeartbeatMs),
    presenceTtlMs: int(env, 'API_PRESENCE_TTL_MS', WS_CAP_DEFAULTS.presenceTtlMs),
  };
  // Every cross-key rule, at load, so the banner below describes a
  // configuration that can actually serve.
  assertWorkerPoolFits(cfg);
  assertLeaseOutlastsCell(cfg);
  assertImagesFitTheBody(cfg);
  assertBackoffOutlivedByHeartbeat(cfg);
  assertPresenceOutlivesBeat(cfg);
  return cfg;
}

/**
 * `API_WORKER_DATABASE_URL`, refused with the reason rather than with the
 * key's name alone.
 *
 * `required` would say "it is not set". That is true and it invites the
 * repair this key exists to prevent, which is to point it at
 * `API_DATABASE_URL` and move on — a worker on the app role can write a
 * disposition, and every test in this repository would still pass.
 */
function requiredWorkerUrl(env: NodeJS.ProcessEnv): string {
  const value = env.API_WORKER_DATABASE_URL;
  if (!value) {
    throw new ConfigError(
      'API_WORKER_DATABASE_URL is not set. The review engine runs as a THIRD database role '
      + '(lexprompt_worker) which holds no grant on finding_disposition or '
      + 'finding_disposition_event — that separation is what makes "nothing derives a human '
      + "judgement\" a fact about the database rather than a fact about the code. Do NOT point "
      + 'it at API_DATABASE_URL: the app role can write both of those tables, so the engine '
      + 'would silently regain the ability to overwrite a lawyer\'s verification and every '
      + 'test would still pass. The role is created by the deployment '
      + '(infra/postgres/init.sql locally); its DSN belongs here.',
    );
  }
  return value;
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
    `Page rendering: up to ${cfg.pageImageMaxPages} page(s) in ${cfg.pageRenderTimeoutMs}ms`
      + `, cached to ${cfg.pageImageLruBytes} bytes, at most ${cfg.runImageBytesMax} bytes per call`,
    // Every queue cap on one line of the boot log, for the same reason the
    // role mappings are: the answer to "why is this run crawling" or "why
    // did that cell get answered twice" must be in the first screen of logs
    // rather than in a default nobody wrote down.
    `Run queue: ${cfg.runWorkers} worker(s), ${cfg.parseWorkers} parse worker(s), `
      + `lease ${cfg.runLeaseMs}ms over a ${cfg.runCellTimeoutMs}ms cell, `
      + `heartbeat ${cfg.runHeartbeatMs}ms, poll ${cfg.runPollMs}ms, `
      + `retry backoff ${cfg.runRetryBackoffMs}ms, `
      + `${cfg.runAttemptsMax} attempt(s), ${cfg.workspaceRunConcurrency} cell(s) per workspace`,
    // The parse queue's own bounds, on their own line. It is a SEPARATE
    // queue with a separate failure — one slow document at the head of a
    // single-slot FIFO blocks every upload in the deployment — and its caps
    // were the fourth undeclared-cap defect on the scanned-document path.
    `Parse queue: read within ${cfg.parseTimeoutMs}ms, `
      + `report a document still waiting after ${cfg.parseStuckReportMs}ms`,
    `Events: kept ${cfg.eventRetentionDays} day(s), at most ${cfg.eventPageMax} per page`,
    // The socket's caps on their own line, for the same reason the queue's
    // are: "why did everyone's live view go quiet" is answered by the ping
    // interval and the connection ceiling, and an operator must not have to
    // read the source to find either.
    `Live socket: ping ${cfg.wsPingMs}ms, fan-out tick ${cfg.hubTickMs}ms, `
      + `at most ${cfg.wsMaxConnections} connection(s) `
      + `per replica, ${cfg.wsMaxSubscriptions} subscription(s) per socket, `
      + `frames up to ${cfg.wsMaxFrameBytes} bytes`,
    // Presence on its own line, and both numbers on it. "Why does a
    // colleague keep flickering on and off the roster" is answered by the
    // ratio of these two and by nothing else, and an operator must not have
    // to read the source to find either.
    `Presence: heartbeat ${cfg.presenceHeartbeatMs}ms, believed for ${cfg.presenceTtlMs}ms, `
      + 'never persisted',
    `Database: ${redactDsn(cfg.databaseUrl)}`,
    // The WORKER's connection, named separately and redacted the same way.
    // Which role the engine holds is the fact that makes "the worker cannot
    // touch a human's judgement" true, so it belongs where an operator can
    // see it rather than inside a pool nobody prints.
    `Engine: ${redactDsn(cfg.databaseWorkerUrl)} (pool ${cfg.workerPoolMax})`,
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
