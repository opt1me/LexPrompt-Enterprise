import { ModelError } from '@lexprompt/core';
import type { CredentialConfig } from '../config.ts';
import type { CredentialResolver, ResolvedCredential } from './types.ts';

export interface CredentialDeps {
  /** `DefaultAzureCredential.getToken(scope)` in production; injected here
   *  so every branch below is testable with no Azure and no network. */
  getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number }>;
  getSecret(vaultUrl: string, secretName: string): Promise<string>;
  readEnv(name: string): string | undefined;
  readFile(path: string): string;
  now(): number;
}

/** Re-acquire a token this long before it expires, so a call never starts
 *  with a token that expires mid-flight. */
const EXPIRY_MARGIN_MS = 120_000;

function fail(source: string, detail: string, err: unknown): never {
  throw new ModelError(
    `LexPrompt could not obtain the credential for this model (${source}: ${detail}). `
    + 'This is a configuration problem in the firm\'s deployment, not something you can fix here. '
    + `(${err instanceof Error ? err.message : String(err)})`,
    'service_misconfigured',
    503,
  );
}

/**
 * Resolves the one credential a model entry declares — and ONLY that one.
 *
 * §10's rule, restated for four sources: a credential failure is a loud 503
 * naming the failure, never a fallback to an unauthenticated call, to a
 * different credential source, or to a different provider. All three are
 * shapes of "answer quietly wrong", and the second is the one that would
 * actually get written by someone being helpful: "managed identity is
 * unavailable locally, so read the env var instead" is a two-line change
 * that turns a deployed gateway's Entra failure into a silent switch to
 * whatever key happens to be in its environment.
 *
 * So: one `switch`, no `catch` that reaches another branch, and a test for
 * each failure that supplies a working alternative and asserts it is NOT
 * used.
 */
export class DefaultCredentialResolver implements CredentialResolver {
  #deps: CredentialDeps;
  #tokens = new Map<string, { token: string; expiresOnTimestamp: number }>();
  #secrets = new Map<string, string>();

  constructor(deps: CredentialDeps) { this.#deps = deps; }

  async resolve(config: CredentialConfig): Promise<ResolvedCredential> {
    switch (config.source) {
      case 'managed-identity': {
        const cached = this.#tokens.get(config.scope);
        if (cached && cached.expiresOnTimestamp - this.#deps.now() > EXPIRY_MARGIN_MS) {
          return { kind: 'bearer', token: cached.token };
        }
        try {
          const fresh = await this.#deps.getToken(config.scope);
          this.#tokens.set(config.scope, fresh);
          return { kind: 'bearer', token: fresh.token };
        } catch (err) {
          fail('managed-identity', config.scope, err);
        }
      }
      case 'key-vault': {
        const key = `${config.vaultUrl}#${config.secretName}`;
        const cached = this.#secrets.get(key);
        if (cached) return { kind: 'api-key', key: cached };
        try {
          const secret = (await this.#deps.getSecret(config.vaultUrl, config.secretName)).trim();
          if (!secret) fail('key-vault', key, new Error('the secret is empty'));
          this.#secrets.set(key, secret);
          return { kind: 'api-key', key: secret };
        } catch (err) {
          if (err instanceof ModelError) throw err;
          fail('key-vault', key, err);
        }
      }
      case 'env': {
        const value = (this.#deps.readEnv(config.var) ?? '').trim();
        if (!value) fail('env', config.var, new Error('the variable is unset or empty'));
        return { kind: 'api-key', key: value };
      }
      case 'file': {
        try {
          const value = this.#deps.readFile(config.path).trim();
          if (!value) fail('file', config.path, new Error('the file is empty'));
          return { kind: 'api-key', key: value };
        } catch (err) {
          if (err instanceof ModelError) throw err;
          fail('file', config.path, err);
        }
      }
    }
  }
}

/**
 * Removes a credential from any text about to be logged or returned.
 *
 * Providers put the offending key into their own error bodies more often
 * than you would hope, and this gateway's whole discipline is that no
 * credential leaves it. Applied at the one place a provider's error body
 * becomes a message (Task 11's `callModel`).
 */
export function redactCredential(text: string, credential: ResolvedCredential): string {
  const secret = credential.kind === 'bearer' ? credential.token : credential.key;
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}
