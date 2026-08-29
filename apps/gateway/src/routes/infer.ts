import { ModelError } from '@lexprompt/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { callModel, type CallContext } from '../callModel.ts';

export interface InferBody {
  workspaceId?: string;
  actorIssuer?: string;
  actorSubject?: string;
  /** ALONGSIDE `actorIssuer`/`actorSubject`, never in place of them (§6.5).
   *  Absent from a Stage 1 caller during a rolling deploy. */
  actorUserId?: string;
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
      // For EVERY provider, not only `recorded` — a header present only for
      // one provider would make its absence carry meaning, which is the
      // blank-CSV-cell defect S27's own reasoning names. This is one of the
      // four places §5.1 requires a recorded answer to be marked; it is the
      // one that survives a caller reading only headers, never the body.
      void reply.header('X-LexPrompt-Provider', result.provider);
      return await reply.send(result);
    } catch (err) {
      return sendModelError(reply, err);
    }
  });
}
