import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSseEventReader } from '@lexprompt/core';
import { buildRegistry, PENDING } from '../src/adapters/registry.ts';
import type { ProviderAdapter } from '../src/adapters/types.ts';

/**
 * One shared battery over recorded fixtures, run identically for every
 * registered provider adapter. Every fixture in this suite is SYNTHETIC —
 * hand-authored from each provider's published streaming format, not
 * captured from a live call (there is no API key in this environment). A
 * synthetic fixture still catches every transport bug (CRLF, chunk
 * boundaries, a dropped final event) and every decoder regression; the one
 * thing it cannot catch is a provider quietly changing its wire shape.
 * `expected.json`'s `synthetic: true` on every entry keeps that distinction
 * visible rather than assumed — see the last test in this file.
 */
// A real path, not the short 'fixtures/recorded' other test files in this
// suite use as filler for a param nothing used to read (PENDING excluded
// 'recorded' until this task). Vitest's cwd is the repo root regardless of
// which test file is running, so this must match where the fixtures
// actually live (apps/gateway/fixtures/recorded) or `recorded`'s buildCall
// throws "no recorded fixture" the moment this suite exercises it for real.
const registry = buildRegistry({
  publicOrigin: 'https://lexprompt.local', recordedDir: 'apps/gateway/fixtures/recorded',
});

const DIR = path.join(__dirname, 'fixtures/streams');
const EXPECTED = JSON.parse(readFileSync(path.join(DIR, 'expected.json'), 'utf8')) as Record<
  string, {
    text: string; promptTokens: number; completionTokens: number; synthetic: boolean;
    nonStreamedBody: unknown;
  }
>;

/** Drives one adapter over one delivery of one fixture, exactly as the
 *  stream route will (Task 12): the shared splitter, then the adapter's
 *  pure decoder, max-merging usage. */
function drive(adapter: ProviderAdapter, chunks: string[]) {
  const reader = createSseEventReader();
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let ended = false;
  let error: { status: number; message: string } | null = null;

  const handle = (raw: string) => {
    const ev = adapter.decodeEvent(raw);
    if (!ev) return;
    if (ev.kind === 'delta') text += ev.text;
    else if (ev.kind === 'usage') {
      promptTokens = Math.max(promptTokens, ev.usage.promptTokens);
      completionTokens = Math.max(completionTokens, ev.usage.completionTokens);
    } else if (ev.kind === 'end') ended = true;
    else error = { status: ev.status, message: ev.message };
  };

  for (const chunk of chunks) for (const raw of reader.push(chunk)) handle(raw);
  for (const raw of reader.flush()) handle(raw);
  return { text, promptTokens, completionTokens, ended, error };
}

const byBytes = (s: string): string[] => [...s];

