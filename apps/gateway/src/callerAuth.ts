import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TLSSocket } from 'node:tls';
import type { CallerAuthConfig } from './config.ts';

export type VerifyEntra = (token: string, tenantId: string, audience: string)
  => Promise<{ oid: string }>;

/**
 * §10: "Only `apps/api`, authenticated by its Azure managed identity (or
 * mTLS in local compose)."
 *
 * The gateway does NOT validate a user's token — it has no user model and
 * no roles. It validates its one caller. That is what makes
 * `workspaceId` and the actor in the request body trustworthy: they were
 * put there by `apps/api` from a token `apps/api` validated, and nothing
 * else can reach this port.
 *
 * The two modes never fall back to each other. A gateway configured for
 * mTLS that accepted a bearer token instead would be a gateway with two
 * front doors, one of which nobody remembered to lock.
 *
 * `config.mode === 'none'` is not reachable from any `GATEWAY_CALLER_AUTH`
 * value (`parseCaller` in config.ts refuses it unconditionally) — it exists
 * only so a unit test can construct one directly. Do not add a second path
 * to it here.
 */
export function makeCallerAuthHook(config: CallerAuthConfig, verifyEntra: VerifyEntra) {
  return async function callerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mode === 'none') return;

    if (config.mode === 'mtls') {
      const socket = req.raw.socket as TLSSocket;
      if (!socket.authorized) {
        void reply.code(401).send({
          error: {
            code: 'not_permitted',
            message: 'A client certificate is required to call this gateway.',
          },
        });
        return;
      }
      const cn = socket.getPeerCertificate()?.subject?.CN;
      if (cn !== config.allowedSubject) {
        void reply.code(401).send({
          error: {
            code: 'not_permitted',
            message: `Client certificate CN ${JSON.stringify(cn)} is not permitted.`,
          },
        });
        return;
      }
      return;
    }

    // config.mode === 'entra'
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      void reply.code(401).send({
        error: {
          code: 'not_permitted',
          message: 'This gateway is reachable only by the LexPrompt API.',
        },
      });
      return;
    }
    try {
      const { oid } = await verifyEntra(token, config.tenantId, config.audience);
      if (config.allowedObjectIds.length && !config.allowedObjectIds.includes(oid)) {
        // The oid goes to the log, not to the body: a 401 body that echoes
        // identity details is identity details in every proxy log between
        // here and the caller.
        process.stderr.write(`callerAuth: rejected oid ${oid}\n`);
        void reply.code(401).send({
          error: {
            code: 'not_permitted',
            message: 'This identity is not permitted to call the gateway.',
          },
        });
        return;
      }
    } catch (err) {
      process.stderr.write(`callerAuth: token rejected: ${(err as Error).message}\n`);
      void reply.code(401).send({
        error: {
          code: 'not_permitted',
          message: 'This gateway is reachable only by the LexPrompt API.',
        },
      });
      return;
    }
  };
}
