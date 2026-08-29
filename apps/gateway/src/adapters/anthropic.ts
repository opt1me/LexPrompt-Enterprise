import { sseFields, type InferUsage, type StopReason } from '@lexprompt/core';
import type { ResolvedCredential } from '../credentials/types.ts';
import { trimSlash } from './openaiCompatible.ts';
import type { AdapterCall, AdapterEvent, AdapterRequest, ProviderAdapter } from './types.ts';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic's Messages API differs from the OpenAI shape in four ways, and
 * ALL FOUR are confined to this file. Nothing outside `adapters/` may
 * branch on a provider id — the moment `if (provider === 'anthropic')`
 * appears in a route, a call path or a client, this separation is gone and
 * the next difference gets handled in two places.
 *
 *  1. `system` is a top-level parameter, not a message.
 *  2. `max_tokens` is required.
 *  3. Images are base64 `source` blocks.
 *  4. Structured output is a forced tool call, and the answer arrives as a
 *     tool-use block whose `input` is the object. `readResponse`
 *     re-serialises it, so the gateway's contract — content is a string,
 *     and `parseJsonLoose` is the caller's fallback — is unchanged and
 *     nothing downstream can tell which provider answered.
 */

/**
 * Anthropic's mid-stream error `type` mapped to the HTTP status it means.
 *
 * This exists because the status is what decides whether the call is
 * retried: `isRetryableStatus` is `429 || >= 500`, so flattening the whole
 * taxonomy to 502 — as this adapter first did — made an
 * `authentication_error` and an `invalid_request_error` retryable. Retrying
 * a call that can never succeed burns the caller's time and quota, and
 * turns a permanent misconfiguration into what reads as a transient
 * provider blip: the loud, specific failure this project prefers arrives
 * late and wearing the wrong name.
 *
 * It also matches `openaiCompatible`'s rule rather than diverging from it.
 * That adapter already uses the provider's own status when it has one and
 * falls back to 502 only when it does not; Anthropic sends a well-defined
 * string taxonomy instead of a numeric code, so the lookup is how the same
 * rule is expressed for it. An unrecognised type still falls back to 502 —
 * a genuinely unknown provider failure is a bad gateway.
 *
 * A `Map`, not an object literal, for one reason worth a line of prose: an
 * object literal resolves INHERITED keys, so a provider sending
 * `error.type === "constructor"` or `"toString"` returned a truthy
 * *function* from the lookup, which then travelled onwards as the status.
 * `Map` has no prototype chain to walk into.
 */
