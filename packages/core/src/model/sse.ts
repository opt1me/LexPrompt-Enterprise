import {
  ModelError, isModelErrorCode, truncationRefusal,
  type ModelErrorCode, type InferUsage, type Jurisdiction, type ProviderId,
  type StopReason,
} from './protocol.ts';

/**
 * The ONE SSE event splitter in this system (P1).
 *
 * Five providers means five event framings, and the naive reading of that
 * is five parsers — five surfaces for a bug this project has already paid
 * for twice. The decomposition that avoids it separates the two problems:
 * everything TRANSPORT (chunk boundaries, CRLF, the final flush) lives
 * here and is written once; everything PROVIDER-SPECIFIC is a pure
 * `decodeEvent(rawEvent) => AdapterEvent | null` inside that provider's
 * adapter, with no buffering and no knowledge of chunking, tested offline
 * against a recorded fixture (P5).
 *
 * It is `openrouter.ts`'s `chatStream` loop, lifted out and given a name,
 * because both of its hard-won behaviours were bugs this project shipped:
 *
 *  - CRLF normalisation on the BUFFER, not per line: a CRLF-terminated
 *    event never matches `\n\n` (there is a stray `\r` between the two
 *    `\n`s), so the whole stream parsed as empty — no error, no deltas,
 *    nothing. For a panel answering questions about a contract that is
 *    worse than a visible failure.
 *  - `flush()`: a stream can end without a trailing blank line after the
 *    final event, and that event may carry the last content delta. Dropping
 *    it gives the caller a truncated-but-apparently-successful response.
 *
 * The gateway runs it over whichever provider's stream it opened; the
 * browser runs it over the gateway's. `apps/api` runs it over nothing,
 * because `apps/api` pipes bytes and parses nothing at all.
 */
export function createSseEventReader(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      // Normalise CRLF -> LF on the ACCUMULATED buffer, not on the
      // incoming chunk in isolation. A chunk boundary can fall between the
      // `\r` and the `\n` of one separator (the `\r` arrives at the end of
      // one push, the `\n` at the start of the next); normalising each
      // chunk before concatenation leaves that split pair unmatched
      // forever, which is a variant of the exact defect this reader
      // exists to close, just moved from "CRLF vs LF" to "CRLF split
      // across a chunk boundary". Normalising the joined buffer instead
      // means the pair is always intact by the time the replace runs.
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      return parts.filter(p => p.trim().length > 0);
    },
    flush(): string[] {
      // A lone trailing `\r` can survive normalisation when a chunk ended
      // mid-separator and nothing followed it.
      const rest = buffer.replace(/\r/g, '').trim();
      buffer = '';
      return rest ? [rest] : [];
    },
  };
}

/**
 * The `event:` and `data:` fields of one raw SSE event.
 *
 * Exported because every provider adapter needs exactly this and nothing
 * more before it starts reading its own JSON — and five hand-rolled line
 * scanners is precisely the drift S14 exists to prevent, in the one place
 * where a missing `\r` guard has already cost this project a silent
 * empty stream. Anthropic puts its discriminator on the `event:` line, so
 * both fields are returned rather than only `data`.
 */
export function sseFields(rawEvent: string): { event: string | null; data: string | null } {
  let event: string | null = null;
  const data: string[] = [];
  for (const rawLine of rawEvent.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('event:')) {
      const name = line.slice(6).trim();
      if (name) event = name;
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    }
  }
  const joined = data.join('\n').trim();
  return { event, data: joined ? joined : null };
}

function dataPayload(rawEvent: string): string | null {
  return sseFields(rawEvent).data;
}

/**
 * `done` carries `provider` and `jurisdiction` alongside `usage` and
 * `callId`, and both are REQUIRED.
 *
 * The non-streamed `InferResponse` already returns them (protocol.ts:
 * "Returned, not just logged, so the browser can show it rather than
 * assert it"), and a streamed answer is the same answer. Without them on
 * the wire the browser's stream client would have to invent a provider and
 * a region to satisfy `InferResponse` — a firm believing it is UK-only
 * while a US region answered is precisely what S27 exists to prevent, and
 * a plausible-looking invented value is the failure mode this project's
 * one rule names.
 *
 * Required rather than optional so a producer cannot omit them: a `done`
 * frame missing either does not decode (see `decodeFrame`), which
 * `readFrames` then reports as a truncated stream rather than resolving
 * with a blank jurisdiction.
 */
