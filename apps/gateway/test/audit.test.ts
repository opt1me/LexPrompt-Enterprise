import { describe, it, expect } from 'vitest';
import { AuditLogger, JsonlAuditSink, sha256Hex, type AuditRecord, type AuditSink } from '../src/audit.ts';
import { Writable } from 'node:stream';

const CANARY = 'The Tenant shall not assign the whole of this Lease without consent.';

class Collecting implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord): Promise<void> { this.records.push(r); }
}

class Failing implements AuditSink {
  async write(): Promise<void> { throw new Error('log pipe closed'); }
}

const START = {
  purpose: 'review.clause' as const,
  entry: {
    id: 'uks-gpt4o', provider: 'azure-foundry' as const, model: 'gpt-4o',
    label: 'GPT-4o', jurisdiction: { bloc: 'UK' as const, region: 'uksouth', label: 'UK South' },
    contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
    endpoint: 'https://x.services.ai.azure.com',
    credential: { source: 'managed-identity' as const, scope: 'https://cognitiveservices.azure.com/.default' },
  },
  workspaceId: 'ws-1',
  actorIssuer: 'https://login.microsoftonline.com/t/v2.0',
  actorSubject: 'oid-abc',
  context: { matterId: 'm-1', reviewId: 'r-1', clauseId: 'c-14', documentIds: ['d-1', 'd-2'] },
  system: 'You are a contract reviewer.',
  user: CANARY,
  imageCount: 2,
  streaming: false,
};

describe('the audit record (§10)', () => {
  it('records every field §10 names, plus provider, jurisdiction and (issuer, subject)', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date('2026-08-28T16:41:00Z'), () => 'call-1');
    const callId = await log.start(START);
    await log.finish(callId, {
      status: 200, ok: true, promptTokens: 1200, completionTokens: 300, latencyMs: 2410, retries: 1,
    });

    expect(sink.records[0]).toEqual({
      kind: 'call.started',
      callId: 'call-1',
      at: '2026-08-28T16:41:00.000Z',
      purpose: 'review.clause',
      provider: 'azure-foundry',
      model: 'gpt-4o',
      modelChoiceId: 'uks-gpt4o',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
      credentialSource: 'managed-identity',
      workspaceId: 'ws-1',
      actorIssuer: 'https://login.microsoftonline.com/t/v2.0',
      actorSubject: 'oid-abc',
      matterId: 'm-1',
      reviewId: 'r-1',
      clauseId: 'c-14',
      documentIds: ['d-1', 'd-2'],
      promptSha256: sha256Hex('You are a contract reviewer.\n\n' + CANARY),
      promptChars: ('You are a contract reviewer.\n\n' + CANARY).length,
      imageCount: 2,
      streaming: false,
    });

    expect(sink.records[1]).toEqual({
      kind: 'call.finished',
      callId: 'call-1',
      at: '2026-08-28T16:41:00.000Z',
      status: 200,
      ok: true,
      promptTokens: 1200,
      completionTokens: 300,
      latencyMs: 2410,
      retries: 1,
    });
  });

  // §10: "What it does not log: prompt content and completion content, ever."
  it('NEVER contains prompt or completion content, in any field, in any record', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'call-2');
    const callId = await log.start(START);
    await log.finish(callId, {
      status: 500, ok: false, errorCode: 'upstream_failed',
      promptTokens: 0, completionTokens: 0, latencyMs: 40, retries: 3,
      // A completion is deliberately offered to `finish` here to prove it is
      // not carried through even when a caller hands one over.
      completionForRedactionTestOnly: 'The agreement is silent on this point.',
    } as never);

    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain(CANARY);
    expect(serialised).not.toContain('Tenant');
    expect(serialised).not.toContain('You are a contract reviewer');
    expect(serialised).not.toContain('silent on this point');
  });

  it('hashes the prompt so "was this the same prompt?" is answerable without keeping it', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'c');
    await log.start(START);
    await log.start({ ...START, user: CANARY });
    await log.start({ ...START, user: `${CANARY} And more.` });
    const [a, b, c] = sink.records.map(r => (r as { promptSha256: string }).promptSha256);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits an absent context id rather than writing it as null', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'c');
    await log.start({ ...START, context: {} });
    const r = sink.records[0] as unknown as Record<string, unknown>;
    expect('matterId' in r).toBe(false);
    expect('documentIds' in r).toBe(false);
  });

  // P3 — the whole point of writing the record first.
  it('REFUSES THE CALL when the started record cannot be written', async () => {
    const log = new AuditLogger(new Failing(), () => new Date(), () => 'c');
    await expect(log.start(START)).rejects.toMatchObject({
      name: 'ModelError', code: 'service_misconfigured', status: 503,
    });
  });

  it('says what went wrong, in words an operator can act on', async () => {
    const log = new AuditLogger(new Failing(), () => new Date(), () => 'c');
    await expect(log.start(START)).rejects.toThrow(/could not be recorded[\s\S]*log pipe closed/);
  });
});

describe('JsonlAuditSink', () => {
  it('writes one JSON object per line', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
    });
    const sink = new JsonlAuditSink(stream);
    await sink.write({ kind: 'call.finished', callId: 'c', at: 'now', status: 200, ok: true,
      promptTokens: 1, completionTokens: 1, latencyMs: 1, retries: 0 });
    expect(chunks.join('')).toBe(
      '{"kind":"call.finished","callId":"c","at":"now","status":200,"ok":true,'
      + '"promptTokens":1,"completionTokens":1,"latencyMs":1,"retries":0}\n',
    );
  });

  it('REJECTS when the stream errors, rather than resolving over a lost record', async () => {
    const stream = new Writable({
      write(_chunk, _enc, cb) { cb(new Error('EPIPE')); },
    });
    const sink = new JsonlAuditSink(stream);
    await expect(sink.write({ kind: 'call.finished', callId: 'c', at: 'now', status: 200,
      ok: true, promptTokens: 0, completionTokens: 0, latencyMs: 0, retries: 0 }))
      .rejects.toThrow(/EPIPE/);
  });
});
