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
      // A cancellation (AbortController.abort()) is a deliberate user
      // decision, not a transient fault — it must propagate immediately,
      // unwrapped, and must never be retried. Without this check it fell
      // into the network-error branch below and got retried 3 times over
      // ~3 seconds, during which the UI looks like it's still working right
      // when the user expects Cancel to have taken effect. Check both
      // shapes: a real DOMException (browsers) and a plain object with
      // `.name === 'AbortError'` (some environments/mocks don't produce an
      // actual DOMException).
      if ((err instanceof DOMException && err.name === 'AbortError') ||
          (err as { name?: string } | null)?.name === 'AbortError') {
        throw err;
      }
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
 * Streams a completion over SSE, invoking `onDelta` for each content
 * fragment as it arrives, and resolves with the full joined text once the
 * stream ends.
 *
 * Deliberately NOT retried, unlike `chat()`: a half-delivered stream can't be
 * resumed from the middle, and the caller (the interactive chat panel) can
 * simply be asked again. Because there is no retry loop, `fetch` and the
 * reader are never wrapped in a catch that could turn a cancellation into a
 * retried/wrapped error — a cancellation (AbortController.abort()) always
 * propagates as-is, immediately. This mirrors the fix applied to `chat()`
 * after a real bug: `chat()`'s network-error catch was unconditional and
 * retried an AbortError 3 times over ~3s before finally failing, so a
 * cancel-clicking user saw no immediate effect. chatStream never introduces
 * that catch in the first place, on either the initial fetch or the
 * `reader.read()` loop, so an abort surfaces immediately as itself.
 */
export async function chatStream(
  req: ChatRequest,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!req.apiKey) throw new Error('No OpenRouter API key is set. Add one in Settings.');
  if (!req.modelId) throw new Error('No model is selected. Choose one in Settings.');

  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://lexprompt.app',
      'X-Title': 'LexPrompt',
    },
    body: JSON.stringify({ ...buildBody(req), stream: true }),
  });

  if (!response.ok) throw await toError(response);
  if (!response.body) throw new Error('OpenRouter returned no response body to stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  // Parses one SSE event's `data:` lines and forwards any content delta.
  // Tolerates a trailing `\r` on an individual line — belt-and-braces beyond
  // the buffer-level CRLF normalisation below, in case a lone `\r` ever ends
  // up adjacent to a line split some other way.
  const processEvent = (event: string) => {
    for (const rawLine of event.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // A malformed event is skipped rather than failing the stream.
      }
    }
  };

  try {
    while (true) {
      // No try/catch here: if the signal aborts mid-stream, `reader.read()`
      // rejects (an AbortError, per the fetch spec) and that rejection
      // propagates straight out of this function as the caller's promise
      // rejection — not swallowed into a normal `done` completion and not
      // retried.
      const { done, value } = await reader.read();
      if (done) break;

      // Normalise CRLF to LF as data arrives, so a single separator style
      // (`\n\n`) reliably identifies event boundaries no matter what
      // OpenRouter's upstream proxies (it sits behind Cloudflare) do to line
      // endings. Without this, a CRLF-terminated event never matches
      // `\n\n` (there's a stray `\r` between the two `\n`s) and the whole
      // stream silently parses as empty — no error, no deltas, nothing —
      // which for a panel answering questions about a contract is worse
      // than a visible failure.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      // Events are separated by a blank line; a partial event stays in the buffer.
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) processEvent(event);
    }

    // The stream can end without a trailing blank-line separator after the
    // final event (the connection just closes right after the last chunk).
    // Flush any decoder-buffered bytes and process whatever is left as one
    // final event — otherwise that last event, which may carry the final
    // content delta, is silently dropped and the caller gets a
    // truncated-but-apparently-successful response.
    buffer += decoder.decode();
    if (buffer) processEvent(buffer);
  } finally {
    // Release the reader lock on every exit path — normal completion, a
    // thrown parse/network error, or an abort — so a non-abort mid-stream
    // failure never leaves `response.body` locked with nothing to release
    // it. (Harmless to call redundantly on an already-errored stream.)
    reader.releaseLock();
  }

  return full;
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
