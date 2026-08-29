import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Actor } from '../auth/actor.ts';
import { withActor } from '../actorBody.ts';
import { callerAuthRefusal, unreachableGateway } from '../gatewayFailure.ts';

export function registerInfer(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const actor = request.actor as Actor;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Actor overwrite shared with the streaming route (Task 18) via
    // `actorBody.ts` — see its docstring for why the overwrite happens
    // AFTER the spread. Uses the resolved `Actor` (Task 6), not the bare
    // `Principal`, so `actorUserId` can go alongside `actorIssuer`/
    // `actorSubject` rather than requiring a second resolution here.
    const body = withActor(client, workspaceId, actor);

    let status: number;
    let json: unknown;
    try {
      ({ status, json } = await gateway.infer(body));
    } catch (err) {
      const failure = unreachableGateway(err, 'inference');
      return reply.code(failure.status)
        .send({ error: { code: failure.code, message: failure.message } });
    }
    // Everything the gateway says is forwarded verbatim EXCEPT its
    // caller-auth 401, which is about this service's credentials and not
    // about the user's session. See `gatewayFailure.ts`.
    const refusal = callerAuthRefusal(status);
    if (refusal) {
      return reply.code(refusal.status)
        .send({ error: { code: refusal.code, message: refusal.message } });
    }
    return await reply.code(status).send(json);
  });

  app.get('/v1/models', async (_request, reply) => {
    let status: number;
    let json: unknown;
    try {
      ({ status, json } = await gateway.models());
    } catch (err) {
      const failure = unreachableGateway(err, 'model list');
      return reply.code(failure.status)
        .send({ error: { code: failure.code, message: failure.message } });
    }
    const refusal = callerAuthRefusal(status);
    if (refusal) {
      return reply.code(refusal.status)
        .send({ error: { code: refusal.code, message: refusal.message } });
    }
    return await reply.code(status).send(json);
  });
}
