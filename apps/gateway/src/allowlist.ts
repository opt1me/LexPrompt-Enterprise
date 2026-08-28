import { ModelError, type AllowedModel } from '@lexprompt/core';
import type { ModelEntry } from './config.ts';

/**
 * Strips a gateway-internal entry down to what a browser may see.
 *
 * Written as an explicit field list rather than a destructured rest, so a
 * field added to `ModelEntry` later is NOT carried outwards by default. The
 * right default for a new internal field is "stays inside";
 * `{ endpoint, credential, ...rest }` gives it the opposite default, and
 * the leak would be invisible in the diff that caused it.
 */
export function toAllowedModel(entry: ModelEntry): AllowedModel {
  return {
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    label: entry.label,
    jurisdiction: entry.jurisdiction,
    contextLength: entry.contextLength,
    supportsImages: entry.supportsImages,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    isDefault: entry.isDefault,
    // S26. Carried to the wire because §12 Q5 is answered from it and
    // Stage 2's admin screen renders it. It records the operator's own
    // agreement — there is nothing confidential in it that the endpoint
    // and credential fields above are being withheld for.
    ...(entry.dataHandling ? { dataHandling: entry.dataHandling } : {}),
  };
}

/**
 * The single home of the allowlist (S15).
 *
 * `apps/api` holds NO copy and validates no model choice — it forwards, and
 * the gateway refuses. Two copies of an allowlist is the sibling drift this
 * project has paid for six times, here in the one place where the two
 * copies would be reachable only by two different deployments'
 * configurations and neither would ever see the other's.
 */
export class Allowlist {
  #byId: Map<string, ModelEntry>;
  #entries: ModelEntry[];

  constructor(entries: ModelEntry[]) {
    this.#entries = entries;
    this.#byId = new Map(entries.map(e => [e.id, e]));
  }

  resolve(modelChoiceId: string): ModelEntry {
    const entry = this.#byId.get(modelChoiceId);
    if (!entry) {
      throw new ModelError(
        `The model ${JSON.stringify(modelChoiceId)} is not on this workspace's allowlist. `
        + 'LexPrompt can only use models an administrator has configured.',
        'model_not_allowed',
        400,
      );
    }
    return entry;
  }

  list(): AllowedModel[] {
    return this.#entries.map(toAllowedModel);
  }

  default(): ModelEntry {
    // config.ts has already proved exactly one entry is default.
    return this.#entries.find(e => e.isDefault) as ModelEntry;
  }
}
