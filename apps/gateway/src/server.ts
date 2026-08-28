import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { GatewayConfig } from './config.ts';
import type { Allowlist } from './allowlist.ts';
import type { AuditLogger } from './audit.ts';
import type { CredentialResolver } from './credentials/types.ts';
import type { buildRegistry } from './adapters/registry.ts';
import type { RateLimiter } from './rateLimit.ts';
import type { CallContext, Transport } from './callModel.ts';
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
}

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

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    // audit.ts owns every log line this service writes (§10). Fastify's own
    // request logger would write URLs and headers on a service whose whole
    // discipline is that it logs metadata and never content.
    logger: false,
    bodyLimit: deps.config.maxPromptChars * 4,
  });
  registerHealth(app);
  registerModels(app, deps.allowlist);
  registerInfer(app, makeContext(deps));
  registerInferStream(app, makeContext(deps));
  return app;
}
