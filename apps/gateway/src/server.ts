import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config.ts';
import { registerHealth } from './routes/health.ts';

export interface ServerDeps {
  config: GatewayConfig;
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
  return app;
}
