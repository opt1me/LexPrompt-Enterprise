import { describe, it, expect, vi } from 'vitest';
import { SERVICE_CONFIG_HINT } from '@lexprompt/core';
import { callModel } from '../src/callModel.ts';
import { Allowlist } from '../src/allowlist.ts';
import { AuditLogger, type AuditRecord, type AuditSink } from '../src/audit.ts';
import { buildRegistry } from '../src/adapters/registry.ts';
import type { GatewayConfig, ModelEntry } from '../src/config.ts';
import type { Transport, TransportResponse } from '../src/callModel.ts';

const entry: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://firm.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const ok = (content: string): TransportResponse => ({
  status: 200, ok: true, body: null,
  json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  text: async () => '',
});

/** A 200 the provider CUT OFF at the token ceiling — a complete-looking
 *  envelope whose `finish_reason` says the answer is a fragment. */
const truncated = (content: string): TransportResponse => ({
  status: 200, ok: true, body: null,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: 'length' }],
    usage: { prompt_tokens: 7, completion_tokens: 4096 },
  }),
  text: async () => '',
});

const err = (status: number, message = 'nope'): TransportResponse => ({
  status, ok: false, body: null,
  json: async () => ({ error: { message } }),
  text: async () => JSON.stringify({ error: { message } }),
});

class Sink implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord) { this.records.push(r); }
}

/**
 * The backoff is injected as a no-op. What the retry tests are about is HOW
 * MANY attempts a status earns, not how long the gaps between them are —
 * waiting the real 1s + 2s would put two of these within a second of
 * vitest's default timeout and buy no coverage. The schedule itself is
 * asserted directly, once, by recording the values handed to `sleep`.
 */
function ctx(transport: Transport, sink = new Sink()) {
  return {
    config: {
      maxPromptChars: 100, requestTimeoutMs: 5000, defaultMaxTokens: 4096,
      allowedJurisdictions: ['UK', 'EU'],
      publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded',
    } as unknown as GatewayConfig,
    allowlist: new Allowlist([entry]),
    audit: new AuditLogger(sink, () => new Date(), (() => { let n = 0; return () => `call-${++n}`; })()),
    credentials: { resolve: async () => ({ kind: 'bearer' as const, token: 'mi' }) },
    registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
    transport,
    limiter: { check: () => {}, recordAttempt: () => {}, record: () => {} } as never,
    sleep: async () => {},
    workspaceId: 'ws-1',
    actorIssuer: 'https://keycloak.local/realms/lexprompt',
    actorSubject: 'oid-1',
    sink,
  };
}

const REQ = { modelChoiceId: 'uks-gpt4o', purpose: 'review.clause' as const, user: 'hi' };

