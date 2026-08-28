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
  // because a liveness probe has neither a client certificate nor a token —
  // it is checked by URL, ahead of the auth hook itself, not inside it.
  const callerAuth = makeCallerAuthHook(deps.config.caller, deps.verifyEntra ?? NO_VERIFY_ENTRA);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    return callerAuth(req, reply);
  });
  registerHealth(app);
  registerModels(app, deps.allowlist);
  registerInfer(app, makeContext(deps));
  registerInferStream(app, makeContext(deps));
  return app;
}