describe('every provider has a conformance fixture (P5)', () => {
  it('so a new provider cannot ship without one', () => {
    expect(registry.all.map(a => a.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  // Until Task 13 this file runs over four or five adapters, not six. The
  // fixture set must track the registry exactly — a fixture for an
  // unregistered provider is as much a lie as an unfixtured one.
  it('has no fixture for a provider that is not registered yet', () => {
    expect(Object.keys(EXPECTED).filter(id => PENDING.includes(id as never))).toEqual([]);
  });
});

describe.each(registry.all.map(a => [a.id, a] as const))('%s stream conformance', (id, adapter) => {
  const raw = readFileSync(path.join(DIR, `${id}.txt`), 'utf8');
  const want = EXPECTED[id];

  it('decodes the recorded stream to the expected text, usage and end', () => {
    const got = drive(adapter, [raw]);
    expect(got.text).toBe(want.text);
    expect(got.promptTokens).toBe(want.promptTokens);
    expect(got.completionTokens).toBe(want.completionTokens);
    expect(got.ended).toBe(true);
    expect(got.error).toBe(null);
  });

  // The CRLF bug, per provider. This project shipped it once and it
  // returned NOTHING — no error, no deltas.
  it('decodes the same stream identically when every separator is CRLF', () => {
    expect(drive(adapter, [raw.replace(/\n/g, '\r\n')]).text).toBe(want.text);
  });

  // The chunk-boundary bug, per provider. One byte at a time is the
  // harshest delivery a network can produce and the cheapest to simulate.
  it('decodes the same stream identically when delivered one byte at a time', () => {
    const got = drive(adapter, byBytes(raw));
    expect(got.text).toBe(want.text);
    expect(got.ended).toBe(true);
  });

  // The dropped-final-event bug, per provider.
  it('does not lose the last event when the stream ends without a trailing blank line', () => {
    const got = drive(adapter, [raw.replace(/\n+$/, '')]);
    expect(got.text).toBe(want.text);
    expect(got.ended).toBe(true);
  });

  it('reports that it ended, so the route never emits done on a truncated stream', () => {
    // Cut the fixture before its terminator: the decoder must NOT report an
    // end, which is what makes P2 reachable at the route layer.
    const truncated = raw.slice(0, Math.floor(raw.length * 0.6));
    expect(drive(adapter, [truncated]).ended).toBe(false);
  });

  // ==================================================================
  // THE assertion. §14: "the concatenated stream deltas equal the
  // non-streamed completion byte for byte." §10.4: "the assertion that
  // matters most is the one the original defect failed." §19 warns it is
  // also "the one most likely to be dropped as slow".
  //
  // Every other case in this file compares a stream to a stream, so all of
  // them share one direction of one mechanism: a decoder that dropped the
  // last delta consistently would pass every one. This is the only case
  // that reaches outside that mechanism for its expected value, and it is
  // the case that catches a dropped or duplicated token.
  // ==================================================================
  it('concatenated stream deltas equal the non-streamed completion, byte for byte', () => {
    expect(drive(adapter, [raw]).text).toBe(adapter.readResponse(want.nonStreamedBody).content);
  });

  // §18.2 names the CRLF variant of this case specifically, because CRLF is
  // where the original defect lived.
  it('…and still does when every separator is CRLF', () => {
    expect(drive(adapter, [raw.replace(/\n/g, '\r\n')]).text)
      .toBe(adapter.readResponse(want.nonStreamedBody).content);
  });

  it('…and still does when delivered one byte at a time', () => {
    expect(drive(adapter, byBytes(raw)).text)
      .toBe(adapter.readResponse(want.nonStreamedBody).content);
  });

  it('reports the same usage from the stream as from the non-streamed body', () => {
    const streamed = drive(adapter, [raw]);
    const direct = adapter.readResponse(want.nonStreamedBody);
    expect({ promptTokens: streamed.promptTokens, completionTokens: streamed.completionTokens })
      .toEqual(direct.usage);
  });

  // §14's empty-completion case. A provider that streams no deltas at all
  // must not look like a successful empty answer at either end.
  it('an empty completion is empty in the stream and REFUSED in the non-streamed body', () => {
    const empty = adapter.id === 'anthropic'
      ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const got = drive(adapter, [empty]);
    expect(got.text).toBe('');
    expect(got.ended).toBe(true);
    // And the non-streamed path refuses rather than returning '' — the
    // founding defect, which reads back as "the agreement is silent on
    // this point".
    const emptyBody = adapter.id === 'anthropic'
      ? { content: [] }
      : { choices: [{ message: {} }] };
    expect(() => adapter.readResponse(emptyBody)).toThrow(/no message content/i);
  });

  // §14's mid-stream-error case. `drive()` already collects it; nothing
  // asserted on it until now, so a decoder that swallowed a provider error
  // as an unknown event would have passed.
  it('surfaces a mid-stream provider error rather than swallowing it', () => {
    const errored = adapter.id === 'anthropic'
      ? 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"one"}}\n\n'
        + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"one"}}]}\n\n'
        + 'data: {"error":{"message":"upstream exploded","code":500}}\n\n';
    const got = drive(adapter, [errored]);
    expect(got.error).not.toBe(null);
    expect(got.error?.status).toBeGreaterThanOrEqual(500);
    expect(got.ended).toBe(false);       // an error is not a clean end
  });

  // §14's request round-trip. This is what `test/fixtures/requests/` in the
  // File Structure is for; without it that directory was a promise.
  it('builds the request body this provider actually expects', () => {
    const expectedBody = JSON.parse(
      readFileSync(path.join(__dirname, `fixtures/requests/${adapter.id}.json`), 'utf8'),
    ) as {
      entry: Record<string, unknown>; request: Record<string, unknown>;
      credential: Record<string, unknown>; body: unknown;
    };
    const call = adapter.buildCall(
      { ...expectedBody.request, entry: expectedBody.entry } as never,
      expectedBody.credential as never,
    );
    expect(call.body).toEqual(expectedBody.body);
  });

  it('is recorded against a live provider, or is marked synthetic', () => {
    expect(typeof want.synthetic).toBe('boolean');
    if (want.synthetic) {
      expect(raw).toContain('(synthetic)');
    }
  });
});
