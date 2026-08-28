import { sseFields, type InferUsage, type ProviderId } from '@lexprompt/core';
import type { ResolvedCredential } from '../credentials/types.ts';
import type { AdapterCall, AdapterEvent, AdapterRequest, ProviderAdapter } from './types.ts';

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

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

    readResponse(body: unknown): { content: string; usage: InferUsage } {
      const b = body as {
        choices?: { message?: { content?: unknown } }[];
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
      };
    },

    decodeEvent(rawEvent: string): AdapterEvent | null {
      const { data } = sseFields(rawEvent);
      if (!data) return null;
      if (data === '[DONE]') return { kind: 'end' };
      let parsed: {
        choices?: { delta?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; code?: unknown };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        return null;   // a malformed event is skipped, never fails the stream
      }
      if (parsed.error) {
        const status = Number(parsed.error.code);
        return {
          kind: 'error',
          status: Number.isFinite(status) && status >= 400 ? status : 502,
          message: parsed.error.message ?? 'The provider reported an error mid-stream.',
        };
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) return { kind: 'delta', text: delta };
      if (parsed.usage) {
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.usage.prompt_tokens ?? 0),
            completionTokens: Number(parsed.usage.completion_tokens ?? 0),
          },
        };
      }
      return null;
    },
  };
}

export { trimSlash };
