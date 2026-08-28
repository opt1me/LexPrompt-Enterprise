import type { FastifyInstance } from 'fastify';

/** Liveness only. It deliberately reports NOTHING about configuration — a
 *  health endpoint listing models or providers would be an unauthenticated
 *  read of the allowlist. */
export function registerHealth(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' }));
}
