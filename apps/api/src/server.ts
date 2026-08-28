import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Principal } from './oidc.ts';
import type { GatewayClient } from './gatewayClient.ts';
import { registerInfer } from './routes/infer.ts';
import { registerInferStream } from './routes/inferStream.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` once a bearer token has been verified against
     *  the configured issuer. Absent on `/healthz`, which is excluded from
     *  the hook by URL, exactly as the gateway excludes it (Task 15). */
    principal?: Principal;
  }
}

export type TokenVerifier = (token: string) => Promise<Principal>;

/**
 * The one preHandler standing between every route and an unauthenticated
 * caller. There is no configuration value that skips this (S29) — the only
 * thing that varies across environments is which `verify` function main.ts
 * builds from which issuer.
 *
 * A `group_overage` reaches the browser as 403 `group_overage`, not folded
 * into a generic 401 — `ModelError`'s own status and code are answered back
 * verbatim, because "sign in again" and "ask your admin" are different
 * instructions and this is the one place that distinction can get lost.
 */
export function requireUser(verify: TokenVerifier) {
  return async function requireUserHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      void reply.code(401).send({
        error: { code: 'sign_in_required', message: 'Sign in to use LexPrompt.' },
      });
      return;
    }
    try {
      req.principal = await verify(token);
    } catch (err) {
      if (err instanceof ModelError) {
        void reply.code(err.status).send({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  };
}

export interface ServerDeps {
  verify: TokenVerifier;
  /** Where a validated call is forwarded (Task 17). */
  gateway: GatewayClient;
  /** The single workspace §6 seeds — Stage 1 has no workspace resolution. */
  workspaceId: string;
}

/**
 * Stage 1 boundary (§13): this derives a `Principal`, answers `/healthz`,
 * and forwards `/v1/infer`, `/v1/infer/stream` and `/v1/models` to the
 * gateway with the actor overwritten from the token (Task 17, reused by
 * Task 18 for the streaming route) — never a role gate, never an
 * `app_user` row, both of which stay Stage 2.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({ logger: false });

  const auth = requireUser(deps.verify);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    return auth(req, reply);
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerInfer(app, deps.gateway, deps.workspaceId);
  registerInferStream(app, deps.gateway, deps.workspaceId);

  return app;
}
