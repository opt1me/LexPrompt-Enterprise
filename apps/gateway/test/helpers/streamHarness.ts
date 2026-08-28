import type { FastifyInstance } from 'fastify';
import { Allowlist } from '../../src/allowlist.ts';
import { AuditLogger, type AuditRecord, type AuditSink } from '../../src/audit.ts';
import { buildRegistry } from '../../src/adapters/registry.ts';
import { buildServer } from '../../src/server.ts';
import { unlimitedRateLimiter, type RateLimiter } from '../../src/rateLimit.ts';
import type { ModelEntry } from '../../src/config.ts';
import type { Transport, TransportResponse } from '../../src/callModel.ts';

/**
 * Shared harness for `apps/gateway/test/inferStream.route.test.ts` (Task 12).
 * Mirrors `infer.route.test.ts`'s hand-rolled `server()` helper — extracted
 * here because the stream route test needs the exact same wiring (an
 * `Allowlist`, a collecting `AuditSink`, a fixed credential and a stubbed
 * `Transport`) with one addition: two allowlisted models, one per provider
 * shape, so the same suite can exercise the OpenAI-shaped split and
 * Anthropic's two-event usage split through the identical route.
 */

const GPT4O: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://firm.services.ai.azure.com',
  apiVersion: '2024-05-01-preview',
  credential: { source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'gpt4o' },
};

const CLAUDE: ModelEntry = {
  id: 'claude', provider: 'anthropic', model: 'claude-3-7-sonnet', label: 'Claude',
  jurisdiction: { bloc: 'US', region: 'us', label: 'US' },
  contextLength: 200000, supportsImages: true, supportsStructuredOutput: true, isDefault: false,
  endpoint: 'https://api.anthropic.com',
  credential: { source: 'env', var: 'ANTHROPIC_API_KEY' },
};

class Sink implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord) { this.records.push(r); }
}

/**
 * Splits `text` into three uneven pieces so a chunk boundary lands mid-event
 * on every test, not only the one that names it — the same class of bug
 * `adapterConformance.test.ts` drives at the decoder layer, exercised here
 * at the route layer instead.
 */
function unevenChunks(text: string): string[] {
  if (text.length === 0) return [];
  const first = Math.min(3, text.length);
  const second = Math.min(first + 7, text.length);
  return [text.slice(0, first), text.slice(first, second), text.slice(second)].filter(c => c.length > 0);
}

/**
 * A stubbed `Transport` whose `fetch` answers with a fixed status and body.
 * On a successful (2xx) status the body streams as three uneven byte
 * chunks; on any other status the body is `null`, exactly like a real
 * `Transport` never opening a stream on a rejected request, and `json()`/
 * `text()` read the given text so `toModelError` can extract a message.
 */
export function fakeStream(status: number, text: string): Transport {
  const ok = status >= 200 && status < 300;
  return {
    async fetch(): Promise<TransportResponse> {
      return {
        status,
        ok,
        json: async () => JSON.parse(text || '{}'),
        text: async () => text,
        body: ok ? streamOf(text) : null,
      };
    },
  };
}

async function* streamOf(text: string): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of unevenChunks(text)) {
    yield encoder.encode(chunk);
  }
}

export interface TestApp extends FastifyInstance {
  auditSink: Sink;
}

export function buildTestServer(opts: { stream: Transport; limiter?: RateLimiter }): TestApp {
  const sink = new Sink();
  const app = buildServer({
    config: {
      port: 0,
      models: [GPT4O, CLAUDE],
      allowedJurisdictions: ['UK', 'US'],
      maxPromptChars: 400_000,
      requestTimeoutMs: 5000,
      defaultMaxTokens: 4096,
      publicOrigin: 'https://lexprompt.local',
      recordedDir: 'fixtures/recorded',
      readEnv: () => undefined,
      caller: { mode: 'none' },
    } as never,
    allowlist: new Allowlist([GPT4O, CLAUDE]),
    audit: new AuditLogger(sink, () => new Date(), () => 'call-1'),
    credentials: { resolve: async () => ({ kind: 'bearer' as const, token: 'test-bearer-token' }) },
    transport: opts.stream,
    limiter: opts.limiter ?? unlimitedRateLimiter,
    registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
  }) as TestApp;
  app.auditSink = sink;
  return app;
}