describe('callModel — the one call path', () => {
  it('returns content, usage, provider, jurisdiction and the call id', async () => {
    const c = ctx({ fetch: async () => ok('Answer.') });
    expect(await callModel(c as never, REQ)).toEqual({
      content: 'Answer.',
      usage: { promptTokens: 7, completionTokens: 2 },
      callId: 'call-1',
      provider: 'azure-foundry',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
      // Why the model stopped, carried outward rather than left behind in
      // the adapter. This fixture's body has no `finish_reason`, so the
      // honest answer is `unknown` — the provider said nothing.
      stopReason: 'unknown',
    });
  });

  it('refuses a purpose that is not on the allowlist, before any call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    await expect(callModel(c as never, { ...REQ, purpose: 'review.everything' as never }))
      .rejects.toMatchObject({ code: 'purpose_not_allowed', status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a model that is not on the allowlist, before any call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    await expect(callModel(c as never, { ...REQ, modelChoiceId: 'gpt-5' }))
      .rejects.toMatchObject({ code: 'model_not_allowed', status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a request carrying no prompt text, before any call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    await expect(callModel(c as never, { ...REQ, user: undefined as never }))
      .rejects.toThrow(/no prompt text/);
    await expect(callModel(c as never, { ...REQ, user: '   ' }))
      .rejects.toThrow(/no prompt text/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // H4 / S27's per-call half, and §14's named mutation (c). The assertion
  // that carries the weight is `fetchSpy` — NOT the 403.
  it('refuses a model whose jurisdiction is outside the declared set, and sends NOTHING', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    c.config.allowedJurisdictions = ['EU'];        // entry declares UK
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'jurisdiction_not_allowed', status: 403 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names the provider, the jurisdiction and the declared set in the refusal', async () => {
    const c = ctx({ fetch: async () => ok('x') });
    c.config.allowedJurisdictions = ['EU'];
    await expect(callModel(c as never, REQ))
      .rejects.toThrow(/azure-foundry[\s\S]*UK[\s\S]*UK South[\s\S]*EU/);
  });

  it('records the refused attempt, because a refusal is still an attempt', async () => {
    const sink = new Sink();
    const c = ctx({ fetch: async () => ok('x') }, sink);
    c.config.allowedJurisdictions = ['EU'];
    await expect(callModel(c as never, REQ)).rejects.toThrow();
    expect(sink.records[0]).toMatchObject({ kind: 'call.started', provider: 'azure-foundry' });
    expect(sink.records[1]).toMatchObject({
      kind: 'call.finished', ok: false, errorCode: 'jurisdiction_not_allowed',
    });
  });

  it('refuses a prompt over the configured maximum, with prompt_too_large', async () => {
    const c = ctx({ fetch: async () => ok('x') });
    await expect(callModel(c as never, { ...REQ, user: 'x'.repeat(200) }))
      .rejects.toMatchObject({ code: 'prompt_too_large', status: 413 });
  });

  // §10's rule, carried over verbatim.
  it('retries a 429 and succeeds', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => (++n === 1 ? err(429) : ok('Answer.')) });
    expect((await callModel(c as never, REQ)).content).toBe('Answer.');
    expect(n).toBe(2);
  });

  it('retries a 500 and gives up after the retry budget', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => { n++; return err(500); } });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(n).toBe(3);
  });

  it('backs off between attempts, exponentially', async () => {
    const waits: number[] = [];
    const c = {
      ...ctx({ fetch: async () => err(500) }),
      sleep: async (ms: number) => { waits.push(ms); },
    };
    await expect(callModel(c as never, REQ)).rejects.toThrow();
    expect(waits).toEqual([1000, 2000]);
  });

  it('fails immediately on 401, 402, 403 and 400 without retrying', async () => {
    for (const status of [400, 401, 402, 403]) {
      let n = 0;
      const c = ctx({ fetch: async () => { n++; return err(status); } });
      await expect(callModel(c as never, REQ)).rejects.toThrow();
      expect(n).toBe(1);
    }
  });

  it('surfaces a provider 401 as a FIRM configuration problem, not a user sign-in one', async () => {
    const c = ctx({ fetch: async () => err(401, 'Incorrect API key provided') });
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('never lets a provider error body carry a credential outwards', async () => {
    const sink = new Sink();
    const c = ctx({ fetch: async () => err(401, 'Incorrect API key provided: mi') }, sink);
    const thrown: Error = await callModel(c as never, REQ).then(
      () => { throw new Error('the call should have been refused'); },
      (e: Error) => e,
    );
    expect(thrown.message).toContain('[redacted]');
    // The credential itself, exactly as the provider echoed it back.
    expect(thrown.message).not.toContain('provided: mi');
    // ...and it must not reach the call log either, which is a file support
    // engineers read.
    expect(JSON.stringify(sink.records)).not.toContain('provided: mi');
  });

  it('propagates an abort immediately, unwrapped and unretried', async () => {
    let n = 0;
    const c = ctx({
      fetch: async () => {
        n++;
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      },
    });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ name: 'AbortError' });
    expect(n).toBe(1);
  });

  it('reports a timeout as a timeout, and does not retry it', async () => {
    let n = 0;
    const c = ctx({
      fetch: async (_url, init) => {
        n++;
        await new Promise<void>(resolve => {
          init.signal.addEventListener('abort', () => { resolve(); });
        });
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    c.config.requestTimeoutMs = 20;
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'upstream_failed', status: 504 });
    expect(n).toBe(1);
  });

  it('wraps a network-level rejection as retryable and retries the full budget', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => { n++; throw new TypeError('fetch failed'); } });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ code: 'network' });
    expect(n).toBe(3);
  });

  it('writes call.started before the call and call.finished after, with the retry count', async () => {
    const sink = new Sink();
    const order: string[] = [];
    let n = 0;
    const c = ctx({
      fetch: async () => { order.push('fetch'); return ++n === 1 ? err(500) : ok('A'); },
    }, sink);
    const originalWrite = sink.write.bind(sink);
    sink.write = async r => { order.push(r.kind); return originalWrite(r); };
    await callModel(c as never, REQ);
    expect(order).toEqual(['call.started', 'fetch', 'fetch', 'call.finished']);
    expect((sink.records[1] as { retries: number }).retries).toBe(1);
  });

  // ==================================================================
  // C1, on the non-streamed path. `readResponse` already refuses a 200 with
  // no message content; this is the same refusal for a 200 whose content is
  // half an answer. A lawyer receiving a clause analysis that stops
  // mid-sentence, presented as complete, is what this whole gateway exists
  // to prevent — and unlike an empty answer, this one reads as fluent and
  // plausible all the way to the point where it stops.
  // ==================================================================
  it('REFUSES a completion the provider cut off at the token ceiling', async () => {
    const c = ctx({ fetch: async () => truncated('1. Repairs to the structure and exterior, 2. ') });
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'answer_truncated', retryable: false });
  });

  it('never returns the fragment alongside the refusal', async () => {
    const c = ctx({ fetch: async () => truncated('half an answer') });
    const caught = await callModel(c as never, REQ).catch((e: Error) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('half an answer');
    expect((caught as Error).message).toMatch(/fragment/i);
  });

  it('does not retry a truncated answer — an identical request hits the same ceiling', async () => {
    const fetchSpy = vi.fn(async () => truncated('x'));
    const c = ctx({ fetch: fetchSpy });
    await callModel(c as never, REQ).catch(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('records a truncated answer as a FAILURE, with what it actually cost', async () => {
    const sink = new Sink();
    const c = ctx({ fetch: async () => truncated('x') }, sink);
    await callModel(c as never, REQ).catch(() => {});
    expect(sink.records.find(r => r.kind === 'call.finished')).toMatchObject({
      ok: false, errorCode: 'answer_truncated', promptTokens: 7, completionTokens: 4096,
    });
  });

  it('does not bill the token budget for an answer it refused', async () => {
    const recorded: unknown[] = [];
    const c = {
      ...ctx({ fetch: async () => truncated('x') }),
      limiter: {
        check: () => {}, recordAttempt: () => {},
        record: (...a: unknown[]) => { recorded.push(a); },
      } as never,
    };
    await callModel(c as never, REQ).catch(() => {});
    expect(recorded).toEqual([]);
  });

  // A completion that ended cleanly still says so, so the two are
  // distinguishable at every layer rather than only when one throws.
  it('carries a clean finish_reason outward as stopReason: stop', async () => {
    const c = ctx({
      fetch: async () => ({
        status: 200, ok: true, body: null,
        json: async () => ({
          choices: [{ message: { content: 'Whole.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => '',
      }),
    });
    expect((await callModel(c as never, REQ)).stopReason).toBe('stop');
  });

  // ==================================================================
  // M5. The request budget is counted on every ATTEMPT that clears the
  // check, not on the successes alone — which is what it used to be, since
  // `check` read only what `record` appended and `record` runs from the
  // success branch. A failing call is the one that most needs counting.
  // ==================================================================
  it('counts a FAILED call toward the request budget, not just a successful one', async () => {
    const attempts: unknown[][] = [];
    const c = {
      ...ctx({ fetch: async () => err(500) }),
      limiter: {
        check: () => {},
        recordAttempt: (...a: unknown[]) => { attempts.push(a); },
        record: () => {},
      } as never,
    };
    await callModel(c as never, REQ).catch(() => {});
    expect(attempts).toEqual([['ws-1', 'oid-1']]);
  });

  // P3, at the route level.
  it('makes NO upstream call when the audit sink fails', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const failing = { write: async () => { throw new Error('pipe'); } };
    const c = { ...ctx({ fetch: fetchSpy }), audit: new AuditLogger(failing, () => new Date(), () => 'c') };
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // M3. The P3 refusal was the one `service_misconfigured` in the gateway
  // whose message omitted `SERVICE_CONFIG_HINT` — and a `ModelError`'s CODE
  // does not survive the findings path, so the browser classifies by
  // matching that sentence. Without it, the single failure P3 exists to
  // produce rendered as an ordinary retryable error with a Retry button:
  // the lawyer retries, every retry is refused for the same reason, and
  // nothing tells them or IT that the firm's logging is broken.
  it('names the audit refusal as a firm-configuration fault the browser can recognise', async () => {
    const failing = { write: async () => { throw new Error('pipe'); } };
    const c = { ...ctx({ fetch: async () => ok('x') }), audit: new AuditLogger(failing, () => new Date(), () => 'c') };
    const caught = await callModel(c as never, REQ).catch((e: Error) => e);
    expect((caught as Error).message).toContain(SERVICE_CONFIG_HINT);
  });

  it('makes NO upstream call when the credential cannot be resolved', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = {
      ...ctx({ fetch: fetchSpy }),
      credentials: { resolve: async () => { throw new Error('no identity endpoint'); } },
    };
    await expect(callModel(c as never, REQ)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves no started record without a finished one, whichever way a call ends', async () => {
    const cases: (() => ReturnType<typeof ctx>)[] = [
      () => ctx({ fetch: async () => ok('A') }),
      () => ctx({ fetch: async () => err(500) }),
      () => ctx({ fetch: async () => err(400) }),
      () => ctx({ fetch: async () => { throw new TypeError('fetch failed'); } }),
      () => ctx({ fetch: async () => ({ ...ok(''), json: async () => ({ choices: [] }) }) }),
    ];
    for (const make of cases) {
      const c = make();
      await callModel(c as never, REQ).catch(() => {});
      expect(c.sink.records.map(r => r.kind)).toEqual(['call.started', 'call.finished']);
    }
  });

  it('records a 200 carrying no message content as a failure, not an empty answer', async () => {
    const c = ctx({ fetch: async () => ({ ...ok(''), json: async () => ({ choices: [] }) }) });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(c.sink.records[1]).toMatchObject({ kind: 'call.finished', ok: false });
  });

  it('sends the request the adapter built, to the URL the adapter chose', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const c = ctx({
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers, body: init.body });
        return ok('A');
      },
    });
    await callModel(c as never, { ...REQ, system: 'You are careful.' });
    expect(seen[0].url).toContain('firm.services.ai.azure.com/models/chat/completions');
    expect(seen[0].headers.Authorization).toBe('Bearer mi');
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: 'gpt-4o', max_tokens: 4096 });
  });

  it('tells the limiter what a successful call cost, and nothing about a refused one', async () => {
    const recorded: unknown[] = [];
    const limiter = {
      check: () => {}, recordAttempt: () => {},
      record: (w: string, a: string, u: unknown) => { recorded.push([w, a, u]); },
    };
    const good = { ...ctx({ fetch: async () => ok('A') }), limiter: limiter as never };
    await callModel(good as never, REQ);
    expect(recorded).toEqual([['ws-1', 'oid-1', { promptTokens: 7, completionTokens: 2 }]]);

    recorded.length = 0;
    const bad = { ...ctx({ fetch: async () => err(400) }), limiter: limiter as never };
    await callModel(bad as never, REQ).catch(() => {});
    expect(recorded).toEqual([]);
  });

  it('sends nothing when the limiter refuses', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = {
      ...ctx({ fetch: fetchSpy }),
      limiter: {
        check: () => { throw new Error('over budget'); },
        recordAttempt: () => {}, record: () => {},
      } as never,
    };
    await expect(callModel(c as never, REQ)).rejects.toThrow(/over budget/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