export type Frame =
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      usage: InferUsage;
      callId: string;
      provider: ProviderId;
      jurisdiction: Jurisdiction;
      /**
       * Why the model stopped — REQUIRED, for the same reason `provider`
       * and `jurisdiction` are.
       *
       * Without it on the wire, a completion the provider cut off at
       * `max_tokens` is indistinguishable, everywhere downstream, from one
       * the model chose to end: the browser renders the fragment, with no
       * marker of any kind, and a lawyer acts on a list missing its tail.
       * `sse.ts` already refuses to let a dropped SOCKET wear a `done`
       * frame; this is the same rule for the far likelier case, where the
       * socket is fine and the ANSWER is the thing that stopped.
       *
       * A producer that omits it writes a frame that does not decode (see
       * `decodeFrame`), which `readFrames` reports as a truncated stream —
       * fail-closed, rather than a fragment resolving as an answer.
       */
      stopReason: StopReason;
    }
  | { type: 'error'; code: ModelErrorCode; status: number; message: string; callId: string };

/** One SSE event, terminated by the blank line that ends it. */
export function encodeFrame(frame: Frame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export function decodeFrame(rawEvent: string): Frame | null {
  const payload = dataPayload(rawEvent);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Frame;
    if (parsed?.type === 'delta' && typeof parsed.text === 'string') return parsed;
    if (parsed?.type === 'done' && parsed.usage && typeof parsed.callId === 'string'
      && typeof parsed.provider === 'string'
      && typeof parsed.stopReason === 'string'
      && !!parsed.jurisdiction && typeof parsed.jurisdiction.bloc === 'string') return parsed;
    // As strict as `done`, and for the same reason it took a review to
    // notice was missing here. An `error` frame accepted on its `message`
    // alone decoded to `new ModelError(msg, undefined, undefined)`, whose
    // `retryable`, `isSignInError` and `isServiceConfigError` were all
    // false by accident — a firm-configuration fault reaching a lawyer as
    // an ordinary one, which is exactly what M3/M2's wording rules exist to
    // prevent one layer up. A frame that fails this is refused, and
    // `readFrames` reports the stream as truncated: still loud, and
    // honestly so, since a frame this malformed is not a classification
    // anyone should act on.
    if (parsed?.type === 'error' && typeof parsed.message === 'string'
      && typeof parsed.callId === 'string' && typeof parsed.status === 'number'
      && isModelErrorCode(parsed.code)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads a gateway stream to its end.
 *
 * P2: a stream is complete or it is an error. It resolves ONLY on a `done`
 * frame. A stream that stops — a dropped socket, a killed container, a
 * proxy timeout — throws `stream_truncated` rather than handing back the
 * fragment that did arrive, because a half-answer about a contract that
 * looks like a whole one is this project's founding defect wearing a
 * network cable.
 *
 * A stream-level rejection (an abort, a socket error) propagates unwrapped
 * and un-retried, exactly as `openrouter.ts`'s `chatStream` was careful to
 * do: a cancellation is a deliberate user decision.
 */
export interface StreamEnd {
  usage: InferUsage;
  callId: string;
  provider: ProviderId;
  jurisdiction: Jurisdiction;
  /** Why the model stopped. Never `'length'` on a resolved stream —
   *  `readFrames` throws on that rather than returning. */
  stopReason: StopReason;
}

export async function readFrames(
  stream: AsyncIterable<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<StreamEnd> {
  const reader = createSseEventReader();
  const decoder = new TextDecoder();
  let terminal: Frame | null = null;

  const handle = (raw: string): void => {
    if (terminal) return;
    const frame = decodeFrame(raw);
    if (!frame) return;
    if (frame.type === 'delta') onDelta(frame.text);
    else terminal = frame;
  };

  for await (const chunk of stream) {
    for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) handle(raw);
    if (terminal && terminal.type === 'error') break;
  }
  const tail = decoder.decode();
  if (tail) for (const raw of reader.push(tail)) handle(raw);
  for (const raw of reader.flush()) handle(raw);

  const end = terminal as Frame | null;
  if (end && end.type === 'done') {
    // Defence in depth, and the second consumer's own guard: the gateway
    // refuses a `length` completion before it ever writes a `done` frame,
    // so this should be unreachable in a matched pair — but the browser is
    // a separately deployed half of this protocol, and the ONE decision
    // about a truncated answer is shared rather than trusted to hold at the
    // far end. `truncationRefusal` is that decision; this is not a second
    // copy of it.
    const truncated = truncationRefusal(end.stopReason, end.callId);
    if (truncated) throw truncated;
    return {
      usage: end.usage, callId: end.callId,
      provider: end.provider, jurisdiction: end.jurisdiction,
      stopReason: end.stopReason,
    };
  }
  if (end && end.type === 'error') throw new ModelError(end.message, end.code, end.status, end.callId);
  throw new ModelError(
    'The answer stopped before it finished. Nothing was lost, but what arrived is incomplete — ask again.',
    'stream_truncated',
    0,
  );
}
