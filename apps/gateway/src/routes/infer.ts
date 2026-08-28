import { ModelError } from '@lexprompt/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { callModel, type CallContext } from '../callModel.ts';

export interface InferBody {
  workspaceId?: string;
  actorIssuer?: string;
  actorSubject?: string;
  [key: string]: unknown;
}

/**
 * The one place a failure becomes a response.
 *
 * `status === 0` is `network`'s "there was no HTTP response at all", which is
 * not a status a server may send — it becomes 502. Everything else keeps the
 * status the `ModelError` chose, so a refusal reaches the browser as the
 * thing it is: 400 for a model that is not allowlisted, 403 for a
 * jurisdiction this deployment does not permit, 503 for the firm's own
 * misconfiguration.
 */
export function sendModelError(reply: FastifyReply, err: unknown): void {
  const e = err instanceof ModelError
    ? err
    : new ModelError((err as Error)?.message ?? 'Unknown failure', 'unknown', 500);
  void reply.code(e.status === 0 ? 502 : e.status)
    .send({ error: { code: e.code, message: e.message, callId: e.callId } });
}

/**
 * `makeContext` reads `workspaceId`, `actorIssuer` and `actorSubject` from
 * the request BODY, which `apps/api` fills from the validated token (Task
 * 17). The gateway does not validate a user token — it trusts its one
 * caller, which is the whole point of the caller-auth boundary in Task 15.
 */
export function registerInfer(
  app: FastifyInstance,
  makeContext: (req: FastifyRequest) => CallContext,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const body = request.body as InferBody;
    try {
      const result = await callModel(makeContext(request), body as never);
      return await reply.send(result);
    } catch (err) {
      return sendModelError(reply, err);
    }
  });
}
