import type { FastifyInstance } from 'fastify';
import { ModelError, type AllowedModel, type ProvidersPage } from '@lexprompt/core';
import type { GatewayClient } from '../../gatewayClient.ts';
import { callerAuthRefusal, unreachableGateway } from '../../gatewayFailure.ts';

/**
 * WHAT AN ADMINISTRATOR CAN SEE ABOUT THE FIRM'S PROVIDERS — a READ, and
 * there is no write route at all.
 *
 * ## The absence of a write is the design
 *
 * S14: the allowlist has ONE home, the gateway, and `apps/api` holds no copy
 * of it. So there is nothing here for a write route to write: a provider is
 * added by editing the operator's `models.json` and redeploying the gateway.
 * The screen says that in words rather than by showing disabled inputs,
 * because a form that cannot be submitted is a form somebody will keep
 * trying to submit.
 *
 * ## An unreachable gateway is a LOUD 503 and never an empty list
 *
 * An empty provider list reads as *"this deployment has no providers
 * configured"*, which is a statement about the firm's own configuration that
 * this API is in no position to make. `unreachableGateway` is the shared
 * refusal every other gateway hop already uses.
 *
 * ## Nothing from the upstream body is passed through verbatim
 *
 * A proxy that forwards an upstream error body is how a redaction one hop up
 * gets undone. The two upstream responses are read for the fields this route
 * names and for nothing else; a failure becomes this route's own sentence.
 */

/** The joined answer: the allowlist as a browser may see it, plus the
 *  credential status of each provider those models route to. */
export interface AdminProvidersPage {
  models: AllowedModel[];
  providers: ProvidersPage['providers'];
  declaredJurisdictions: ProvidersPage['declaredJurisdictions'];
}

export function registerAdminProviders(
  app: FastifyInstance, gateway: GatewayClient,
): void {
  app.get('/v1/admin/providers', async (): Promise<AdminProvidersPage> => {
    let models: { status: number; json: unknown };
    let credentials: { status: number; json: unknown };
    try {
      // BOTH, together. A screen that could render the allowlist without the
      // credential status would render "which providers" with no answer to
      // "and does this deployment have a key for them", which is the pair
      // §12.0 exists to keep together.
      [models, credentials] = await Promise.all([gateway.models(), gateway.credentials()]);
    } catch (err) {
      throw unreachableGateway(err, 'provider list');
    }

    for (const [what, res] of [['model list', models], ['credential status', credentials]] as const) {
      const refusal = callerAuthRefusal(res.status);
      if (refusal) throw refusal;
      if (res.status !== 200) {
        throw new ModelError(
          `LexPrompt could not read this deployment's ${what} from the gateway `
          + `(it answered ${res.status}). Nothing about the providers is shown rather than `
          + 'an empty list, because an empty list would read as "this firm has no providers '
          + 'configured".',
          'service_misconfigured', 503,
        );
      }
    }

    const page = credentials.json as Partial<ProvidersPage> | null;
    return {
      models: (models.json as { models?: AllowedModel[] } | null)?.models ?? [],
      providers: page?.providers ?? [],
      declaredJurisdictions: page?.declaredJurisdictions ?? [],
    };
  });
}
