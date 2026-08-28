import { PROVIDER_IDS, type ProviderId } from '@lexprompt/core';
import type { ProviderAdapter } from './types.ts';
import { azureFoundryAdapter } from './azureFoundry.ts';
import { azureOpenaiAdapter } from './azureOpenai.ts';
import { openaiAdapter } from './openai.ts';
import { makeOpenrouterAdapter } from './openrouter.ts';

/**
 * THE registration point. Adding a provider is: add its id to
 * `PROVIDER_IDS` in packages/core, write its adapter, add one line here,
 * add a stream fixture. No call site changes, because no call site names a
 * provider — `callModel` looks one up from the allowlist entry.
 *
 * A FACTORY rather than a module-level constant, because two adapters take
 * configuration (`openrouter` its public origin, `recorded` its fixture
 * directory) and an adapter must never read configuration itself (S25, and
 * `adapterBoundary` in Step 7).
 *
 * PENDING is the honest record of what is not registered yet. Task 9 and
 * Task 13 each remove one id in the same commit that adds its adapter, and
 * the tests below fail if the list ever disagrees with reality in either
 * direction — so it cannot be forgotten and cannot become a place to hide
 * an unimplemented provider.
 */
export const PENDING: readonly ProviderId[] = ['anthropic', 'recorded'];

export interface RegistryConfig {
  publicOrigin: string;
  recordedDir: string;
  readFile?: (path: string) => string;
}

export function buildRegistry(config: RegistryConfig): {
  all: readonly ProviderAdapter[];
  get(id: ProviderId): ProviderAdapter;
} {
  const all: readonly ProviderAdapter[] = [
    azureFoundryAdapter,
    azureOpenaiAdapter,
    openaiAdapter,
    makeOpenrouterAdapter(config.publicOrigin),
    // Task 9 adds anthropicAdapter here; Task 13 adds
    // makeRecordedAdapter(config.recordedDir, config.readFile).
  ];
  const byId = new Map<ProviderId, ProviderAdapter>(all.map(a => [a.id, a]));
  return {
    all,
    get(id: ProviderId): ProviderAdapter {
      const adapter = byId.get(id);
      if (!adapter) {
        throw new Error(
          `No adapter is registered for provider ${JSON.stringify(id)}. `
          + `Registered: ${[...byId.keys()].join(', ')}. `
          + `Not yet implemented: ${PENDING.join(', ')}. `
          + `Known ids: ${PROVIDER_IDS.join(', ')}.`,
        );
      }
      return adapter;
    },
  };
}
