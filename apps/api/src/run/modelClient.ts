import {
  ModelError, parseJsonLoose, modelErrorFrom, inferResponseFrom,
  type AllowedModel, type InferRequest, type InferResponse, type ModelClient,
} from '@lexprompt/core';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Actor } from '../auth/actor.ts';
import { withActor } from '../actorBody.ts';

/**
 * The engine's route to a model: the SAME gateway client the inference proxy
 * uses, with the SAME actor body.
 *
 * `apps/api` may not egress (§5) and this does not change that — every call
 * still leaves through the gateway, which is the only service on a routable
 * network and the only one holding a provider credential.
 *
 * `actor` is the person who ASKED FOR THE RUN, never a service identity. The
 * gateway's call log is what answers "where has privileged text been
 * processed, and on whose behalf" (§10, §12 Q5); a worker that logged itself
 * as the actor would make every server-side review anonymous in the one
 * record that exists to say otherwise. `withActor` is reused rather than
 * rebuilt for exactly the reason its own docstring gives: the client body is
 * spread FIRST and the actor fields overwrite it, so nothing a request
 * carries can put a colleague's name on a call.
 *
 * ## Why only two of the four methods do anything
 *
 * `ModelClient` has four. The extractors call exactly one — `chatJson` — and
 * `chat` is here only because `chatJson` is defined in terms of it, the same
 * way the browser's client defines it. The other two THROW, and that is the
 * deliberate choice over a plausible stub:
 *
 *  - `chatStream` would need this hop to hold a stream open for the length
 *    of a review, and nothing server-side streams yet. A version that
 *    quietly returned the non-streamed answer would look like it worked.
 *  - `listModels` is the browser's question, asked to populate a Settings
 *    dropdown. An engine that answered it with an empty array would report
 *    "no model is configured" — the empty-versus-broken confusion this
 *    codebase has a rule about — to a caller that had no business asking.
 *
 * An unused method that throws is a loud failure the day someone needs it.
 * One that half-works is a quiet wrong answer.
 */
export function workerModelClient(
  gateway: GatewayClient,
  workspaceId: string,
  actor: Actor,
): ModelClient {
  /**
   * `signal` is accepted and NOT forwarded, and that is a real limitation
   * rather than an oversight, so it is written down here where a caller will
   * look. `GatewayClient.infer` takes no signal — only `stream` does — so a
   * cancelled server-side run stops issuing NEW calls (`mapWithConcurrency`
   * checks its signal between cells) while the ones already in flight run to
   * completion and are discarded. The alternative on offer today is to
   * pretend otherwise by ignoring the parameter silently.
   */
  const chat = async (req: InferRequest, _signal?: AbortSignal): Promise<InferResponse> => {
    const { status, json } = await gateway.infer(
      withActor({ ...req } as unknown as Record<string, unknown>, workspaceId, actor),
    );
    if (status >= 400) throw modelErrorFrom(status, json);
    return inferResponseFrom(json);
  };

  return {
    chat,
    // `parseJsonLoose`, exactly as the browser does it: models vary in schema
    // adherence and a run must not fail because one added "Sure! Here you
    // go:". Shared from core rather than re-derived — a server-side review
    // that could not read a response the browser can would produce a
    // different finding for the same document.
    chatJson: async <T>(req: InferRequest, signal?: AbortSignal): Promise<T> =>
      parseJsonLoose<T>((await chat(req, signal)).content),
    chatStream: (): Promise<InferResponse> => {
      throw new ModelError(
        'Server-side runs do not stream. This client is the review engine\'s route to a model '
        + 'and implements only the call the extractors make.',
        'unknown', 501,
      );
    },
    listModels: (): Promise<AllowedModel[]> => {
      throw new ModelError(
        'The review engine does not list models. The allowlist is read through '
        + '/v1/models by the browser, which is the only caller that needs it.',
        'unknown', 501,
      );
    },
  };
}
