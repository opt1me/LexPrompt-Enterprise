const BASE = 'https://openrouter.ai/api/v1';
const MAX_ATTEMPTS = 3;

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  /**
   * USD price PER SINGLE TOKEN (not per million — OpenRouter's raw unit).
   * `null` means "unknown/variable price" — either the field was absent, or
   * OpenRouter reported its `-1` sentinel for a dynamic-routing pseudo-model
   * (e.g. `openrouter/auto-beta`) where a fixed per-token price doesn't apply.
   * A real free model reports `0`, which is a valid price and distinct from
   * `null`. Callers rendering this MUST NOT assume per-million units and
   * MUST handle `null` explicitly (e.g. show "variable" rather than "$0").
   */
  promptPrice: number | null;
  completionPrice: number | null;
  supportsStructuredOutput: boolean;
  supportsImages: boolean;
}

export class OpenRouterError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export interface ChatRequest {
  apiKey: string;
  modelId: string;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
}

/**
 * Parses a JSON object out of a model response, tolerating a prose preamble
 * or a markdown code fence. Models vary in schema adherence and a run must
 * not fail because one added "Sure! Here you go:".
 *
 * Scans EVERY candidate `{` position (not just the first) and returns the
 * LAST one that parses as valid JSON, rather than the first. Two reasons:
 *  - The first `{` in the text may not actually open valid JSON (e.g. a
 *    stray "{approx}" in prose before the real object) — bailing out after
 *    that one failure would wrongly throw despite valid JSON existing later.
 *  - When multiple *valid* JSON objects are present (e.g. the model shows an
 *    example before its real answer), the model's answer is the last one it
 *    writes, not the first. This function is the fallback path for models
 *    that don't honor strict schemas — precisely the ones most likely to
 *    waffle — so silently returning the wrong (first) object is a real risk,
 *    not a theoretical one: it produces a plausible-looking wrong finding
 *    instead of a visible error.
 * A successful match causes the scan to resume AFTER that match's closing
 * brace (not inside it), so a valid outer object's nested braces are never
 * reprocessed as separate candidates.
 */
export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to extraction
  }

  let lastValid: T | undefined;
  let found = false;
  let pos = 0;

  while (pos < text.length) {
    const start = text.indexOf('{', pos);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) {
      // Never balances to depth 0 before the text ends (truncated/unclosed).
      // Try the next '{' rather than giving up entirely.
      pos = start + 1;
      continue;
    }

    try {
      lastValid = JSON.parse(text.slice(start, end + 1)) as T;
      found = true;
      pos = end + 1; // resume after the whole match; don't descend into it
    } catch {
      pos = start + 1; // not valid JSON from this start; try the next '{'
    }
  }

  if (found) return lastValid as T;
  throw new Error(`Could not parse a JSON object from the model response: ${text.slice(0, 200)}`);
}

async function toError(response: Response): Promise<OpenRouterError> {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    // keep the status text
  }
  if (response.status === 401) message = `Your OpenRouter API key was rejected: ${message}`;
  if (response.status === 402) message = `Your OpenRouter account is out of credit: ${message}`;
  return new OpenRouterError(message, response.status);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function buildBody(req: ChatRequest) {
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
    model: req.modelId,
    messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.jsonSchema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
          },
        }
      : {}),
  };
}

export async function chat(req: ChatRequest, signal?: AbortSignal): Promise<string> {
  if (!req.apiKey) throw new Error('No OpenRouter API key is set. Add one in Settings.');
  if (!req.modelId) throw new Error('No model is selected. Choose one in Settings.');

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://lexprompt.app',
          'X-Title': 'LexPrompt',
        },
        body: JSON.stringify(buildBody(req)),
      });
    } catch (err) {
      // A network-level failure (offline, DNS, CORS) never reaches an HTTP
      // response — it throws a raw TypeError out of fetch() itself. Without
      // this catch it would skip the retry loop entirely (exactly the kind
      // of transient failure retry exists for) and propagate as a bare
      // TypeError instead of an OpenRouterError, crashing every downstream
      // caller that reads `.status`/`.retryable`. Status 0 is the sentinel
      // for "no HTTP response was received"; always retryable.
      const message = err instanceof Error ? err.message : String(err);
      const networkError = new OpenRouterError(`Network error contacting OpenRouter: ${message}`, 0);
      networkError.retryable = true;
      lastError = networkError;
      if (attempt < MAX_ATTEMPTS - 1) await wait(1000 * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('OpenRouter returned no message content.');
      return content;
    }

    const error = await toError(response);
    // Only 429 and 5xx are transient. Retrying a rejected key or an exhausted
    // balance just wastes the user's time.
    if (!error.retryable) throw error;
    lastError = error;
    if (attempt < MAX_ATTEMPTS - 1) await wait(1000 * 2 ** attempt);
  }
  throw lastError;
}

export async function chatJson<T>(req: ChatRequest, signal?: AbortSignal): Promise<T> {
  return parseJsonLoose<T>(await chat(req, signal));
}

/**
 * Maps a raw `pricing.prompt`/`pricing.completion` string (USD per single
 * token) to `number | null`. `null` covers both "field absent" and
 * OpenRouter's documented `-1` "variable price" sentinel (used by a handful
 * of dynamic-routing pseudo-models, e.g. `openrouter/auto-beta`) — a fixed
 * per-token cost doesn't exist for those, and leaking `-1` into ModelInfo
 * would render as a negative price. A real free model reports `"0"`, which
 * parses to the valid price `0`, not `null`.
 */
function parsePrice(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function listModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${BASE}/models`);
  if (!response.ok) throw await toError(response);
  const body = await response.json();
  const entries: unknown[] = Array.isArray(body?.data) ? body.data : [];

  return entries.map((entry): ModelInfo => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
    const architecture = (m.architecture ?? {}) as Record<string, unknown>;
    const modalities = Array.isArray(architecture.input_modalities)
      ? (architecture.input_modalities as string[])
      : [];
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;

    return {
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      contextLength: Number(m.context_length ?? 0),
      promptPrice: parsePrice(pricing.prompt),
      completionPrice: parsePrice(pricing.completion),
      // Deliberately structured_outputs ONLY, not an OR with response_format.
      // response_format alone only guarantees the weaker {type:'json_object'}
      // form; chat() always sends a strict json_schema payload when a schema
      // is supplied, and a model without structured_outputs may reject or
      // silently ignore that. 37/417 observed models have response_format
      // but not structured_outputs and must NOT be reported schema-capable.
      supportsStructuredOutput: params.includes('structured_outputs'),
      supportsImages: modalities.includes('image'),
    };
  }).filter(m => m.id);
}
