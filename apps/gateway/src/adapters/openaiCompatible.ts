import {
  sseFields, type InferUsage, type ProviderId, type StopReason,
} from '@lexprompt/core';
import type { ResolvedCredential } from '../credentials/types.ts';
import type { AdapterCall, AdapterEvent, AdapterRequest, ProviderAdapter } from './types.ts';

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * OpenAI's `finish_reason`, normalised to the gateway's `StopReason`.
 *
 * THE spelling difference lives here and only here. `'length'` is the one
 * that matters: it means the provider cut the answer off at the token
 * ceiling, and `truncationRefusal` (packages/core) turns that into a
 * refusal on both the streamed and the non-streamed path. Anthropic spells
 * the same fact `stop_reason: 'max_tokens'` and normalises it in its own
 * adapter; neither spelling appears in `callModel.ts` or in a route.
 *
 * `tool_calls`/`function_call` are `stop`: the model finished, and what it
 * finished with is a tool call. Anything recognised-but-unmapped
 * (`content_filter`) is `other`, never `stop` — see `StopReason`. An absent
 * reason is `unknown` rather than `stop`, because it is.
 *
 * A `Map`, not an object literal, so a provider sending
 * `finish_reason: "constructor"` cannot resolve an inherited property.
 */
const OPENAI_STOP: ReadonlyMap<string, StopReason> = new Map([
  ['stop', 'stop'],
  ['tool_calls', 'stop'],
  ['function_call', 'stop'],
  ['length', 'length'],
  ['max_tokens', 'length'],
]);

export function openAiStopReason(raw: unknown): StopReason {
  if (typeof raw !== 'string' || !raw) return 'unknown';
  return OPENAI_STOP.get(raw) ?? 'other';
}

/**
 * An OpenAI-shaped mid-stream error object, mapped to the HTTP status it
 * means — the same job `ANTHROPIC_ERROR_STATUS` does, for the same reason.
 *
 * `error.code` used to be read as `Number(parsed.error.code)` alone.
 * OpenAI's `code` is normally a STRING (`"invalid_api_key"`), so that
 * yielded `NaN` and fell back to 502 — which `isRetryableStatus` calls
 * retryable. A permanently rejected credential was therefore retried and
 * then reported as a transient provider blip: the wrong answer told
 * confidently, and at three times the cost.
 */
const OPENAI_ERROR_STATUS: ReadonlyMap<string, number> = new Map([
  ['invalid_request_error', 400],
  ['context_length_exceeded', 400],
  ['invalid_api_key', 401],
  ['authentication_error', 401],
  ['insufficient_quota', 402],
  ['billing_hard_limit_reached', 402],
  ['permission_error', 403],
  ['permission_denied', 403],
  ['not_found_error', 404],
  ['model_not_found', 404],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['server_error', 500],
]);

export function openAiErrorStatus(error: { code?: unknown; type?: unknown }): number {
  // A numeric code is the provider handing over the status directly, so it
  // wins when it really is one — which is what the original expression
  // meant, and what it got right for the relays that send a number.
  if (typeof error.code === 'number' && Number.isFinite(error.code) && error.code >= 400) {
    return error.code;
  }
  if (typeof error.code === 'string' && /^\d+$/.test(error.code) && Number(error.code) >= 400) {
    return Number(error.code);
  }
  for (const key of [error.code, error.type]) {
    if (typeof key === 'string') {
      const mapped = OPENAI_ERROR_STATUS.get(key);
      if (mapped !== undefined) return mapped;
    }
  }
  // A genuinely unknown provider failure is a bad gateway — the same
  // fallback, for the same reason, as the Anthropic adapter's.
  return 502;
}

/**
 * Four of the five providers speak OpenAI's chat-completions shape. They
 * differ ONLY in the URL they are reached at and the header the credential
 * goes in, so those two are parameters and everything else is written once.
 *
 * This is the extraction S14 asks for, made at the first duplication rather
 * than the third: writing `azureOpenai.ts` by copying `openai.ts` and
 * editing the URL is how the image-attachment shape, the strict-schema
 * flag and the `[DONE]` handling end up subtly different in four files that
 * nobody reads side by side.
 */
export function openAiCompatible(options: {
  id: ProviderId;
  url(entry: AdapterRequest['entry']): string;
  headers(entry: AdapterRequest['entry'], credential: ResolvedCredential): Record<string, string>;
}): ProviderAdapter {
  return {
    id: options.id,

    buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall {
      const messages: unknown[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });

      const content = req.images?.length
        ? [
            { type: 'text', text: req.user },
            ...req.images.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.data}` },
            })),
          ]
        : req.user;
      messages.push({ role: 'user', content });

      return {
        url: options.url(req.entry),
        headers: { 'Content-Type': 'application/json', ...options.headers(req.entry, credential) },
        body: {
          model: req.entry.model,
          messages,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
                },
              }
            : {}),
          ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        },
      };
    },

    readResponse(body: unknown): { content: string; usage: InferUsage; stopReason: StopReason } {
      const b = body as {
        choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = b?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        // Not an empty answer. A response with no message content is a
        // failed call wearing a 200, and returning '' from here would put
        // "the agreement is silent on this point" in a finding.
        throw new Error('The provider returned no message content.');
      }
      return {
        content,
        usage: {
          promptTokens: Number(b?.usage?.prompt_tokens ?? 0),
          completionTokens: Number(b?.usage?.completion_tokens ?? 0),
        },
        stopReason: openAiStopReason(b?.choices?.[0]?.finish_reason),
      };
    },

    decodeEvent(rawEvent: string): AdapterEvent[] {
      const { data } = sseFields(rawEvent);
      if (!data) return [];
      if (data === '[DONE]') return [{ kind: 'end' }];
      let parsed: {
        choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; code?: unknown; type?: unknown };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        return [];   // a malformed event is skipped, never fails the stream
      }
      if (parsed.error) {
        return [{
          kind: 'error',
          status: openAiErrorStatus(parsed.error),
          message: parsed.error.message ?? 'The provider reported an error mid-stream.',
        }];
      }
      // EVERY fact this event carries, never one INSTEAD of another. A
      // chunk holding both the last token and `finish_reason: "length"` is
      // permitted by OpenAI's shape, and it is precisely the case where
      // dropping either half is a defect this project has already shipped:
      // drop the delta and the answer loses its last token, drop the
      // finish_reason and a cut-off answer is served as a whole one.
      const events: AdapterEvent[] = [];
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) events.push({ kind: 'delta', text: delta });
      const finish = parsed.choices?.[0]?.finish_reason;
      if (typeof finish === 'string' && finish) {
        events.push({ kind: 'stop', reason: openAiStopReason(finish) });
      }
      if (parsed.usage) {
        events.push({
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.usage.prompt_tokens ?? 0),
            completionTokens: Number(parsed.usage.completion_tokens ?? 0),
          },
        });
      }
      return events;
    },
  };
}

export { trimSlash };
