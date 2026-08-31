import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { GatewayConfig } from './config.ts';
import type { Allowlist } from './allowlist.ts';
import type { AuditLogger } from './audit.ts';
import type { CredentialResolver } from './credentials/types.ts';
import type { buildRegistry } from './adapters/registry.ts';
import type { RateLimiter } from './rateLimit.ts';
import type { CallContext, Transport } from './callModel.ts';
import { makeCallerAuthHook, type VerifyEntra } from './callerAuth.ts';
import { registerHealth } from './routes/health.ts';
import { registerModels } from './routes/models.ts';
import { registerInfer, type InferBody } from './routes/infer.ts';
import { registerInferStream } from './routes/inferStream.ts';
import { registerAdminCredentials } from './routes/adminCredentials.ts';

export interface ServerDeps {
  config: GatewayConfig;
  allowlist: Allowlist;
  audit: AuditLogger;
  credentials: CredentialResolver;
  transport: Transport;
  limiter: RateLimiter;
  registry: ReturnType<typeof buildRegistry>;
  // Optional: only `mode: 'entra'` calls this. `mode: 'none'`/`'mtls'` never
  // reach it, so every existing test wiring a `ServerDeps` without one (they
  // all use `mode: 'none'` or `'mtls'`) keeps compiling. A deployment
  // actually running in `entra` mode with no `verifyEntra` wired fails
  // loudly at the first call, rather than silently admitting every caller.
  verifyEntra?: VerifyEntra;
  /**
   * What `GET /v1/admin/credentials` needs and cannot work out for itself.
   *
   * `fileRotatedAt` is the ONE rotation instant this gateway can report
   * without asking anybody for anything — the mtime of a mounted secret
   * file. Injected rather than read here so this module touches no
   * filesystem and every branch is testable with no disk.
   *
   * `log` writes ONE line, on the error path only, to the stream the boot
   * banner already goes to. `audit.ts` owns every CALL log line this service
   * writes (§10) and that is unchanged: this is a configuration fault, the
   * same class of thing as the startup banner, and it is the only place the
   * message of a caught error goes — it never reaches the response.
   */
  credentialStatus: {
    fileRotatedAt(path: string): Date | undefined;
    log(line: string): void;
  };
}

const NO_VERIFY_ENTRA: VerifyEntra = async () => {
  throw new Error(
    'GATEWAY_CALLER_AUTH=entra but no verifyEntra implementation was wired into ServerDeps.',
  );
};

/**
 * One `CallContext` builder, shared by the streamed and non-streamed
 * routes. `prepare` (Task 11) is where an unattributable call is refused —
 * this is just the wiring that gets it there, and a second copy of it is
 * exactly the sibling drift that would let the two routes silently read
 * `workspaceId`/`actorIssuer`/`actorSubject` differently from the request
 * body.
 */
function makeContext(deps: ServerDeps): (req: FastifyRequest) => CallContext {
  return (req) => {
    const body = (req.body ?? {}) as InferBody;
    return {
      ...deps,
      // Read off the body, not off the connection: `apps/api` fills them
      // from the token it validated (Task 17). They are passed through as
      // whatever arrived — including absent — because `prepare` is where an
      // unattributable call is refused, once, for the streamed and the
      // non-streamed path alike.
      workspaceId: String(body.workspaceId ?? ''),
      actorIssuer: String(body.actorIssuer ?? ''),
      actorSubject: String(body.actorSubject ?? ''),
      // ALONGSIDE the pair, never replacing it, and genuinely OPTIONAL
      // (unlike the two above): a Stage 1 `apps/api` in front of this
      // gateway during a rolling deploy sends no `actorUserId` at all, and
      // that call must still be attributable through the pair (§6.5).
      ...(body.actorUserId ? { actorUserId: String(body.actorUserId) } : {}),
    };
  };
}

/** What `main.ts` builds from `config.caller` when `mode === 'mtls'` and
 *  passes in here — the ONLY place this process opens an HTTPS listener
 *  instead of plain HTTP. `rejectUnauthorized: true` against the local CA
 *  is necessary but not sufficient on its own: it proves the client's
 *  certificate was signed by a CA this gateway trusts, not that the
 *  specific caller presenting it is `apps/api` — `callerAuth.ts`'s CN
 *  check (Task 15) is what narrows "any service the CA signed" down to
 *  "only apps/api". */
export interface MtlsHttpsOptions {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  requestCert: true;
  rejectUnauthorized: true;
}

export function buildServer(deps: ServerDeps, httpsOptions?: MtlsHttpsOptions): FastifyInstance {
  const app: FastifyInstance = httpsOptions
    ? Fastify({
      logger: false,
      bodyLimit: deps.config.maxPromptChars * 4,
      https: httpsOptions,
    })
    : Fastify({
      // audit.ts owns every log line this service writes (§10). Fastify's
      // own request logger would write URLs and headers on a service whose
      // whole discipline is that it logs metadata and never content.
      logger: false,
      bodyLimit: deps.config.maxPromptChars * 4,
    });
  // Only `apps/api` may call this gateway (Task 15). `/healthz` is excluded
  // by URL, ahead of the auth hook rather than inside it.
  //
  // What that exclusion actually buys differs by mode, and saying so matters
  // because the obvious reading — "a liveness probe needs no credential" —
  // is only half true:
  //
  //   entra: the server is plain HTTP behind internal-only ingress, so the
  //     platform's probe reaches `/healthz` with no token. The exclusion is
  //     doing real work here; without it every probe would 401.
  //
  //   mtls: `main.ts` sets `requestCert`/`rejectUnauthorized` at the TLS
  //     layer, so a caller presenting NO certificate fails the handshake
  //     before Fastify routes anything. This exclusion never runs for them.
  //     A compose healthcheck therefore MUST present the client certificate
  //     (`curl --cert certs/api.pem`); one written without it reports the
  //     gateway permanently unhealthy while the gateway is in fact fine —
  //     which restarts a healthy container on a schedule.
  //
  // Verified by hand against a running server, not inferred.
  const callerAuth = makeCallerAuthHook(deps.config.caller, deps.verifyEntra ?? NO_VERIFY_ENTRA);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    return callerAuth(req, reply);
  });
  registerHealth(app);
  registerModels(app, deps.allowlist);
  registerAdminCredentials(app, {
    models: deps.config.models,
    allowedJurisdictions: deps.config.allowedJurisdictions,
    readEnv: deps.config.readEnv,
    fileRotatedAt: deps.credentialStatus.fileRotatedAt,
  }, deps.credentialStatus.log);
  registerInfer(app, makeContext(deps));
  registerInferStream(app, makeContext(deps));
  return app;
}
