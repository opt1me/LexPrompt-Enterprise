import { SERVICE_CONFIG_HINT } from '@lexprompt/core';
import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Principal } from '../oidc.ts';
import { withActor } from '../actorBody.ts';

export function registerInfer(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const principal = request.principal as Principal;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Actor overwrite shared with the streaming route (Task 18) via
    // `actorBody.ts` — see its docstring for why the overwrite happens
    // AFTER the spread.
    const body = withActor(client, workspaceId, principal);

    try {
      const { status, json } = await gateway.infer(body);
      return await reply.code(status).send(json);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'LexPrompt could not reach the firm\'s AI service. This is a configuration '
          + `problem in the deployment, ${SERVICE_CONFIG_HINT}. `
          + `(${(err as Error).message})` } });
    }
  });

  app.get('/v1/models', async (_request, reply) => {
    try {
      const { status, json } = await gateway.models();
      return await reply.code(status).send(json);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'The list of available models could not be loaded from the firm\'s AI service. '
          + `(${(err as Error).message})` } });
    }
  });
}
