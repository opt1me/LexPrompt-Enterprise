import { describe, it, expect } from 'vitest';
import {
  createSseEventReader, sseFields, encodeFrame, decodeFrame, readFrames,
} from './sse.ts';
import { ModelError, type Jurisdiction } from './protocol.ts';

const enc = new TextEncoder();

/** Every `done` frame carries where the call was processed; these two
 *  constants keep that fact out of the way of what each case is about. */
const UK_SOUTH: Jurisdiction = { bloc: 'UK', region: 'uksouth', label: 'UK South' };
const WHERE = { provider: 'openai' as const, jurisdiction: UK_SOUTH };

/** A `done` frame as an older producer would have written it. Hand-built as
 *  text because `encodeFrame` can no longer produce one: `Frame` requires
 *  both fields, which is the point. */
const DONE_NO_WHERE =
  '{"type":"done","usage":{"promptTokens":1,"completionTokens":1},"callId":"c1"}';
const DONE_NO_JURISDICTION =
  '{"type":"done","usage":{"promptTokens":1,"completionTokens":1},"callId":"c1","provider":"openai"}';

async function* streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield enc.encode(c);
}

describe('createSseEventReader — the one parser (P1)', () => {
  it('splits complete LF events and keeps a partial one buffered', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: b\n\ndata: par')).toEqual(['data: a', 'data: b']);
    expect(r.push('tial\n\n')).toEqual(['data: partial']);
    expect(r.flush()).toEqual([]);
  });

  // The defect this project already shipped once: a CRLF server produced
  // NOTHING — no error, no deltas — because `\r\n\r\n` never matches `\n\n`.
  it('parses CRLF-terminated events instead of silently returning nothing', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r\n\r\ndata: b\r\n\r\n')).toEqual(['data: a', 'data: b']);
  });

  it('handles a stream mixing LF and CRLF separators', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: b\r\n\r\ndata: c\n\n')).toEqual(['data: a', 'data: b', 'data: c']);
  });

  it('emits a CRLF event as soon as it arrives, not only at the end', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r\n\r\n')).toEqual(['data: a']);
  });

  // The other defect this project already shipped: the last event was
  // dropped when the connection closed without a trailing blank line.
  it('flush() yields a final event that arrived without a trailing blank line', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: last')).toEqual(['data: a']);
    expect(r.flush()).toEqual(['data: last']);
  });

  it('flush() yields nothing when the buffer holds only whitespace', () => {
    const r = createSseEventReader();
    r.push('data: a\n\n\n');
    expect(r.flush()).toEqual([]);
  });

  it('survives a chunk boundary in the middle of the separator', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r')).toEqual([]);
    expect(r.push('\n\r\ndata: b\n\n')).toEqual(['data: a', 'data: b']);
  });

  // Network chunks do not respect message boundaries. A boundary can land
  // anywhere — including inside a `\r\n` pair itself — so this checks every
  // possible split point rather than a hand-picked few.
  it('yields the same events no matter where the chunk boundary falls', () => {
    const whole = 'data: a\r\n\r\ndata: b\n\ndata: last';
    const expected = ['data: a', 'data: b', 'data: last'];
    for (let i = 0; i <= whole.length; i++) {
      const r = createSseEventReader();
      const out = [...r.push(whole.slice(0, i)), ...r.push(whole.slice(i)), ...r.flush()];
      expect(out).toEqual(expected);
    }
  });
});

describe('sseFields — the one field scanner every adapter starts from', () => {
  it('reads a data line', () => {
    expect(sseFields('data: {"a":1}')).toEqual({ event: null, data: '{"a":1}' });
  });

  it('reads an event name and a data line together (Anthropic\'s shape)', () => {
    expect(sseFields('event: content_block_delta\ndata: {"a":1}'))
      .toEqual({ event: 'content_block_delta', data: '{"a":1}' });
  });

  it('returns nulls for a keepalive comment and for an empty data line', () => {
    expect(sseFields(': keepalive')).toEqual({ event: null, data: null });
    expect(sseFields('data:')).toEqual({ event: null, data: null });
  });

  it('tolerates a trailing \\r left on an individual line', () => {
    expect(sseFields('event: ping\r\ndata: {"a":1}\r')).toEqual({ event: 'ping', data: '{"a":1}' });
  });

  it('joins multiple data lines with a newline, per the SSE spec', () => {
    expect(sseFields('data: one\ndata: two').data).toBe('one\ntwo');
  });
});

describe('the canonical frame codec', () => {
  it('round-trips a delta', () => {
    const raw = encodeFrame({ type: 'delta', text: 'Hello' }).replace(/\n\n$/, '');
    expect(decodeFrame(raw)).toEqual({ type: 'delta', text: 'Hello' });
  });

  it('round-trips a delta containing a newline and a brace', () => {
    const text = 'line one\nline {two}';
    const raw = encodeFrame({ type: 'delta', text }).replace(/\n\n$/, '');
    expect(decodeFrame(raw)).toEqual({ type: 'delta', text });
  });

  it('encodes one event terminated by a blank line', () => {
    expect(encodeFrame({ type: 'delta', text: 'x' })).toBe('data: {"type":"delta","text":"x"}\n\n');
  });

  it('round-trips done and error', () => {
    const done = {
      type: 'done' as const, usage: { promptTokens: 11, completionTokens: 3 }, callId: 'c1',
      ...WHERE,
    };
    expect(decodeFrame(encodeFrame(done).trim())).toEqual(done);
    const err = { type: 'error' as const, code: 'upstream_failed' as const, status: 502, message: 'boom', callId: 'c1' };
    expect(decodeFrame(encodeFrame(err).trim())).toEqual(err);
  });

  // A `done` frame is the browser's ONLY source of where the answer was
  // processed. One arriving without it would force the caller to invent a
  // provider and a region to satisfy `InferResponse`; refusing to decode it
  // means the stream reports itself incomplete instead of resolving with an
  // invented jurisdiction, which is what S27 exists to prevent.
  it('refuses to decode a done frame with no provider or jurisdiction', () => {
    expect(decodeFrame('data: ' + DONE_NO_WHERE)).toBe(null);
    expect(decodeFrame('data: ' + DONE_NO_JURISDICTION)).toBe(null);
  });

  it('returns null for a non-frame event rather than throwing', () => {
    expect(decodeFrame(': keepalive')).toBe(null);
    expect(decodeFrame('data: {"type":"nonsense"}')).toBe(null);
  });
});

