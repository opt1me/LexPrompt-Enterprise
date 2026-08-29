import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest,
} from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Principal } from './oidc.ts';
import type { GatewayClient } from './gatewayClient.ts';
import type { Actor } from './auth/actor.ts';
import type { Db } from './db/pool.ts';
import { registerInfer } from './routes/infer.ts';
import { registerInferStream } from './routes/inferStream.ts';
import { registerMe } from './routes/me.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` once a bearer token has been verified against
     *  the configured issuer. Absent on `/healthz`, which is excluded from
     *  the hook by URL, exactly as the gateway excludes it (Task 15). */
    principal?: Principal;
    /** Set by the SAME preHandler that sets `principal`, once, so no route
     *  resolves an actor of its own. A route reading `req.actor!` reads a
     *  value the hook guarantees; a route that resolved its own would be a
     *  second implementation of provisioning. */
    actor?: Actor;
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
  /** `ApiConfig.maxBodyBytes` — see there for why this hop declares a limit
   *  rather than inheriting Fastify's undeclared 1 MiB. */
  maxBodyBytes: number;
  /** The app role's connection (Task 2). Used directly by `/v1/me`'s PUT
   *  handler; every OTHER write that needs a person's identity goes through
   *  `resolveActor` instead, so this is not a second route to provisioning. */
  db: Db;
  /** Just-in-time provisioning (§7, Task 2's `app_user`): resolves a
   *  validated `Principal` to the `app_user` row it names, creating one on
   *  first sight. Injected, so a route test needs no database and so Task
   *  4's role lookup has exactly one place to live. */
  resolveActor(principal: Principal): Promise<Actor>;
}

/**
 * Everything Fastify itself refuses, answered in LexPrompt's envelope.
 *
 * Without this, a 413 (a body over `maxBodyBytes`), a 415 (wrong
 * content-type), a 400 (malformed JSON) and a 404 all come back as
 * `{statusCode, error, message, code}` — Fastify's own shape, which
 * `gatewayModelClient` reads as `body.error.code`, finds nothing in, and
 * renders to a lawyer as the bare string "HTTP 413". A status number with no
 * cause and no action is the quiet-wrong-answer shape this project's one
 * rule is about, one layer down.
 *
 * A `ModelError` thrown out of a handler keeps its own status and code, for
 * the same reason `requireUser` answers one verbatim: `group_overage` is a
 * 403 that must not become a 401.
 */
function registerErrorEnvelope(app: FastifyInstance, maxBodyBytes: number): void {
  app.setNotFoundHandler(async (request, reply) => reply.code(404).send({
    error: {
      code: 'unknown',
      message: `LexPrompt has no ${request.method} ${request.url} endpoint.`,
    },
  }));

  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    if (err instanceof ModelError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      return reply.code(413).send({ error: {
        code: 'prompt_too_large',
        message: 'This request is larger than LexPrompt accepts in one call '
          + `(the limit is ${maxBodyBytes} bytes, set by API_MAX_BODY_BYTES). A scanned `
          + 'document sends an image of every page, so a long scan can exceed it; '
          + 'reviewing fewer documents at once is the thing to try, and an '
          + 'administrator can raise the limit.',
      } });
    }
    if (status === 415 || status === 400) {
      return reply.code(status).send({ error: {
        code: 'unknown',
        message: `LexPrompt could not read this request (${err.message}).`,
      } });
    }
    // Anything genuinely unexpected. The message is the error's own, not a
    // reassuring summary: a 500 nobody can describe is worse than a 500 that
    // says what threw.
    process.stderr.write(`api: unhandled error on ${request.method} ${request.url}: ${err.stack ?? err.message}\n`);
    return reply.code(status >= 400 ? status : 500).send({ error: {
      code: 'unknown',
      message: `LexPrompt failed to handle this request (${err.message}).`,
    } });
  });
}

/**
 * This derives a `Principal`, resolves it to an `app_user` row on the SAME
 * hook (Task 2's just-in-time provisioning), answers `/healthz`, forwards
 * `/v1/infer`, `/v1/infer/stream` and `/v1/models` to the gateway with the
 * actor overwritten from the token (Task 17, reused by Task 18 for the
 * streaming route), and answers `/v1/me`. There is still no role gate —
 * `role` is provisioned from whatever `resolveActor` was handed, and reading
 * a group claim into one is Task 4's.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: deps.maxBodyBytes });

  registerErrorEnvelope(app, deps.maxBodyBytes);

  const auth = requireUser(deps.verify);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    await auth(req, reply);
    // `requireUser` answers the reply itself on failure and `reply.sent`
    // records that. Continuing past it would resolve an actor for a caller
    // that has already been refused — and would create an `app_user` row for
    // a token that did not validate.
    if (reply.sent) return;
    req.actor = await deps.resolveActor(req.principal!);
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerInfer(app, deps.gateway, deps.workspaceId);
  registerInferStream(app, deps.gateway, deps.workspaceId);
  registerMe(app, deps.db);

  return app;
}
