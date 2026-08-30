import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, DEFAULT_MAX_BODY_BYTES } from '../src/config.ts';
import { assertCanAuthenticateToGateway, makeGatewayClient } from '../src/gatewayClient.ts';
import type { ApiConfig } from '../src/config.ts';

/**
 * The API must be able to prove who it is to the gateway, or it must not
 * start.
 *
 * This closes an OPEN finding Task 25 raised and could not fix from its own
 * files: `main.ts` called `makeGatewayClient(config)` with no
 * `getGatewayToken`, so under `GATEWAY_CALLER_AUTH=entra` — the Azure
 * configuration — the API would have started cleanly, reported itself
 * healthy, and had every request refused by the gateway. Acquiring a
 * managed-identity token is Stage 2's work; the gap is made loud instead.
 */

const BASE: ApiConfig = {
  port: 8080,
  auth: {
    issuer: 'https://login.microsoftonline.com/tid/v2.0',
    discoveryUrl: 'https://login.microsoftonline.com/tid/v2.0',
    audience: 'api://lexprompt',
    subjectClaim: 'oid',
    groupsClaim: 'groups',
    requiredClaims: {},
  },
  gatewayUrl: 'https://gateway.internal',
  workspaceId: 'ws-1',
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  databaseUrl: 'postgres://lexprompt_app:app-dev@postgres:5432/lexprompt',
  databaseMigrationUrl: 'postgres://lexprompt_migrator:migrator-dev@postgres:5432/lexprompt',
  databasePoolMax: 10,
  roleMappings: [
    { issuer: 'https://login.microsoftonline.com/tid/v2.0', groupValue: 'g-1', role: 'reviewer' },
  ],
  // The Azure posture, matching the rest of this fixture: managed identity,
  // an account URL, and NO connection string (§5.1 row 5's asymmetry).
  blob: {
    source: 'managed-identity',
    accountUrl: 'https://lexprompt.blob.core.windows.net',
    container: 'documents',
  },
  pageRenderTimeoutMs: 120_000,
  pageImageMaxPages: 100,
  pageImageLruBytes: 256 * 1024 * 1024,
  runImageBytesMax: 12 * 1000 * 1000,
  // The engine's own connection, on the THIRD role. Spelled out in this
  // fixture rather than reused from `databaseUrl` for the reason
  // `loadConfig` refuses to default it: the app role can write a
  // disposition and the worker role cannot, and a fixture that blurred the
  // two would make the difference invisible to the one suite that reads a
  // whole `ApiConfig`.
  databaseWorkerUrl: 'postgres://lexprompt_worker:worker-dev@postgres:5432/lexprompt',
  workerPoolMax: 4,
  runWorkers: 2,
  runLeaseMs: 600_000,
  runCellTimeoutMs: 300_000,
  runHeartbeatMs: 15_000,
  runAttemptsMax: 3,
  runPollMs: 1_000,
  runRetryBackoffMs: 30_000,
  workspaceRunConcurrency: 8,
  parseWorkers: 1,
  parseTimeoutMs: 180_000,
  parseStuckReportMs: 300_000,
  eventRetentionDays: 7,
  eventPageMax: 500,
  hubTickMs: 1_000,
  wsPingMs: 25_000,
  wsMaxConnections: 500,
  wsMaxSubscriptions: 20,
  wsMaxFrameBytes: 16 * 1024,
  presenceHeartbeatMs: 10_000,
  presenceTtlMs: 15_000,
};

const MTLS = {
  caFile: '/certs/ca.pem',
  certFile: '/certs/api.pem',
  keyFile: '/certs/api.key',
};

describe('the API refuses to start if it cannot authenticate to the gateway', () => {
  it('refuses when it has neither a client certificate nor a token source', () => {
    expect(() => assertCanAuthenticateToGateway(BASE)).toThrow(ConfigError);
    expect(() => assertCanAuthenticateToGateway(BASE))
      .toThrow(/no way to authenticate to the gateway/i);
  });

  it('says which piece is missing and why starting anyway would be worse', () => {
    let message = '';
    try {
      assertCanAuthenticateToGateway(BASE);
    } catch (err) {
      message = (err as Error).message;
    }
    // The message is the whole point of choosing a refusal over a wiring: it
    // has to name the two modes, the certificate variables, and the fact that
    // the token path is not built.
    expect(message).toContain('GATEWAY_CALLER_AUTH=mtls');
    expect(message).toContain('GATEWAY_CALLER_AUTH=entra');
    expect(message).toContain('API_MTLS_CERT_FILE');
    expect(message).toContain('managed-identity token');
    expect(message).toContain(BASE.gatewayUrl);
  });

  it('accepts a client certificate (the compose posture)', () => {
    expect(() => assertCanAuthenticateToGateway({ ...BASE, mtls: MTLS })).not.toThrow();
  });

  it('accepts a token source, so Stage 2 wiring needs no edit here', () => {
    // Written as "some credential exists", never as "mTLS is configured", so
    // supplying `getGatewayToken` is the only change Stage 2 has to make.
    expect(() => assertCanAuthenticateToGateway(BASE, async () => 'token')).not.toThrow();
  });

  it('makeGatewayClient itself refuses, not only the helper', () => {
    // A guard whose only enforcement is a call somebody has to remember to
    // make is a suggestion. The refusal runs inside the constructor, so no
    // caller can build an unauthenticable client at all.
    expect(() => makeGatewayClient(BASE)).toThrow(ConfigError);
    // With a token source it gets past the guard and builds. (The mTLS branch
    // gets past it too, and then fails reading certificate files that do not
    // exist on this machine — a different error, which is the proof it passed.)
    expect(() => makeGatewayClient(BASE, async () => 'token')).not.toThrow();
    expect(() => makeGatewayClient({ ...BASE, mtls: MTLS })).not.toThrow(ConfigError);
  });

  it('main.ts builds the client inside its startup guard', () => {
    // Otherwise the refusal is an unhandled rejection at boot rather than the
    // one-line "LexPrompt api will not start" the operator is meant to read.
    const main = readFileSync(
      path.resolve(__dirname, '../src/main.ts'), 'utf8');
    const guard = /try\s*\{([\s\S]*?)\}\s*catch/.exec(main);
    expect(guard, 'main.ts has no try/catch around startup').toBeTruthy();
    expect(guard![1]).toContain('loadConfig(process.env)');
    expect(guard![1]).toContain('makeGatewayClient(config)');
  });
});
