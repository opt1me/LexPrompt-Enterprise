import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Principal } from '../oidc.ts';

export function registerInfer(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const principal = request.principal as Principal;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Spread FIRST, then overwrite. A client that could set the actor could
    // put a colleague's name on every call in the firm's audit log — which
    // corrupts the record that answers §12's questions, silently, and is
    // worse than any of the loud failures this stage defends against.
    // Never `{ workspaceId, actorIssuer, actorSubject, ...client }`.
    //
    // (issuer, subject), never an Entra-shaped id: `principal.subject` is
    // whatever the configured subjectClaim named, and the two halves stay
    // separate so Stage 2 can key app_user on the pair.
    const body = {
      ...client,
      workspaceId,
      actorIssuer: principal.issuer,
      actorSubject: principal.subject,
    };

    try {
      const { status, json } = await gateway.infer(body);
      return await reply.code(status).send(json);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'LexPrompt could not reach the firm\'s AI service. This is a configuration '
          + 'problem in the deployment, not something you can fix here. '
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
