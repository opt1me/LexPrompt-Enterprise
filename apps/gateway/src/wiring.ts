import { readFileSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { Allowlist } from './allowlist.ts';
import { AuditLogger, JsonlAuditSink } from './audit.ts';
import { buildRegistry } from './adapters/registry.ts';
import type { GatewayConfig } from './config.ts';
import { DefaultCredentialResolver } from './credentials/resolve.ts';
import { unlimitedRateLimiter } from './rateLimit.ts';
import type { ServerDeps } from './server.ts';
import { undiciTransport } from './transport.ts';

/**
 * Everything a running gateway is made of, built once from a loaded config.
 *
 * Shared by `main.ts` and `smoke.ts` so the live smoke run drives the same
 * assembly a deployment does — a smoke script that builds its own resolver
 * and its own registry would pass while the thing it was standing in for
 * was misassembled.
 */
export function buildDeps(config: GatewayConfig, out: Writable): ServerDeps {
  const azure = new DefaultAzureCredential();
  const secretClients = new Map<string, SecretClient>();

  const credentials = new DefaultCredentialResolver({
    async getToken(scope: string) {
      const token = await azure.getToken(scope);
      if (!token) {
        // `getToken` resolving to null is "no credential was available",
        // which must not become an unauthenticated call one layer up.
        throw new Error(`No managed identity token was issued for scope ${scope}.`);
      }
      return { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
    },
    async getSecret(vaultUrl: string, secretName: string) {
      let client = secretClients.get(vaultUrl);
      if (!client) {
        client = new SecretClient(vaultUrl, azure);
        secretClients.set(vaultUrl, client);
      }
      const secret = await client.getSecret(secretName);
      if (!secret.value) throw new Error(`Secret ${secretName} has no value.`);
      return secret.value;
    },
    readEnv: config.readEnv,
    readFile: (path: string) => readFileSync(path, 'utf8'),
    now: () => Date.now(),
  });

  return {
    config,
    allowlist: new Allowlist(config.models),
    // The call log goes to the same stream as the boot banner: stdout in a
    // container, collected by whatever the operator collects logs with.
    audit: new AuditLogger(new JsonlAuditSink(out)),
    credentials,
    transport: undiciTransport,
    // Enforces nothing. Task 14 replaces it with the real budget, and the
    // name is what says so at the wiring line rather than in a comment
    // somebody has to find.
    limiter: unlimitedRateLimiter,
    registry: buildRegistry({
      publicOrigin: config.publicOrigin,
      recordedDir: config.recordedDir,
      readFile: (path: string) => readFileSync(path, 'utf8'),
    }),
  };
}