const ANTHROPIC_ERROR_STATUS: ReadonlyMap<string, number> = new Map([
  ['invalid_request_error', 400],
  ['authentication_error', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['request_too_large', 413],
  ['rate_limit_error', 429],
  ['api_error', 500],
  ['overloaded_error', 529],
]);

function anthropicErrorStatus(type: string | undefined): number {
  return (type !== undefined ? ANTHROPIC_ERROR_STATUS.get(type) : undefined) ?? 502;
}

/**
 * Anthropic's `stop_reason`, normalised to the gateway's `StopReason`.
 *
 * DIFFERENCE 5, and the reason this function exists rather than an `if` in
 * `callModel`: Anthropic spells "I ran out of room" `max_tokens` where the
 * OpenAI-shaped providers spell it `length`. Both normalise inside their
 * own adapter, so the one place that DECIDES what a cut-off answer means
 * (`truncationRefusal`, packages/core) sees one vocabulary.
 *
 * `end_turn`, `stop_sequence` and `tool_use` are all "the model finished".
 * `refusal` and `pause_turn` are `other` — not `stop`, because the model
 * did not finish answering, and not `length`, because no ceiling was hit.
 * An absent reason is `unknown`; a `Map` for the same prototype reason as
 * the status table above.
 */
const ANTHROPIC_STOP: ReadonlyMap<string, StopReason> = new Map([
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['tool_use', 'stop'],
  ['max_tokens', 'length'],
]);

export function anthropicStopReason(raw: unknown): StopReason {
  if (typeof raw !== 'string' || !raw) return 'unknown';
  return ANTHROPIC_STOP.get(raw) ?? 'other';
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall {
    const content: unknown = req.images?.length
      ? [
          { type: 'text', text: req.user },
          ...req.images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.data },
          })),
        ]
      : req.user;

    return {
      url: `${trimSlash(req.entry.endpoint)}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        // Anthropic's native header is x-api-key regardless of which
        // credential variant the operator configured (S25: the adapter is
        // given its values, it never assumes which source produced them).
        // There is deliberately no `Authorization` header here.
        'x-api-key': credential.kind === 'api-key' ? credential.key : credential.token,
      },
      body: {
        model: req.entry.model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content }],
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.jsonSchema
          ? {
              tools: [{ name: 'result', description: 'Return the result.', input_schema: req.jsonSchema }],
              tool_choice: { type: 'tool', name: 'result' },
            }
          : {}),
        ...(req.stream ? { stream: true } : {}),
      },
    };
  },

  readResponse(body: unknown): { content: string; usage: InferUsage; stopReason: StopReason } {
    const b = body as {
      content?: { type?: string; text?: string; input?: unknown }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: unknown;
    };
    const blocks = b?.content ?? [];
    const text = blocks.filter(x => x.type === 'text').map(x => x.text ?? '').join('');
    const tool = blocks.find(x => x.type === 'tool_use');
    // The forced-tool-call path (DIFFERENCE 4): the answer arrives as a
    // tool-use block whose `input` IS the object, and it must be
    // re-serialised to a string here so the gateway's contract ("content is
    // a string") holds regardless of which provider answered. Returning
    // `text` alone when there is no text block would make every structured
    // call to Anthropic (every `chatJson`) look like an empty answer.
    const content = text || (tool ? JSON.stringify(tool.input) : '');
    if (!content) {
      // Not an empty answer. A response with no message content is a
      // failed call wearing a 200, and returning '' from here would put
      // "the agreement is silent on this point" in a finding.
      throw new Error('The provider returned no message content.');
    }
    return {
      content,
      usage: {
        promptTokens: Number(b?.usage?.input_tokens ?? 0),
        completionTokens: Number(b?.usage?.output_tokens ?? 0),
      },
      stopReason: anthropicStopReason(b?.stop_reason),
    };
  },

  decodeEvent(rawEvent: string): AdapterEvent[] {
    const { data } = sseFields(rawEvent);
    if (!data) return [];
    let parsed: {
      type?: string;
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: unknown };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { type?: string; message?: string };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];   // a malformed event is skipped, never fails the stream
    }

    switch (parsed.type) {
      case 'content_block_delta': {
        // A streamed forced tool call frames its JSON as `input_json_delta`
        // chunks rather than `text_delta` — both are text the caller
        // accumulates, so both surface as `delta`.
        const text = parsed.delta?.text ?? parsed.delta?.partial_json;
        return typeof text === 'string' && text ? [{ kind: 'delta', text }] : [];
      }
      case 'message_start':
        // Anthropic splits usage across two events: input tokens arrive
        // here, output tokens in `message_delta` below. Task 12's stream
        // route accumulates by taking the max of each field across every
        // `usage` event rather than replacing, which is correct for this
        // split and for the OpenAI-shaped providers' single complete chunk
        // alike.
        return [{
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.message?.usage?.input_tokens ?? 0),
            completionTokens: Number(parsed.message?.usage?.output_tokens ?? 0),
          },
        }];
      case 'message_delta':
        // TWO facts in one event, which is why `decodeEvent` returns an
        // array: `message_delta` carries the final output-token count AND
        // `delta.stop_reason` — the only place in an Anthropic stream that
        // says whether the answer was cut off at `max_tokens`. Returning
        // the usage alone, as this did, is how that fact never reached the
        // wire.
        return [
          {
            kind: 'usage',
            usage: {
              promptTokens: Number(parsed.usage?.input_tokens ?? 0),
              completionTokens: Number(parsed.usage?.output_tokens ?? 0),
            },
          },
          ...(parsed.delta?.stop_reason !== undefined && parsed.delta.stop_reason !== null
            ? [{ kind: 'stop' as const, reason: anthropicStopReason(parsed.delta.stop_reason) }]
            : []),
        ];
      case 'message_stop':
        return [{ kind: 'end' }];
      case 'error':
        return [{
          kind: 'error',
          status: anthropicErrorStatus(parsed.error?.type),
          message: parsed.error?.message ?? 'The provider reported an error mid-stream.',
        }];
      default:
        // `ping` and `content_block_start` carry nothing the caller needs.
        return [];
    }
  },
};
