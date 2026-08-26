import { chat } from '../../lib/openrouter';
import type { Settings } from '../../types';

/**
 * Asks the model to rewrite a risky clause. `original` is normally the
 * clause's first citation (the exact quoted text) — the caller falls back to
 * the summary when there's no citation to point at. Returns the replacement
 * clause text; the caller is expected to show it next to `original` for
 * comparison, not to apply it automatically.
 */
export async function suggestRevision(
  clauseTitle: string,
  original: string,
  issue: string,
  settings: Settings,
): Promise<string> {
  const system = 'You are an expert contract drafter.';
  const user = `Clause: ${clauseTitle} | Original: "${original}" | Issue: ${issue}
Rewrite this clause to mitigate the risk while maintaining commercial viability. Return ONLY the text.`;

  return chat({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
    system,
    user,
  });
}
