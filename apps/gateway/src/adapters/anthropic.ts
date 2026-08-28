import { sseFields, type InferUsage } from '@lexprompt/core';
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

  readResponse(body: unknown): { content: string; usage: InferUsage } {
    const b = body as {
      content?: { type?: string; text?: string; input?: unknown }[];
      usage?: { input_tokens?: number; output_tokens?: number };
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
    };
  },

  decodeEvent(rawEvent: string): AdapterEvent | null {
    const { data } = sseFields(rawEvent);
    if (!data) return null;
    let parsed: {
      type?: string;
      delta?: { type?: string; text?: string; partial_json?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { type?: string; message?: string };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;   // a malformed event is skipped, never fails the stream
    }

    switch (parsed.type) {
      case 'content_block_delta': {
        // A streamed forced tool call frames its JSON as `input_json_delta`
        // chunks rather than `text_delta` — both are text the caller
        // accumulates, so both surface as `delta`.
        const text = parsed.delta?.text ?? parsed.delta?.partial_json;
        return typeof text === 'string' && text ? { kind: 'delta', text } : null;
      }
      case 'message_start':
        // Anthropic splits usage across two events: input tokens arrive
        // here, output tokens in `message_delta` below. Task 12's stream
        // route accumulates by taking the max of each field across every
        // `usage` event rather than replacing, which is correct for this
        // split and for the OpenAI-shaped providers' single complete chunk
        // alike.
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.message?.usage?.input_tokens ?? 0),
            completionTokens: Number(parsed.message?.usage?.output_tokens ?? 0),
          },
        };
      case 'message_delta':
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.usage?.input_tokens ?? 0),
            completionTokens: Number(parsed.usage?.output_tokens ?? 0),
          },
        };
      case 'message_stop':
        return { kind: 'end' };
      case 'error':
        return {
          kind: 'error',
          // `overloaded_error` is Anthropic's 529; everything else that
          // arrives mid-stream is treated as a bad gateway, which is what
          // it is from the caller's point of view.
          status: parsed.error?.type === 'overloaded_error' ? 529 : 502,
          message: parsed.error?.message ?? 'The provider reported an error mid-stream.',
        };
      default:
        // `ping` and `content_block_start` carry nothing the caller needs.
        return null;
    }
  },
};
