import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ModelError } from '@lexprompt/core';
import { callModel, prepare } from './callModel.ts';
import { ConfigError, loadConfig, describeConfig } from './config.ts';
import { buildDeps } from './wiring.ts';

/**
 * The one thing in Stage 1 that cannot be proved offline (P5).
 *
 * Every other guarantee here is checked by a test against a fake transport.
 * This calls the real providers, with the real credentials, from the real
 * assembly `main.ts` builds — because "the adapter shapes the request
 * correctly" is a claim about somebody else's API that no fixture of ours
 * can settle.
 *
 * Its audit records go to STDERR, not stdout: the report below is meant to
 * be read by a person at a terminal, and interleaving JSONL through it would
 * make both unreadable. The records are still written, in full, to a stream
 * a shell can redirect.
 */

const RECORD_FLAG = '--record';
const PROMPT = 'Say: one two three';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env, p => readFileSync(p, 'utf8'));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Cannot run the smoke test.\n${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }

  const recordIndex = process.argv.indexOf(RECORD_FLAG);
  const recordId = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined;

  const deps = buildDeps(config, process.stderr);
  const ctx = {
    ...deps,
    workspaceId: 'smoke',
    actorIssuer: 'smoke',
    actorSubject: process.env.USER ?? process.env.USERNAME ?? 'smoke',
  };

  process.stdout.write(`${describeConfig(config)}\n\n`);

  let failures = 0;
  for (const entry of config.models) {
    if (recordId && entry.id !== recordId) continue;
    const started = Date.now();
    try {
      if (recordId === entry.id) {
        await record(ctx, entry.id);
        process.stdout.write(`  ${entry.id}: stream recorded\n`);
        continue;
      }
      const result = await callModel(ctx, {
        modelChoiceId: entry.id,
        purpose: 'assistant.chat',
        user: PROMPT,
      });
      process.stdout.write(
        `  OK   ${entry.id.padEnd(24)} ${result.provider.padEnd(15)} `
        + `${result.jurisdiction.bloc} · ${result.jurisdiction.label}  `
        + `${Date.now() - started}ms  in=${result.usage.promptTokens} `
        + `out=${result.usage.completionTokens}\n`
        + `       ${JSON.stringify(result.content)}\n`,
      );
    } catch (err) {
      failures++;
      const e = err as ModelError;
      process.stdout.write(
        `  FAIL ${entry.id.padEnd(24)} ${Date.now() - started}ms  `
        + `${e instanceof ModelError ? `${e.code} ${e.status}` : 'error'}\n`
        + `       ${(err as Error).message}\n`,
      );
    }
  }
  return failures === 0 ? 0 : 1;
}

/**
 * Writes the provider's raw streamed bytes to a fixture, so the stream
 * conformance suite tests what a provider actually sends rather than what we
 * believed it sends. A fixture produced this way is the only one that may
 * drop the `synthetic` marking.
 */
async function record(
  ctx: Parameters<typeof prepare>[0], modelChoiceId: string,
): Promise<void> {
  const { entry, call } = await prepare(ctx, {
    modelChoiceId, purpose: 'assistant.chat', user: PROMPT,
  }, true);
  const response = await ctx.transport.fetch(call.url, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(ctx.config.requestTimeoutMs),
  });
  if (!response.body) throw new Error('The provider returned no stream body.');
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  const dir = path.resolve('apps/gateway/test/fixtures/streams');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${entry.provider}.txt`), Buffer.concat(chunks));
}

main().then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
