import type { AllowedModel, InferRequest, InferResponse } from './protocol.ts';

/**
 * The seam §13 names for Stage 1: "openrouter.ts becomes a ModelClient
 * interface with one implementation pointing at the gateway". The shape is
 * `openrouter.ts`'s shape minus `apiKey` and minus `modelId` — a caller
 * names a purpose and an allowlist entry, never a provider model name
 * (S15), and never a provider: which backend answers is the operator's
 * configuration, not the call site's business.
 */
export interface ModelClient {
  chat(req: InferRequest, signal?: AbortSignal): Promise<InferResponse>;
  chatJson<T>(req: InferRequest, signal?: AbortSignal): Promise<T>;
  chatStream(
    req: InferRequest,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<InferResponse>;
  listModels(): Promise<AllowedModel[]>;
}