describe('readFrames — a stream is complete or it is an error (P2)', () => {
  it('emits deltas in order and resolves with usage and call id', async () => {
    const seen: string[] = [];
    const result = await readFrames(
      streamOf(
        encodeFrame({ type: 'delta', text: 'Hel' }),
        encodeFrame({ type: 'delta', text: 'lo' }),
        encodeFrame({
          type: 'done', usage: { promptTokens: 5, completionTokens: 2 }, callId: 'c9', ...WHERE,
        }),
      ),
      d => seen.push(d),
    );
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result).toEqual({
      usage: { promptTokens: 5, completionTokens: 2 }, callId: 'c9', ...WHERE,
    });
  });

  it('does not drop a delta split across two network chunks', async () => {
    const whole = encodeFrame({ type: 'delta', text: 'Hello' })
      + encodeFrame({
        type: 'done', usage: { promptTokens: 1, completionTokens: 1 }, callId: 'c1', ...WHERE,
      });
    const seen: string[] = [];
    await readFrames(streamOf(whole.slice(0, 12), whole.slice(12)), d => seen.push(d));
    expect(seen).toEqual(['Hello']);
  });

  it('does not drop the final delta when the done frame arrives without a trailing blank line', async () => {
    const seen: string[] = [];
    const doneNoBlank = encodeFrame({
      type: 'done', usage: { promptTokens: 1, completionTokens: 1 }, callId: 'c1', ...WHERE,
    }).replace(/\n\n$/, '');
    await readFrames(
      streamOf(encodeFrame({ type: 'delta', text: 'last' }), doneNoBlank),
      d => seen.push(d),
    );
    expect(seen).toEqual(['last']);
  });

  // THE rule. A truncated stream is not a short answer.
  it('throws stream_truncated when the stream ends with no done and no error frame', async () => {
    const seen: string[] = [];
    await expect(
      readFrames(streamOf(encodeFrame({ type: 'delta', text: 'half an ans' })), d => seen.push(d)),
    ).rejects.toMatchObject({ name: 'ModelError', code: 'stream_truncated' });
    expect(seen).toEqual(['half an ans']);
  });

  it('throws stream_truncated rather than resolving from a done frame with no jurisdiction', async () => {
    await expect(readFrames(
      streamOf(
        encodeFrame({ type: 'delta', text: 'whole answer' }),
        'data: ' + DONE_NO_WHERE + '\n\n',
      ),
      () => {},
    )).rejects.toMatchObject({ name: 'ModelError', code: 'stream_truncated' });
  });

  it('throws stream_truncated on a completely empty stream, never resolving empty', async () => {
    await expect(readFrames(streamOf(), () => {})).rejects.toMatchObject({ code: 'stream_truncated' });
  });

  it('throws the error frame\'s own code and message, carrying the call id', async () => {
    await expect(
      readFrames(
        streamOf(
          encodeFrame({ type: 'delta', text: 'partial' }),
          encodeFrame({ type: 'error', code: 'upstream_failed', status: 502, message: 'Foundry 500', callId: 'c4' }),
        ),
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ModelError', code: 'upstream_failed', message: 'Foundry 500', callId: 'c4' });
  });

  it('stops emitting deltas after an error frame', async () => {
    const seen: string[] = [];
    await expect(
      readFrames(
        streamOf(
          encodeFrame({ type: 'error', code: 'upstream_failed', status: 502, message: 'x', callId: 'c1' }),
          encodeFrame({ type: 'delta', text: 'should not be seen' }),
        ),
        d => seen.push(d),
      ),
    ).rejects.toBeInstanceOf(ModelError);
    expect(seen).toEqual([]);
  });

  it('does not drop or duplicate deltas at any chunk boundary through the full pipeline', async () => {
    const whole = encodeFrame({ type: 'delta', text: 'Hel' })
      + encodeFrame({ type: 'delta', text: 'lo, ' })
      + encodeFrame({ type: 'delta', text: 'world' })
      + encodeFrame({
        type: 'done', usage: { promptTokens: 4, completionTokens: 3 }, callId: 'c7', ...WHERE,
      });
    for (let i = 0; i <= whole.length; i++) {
      const seen: string[] = [];
      // eslint-disable-next-line no-await-in-loop
      const result = await readFrames(streamOf(whole.slice(0, i), whole.slice(i)), d => seen.push(d));
      expect(seen.join('')).toBe('Hello, world');
      expect(result).toEqual({
        usage: { promptTokens: 4, completionTokens: 3 }, callId: 'c7', ...WHERE,
      });
    }
  });

  it('propagates a stream-level rejection unwrapped, so an abort stays an abort', async () => {
    async function* boom(): AsyncIterable<Uint8Array> {
      yield enc.encode(encodeFrame({ type: 'delta', text: 'a' }));
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    await expect(readFrames(boom(), () => {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});
