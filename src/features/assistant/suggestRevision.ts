import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import type { WorkspaceSettings } from '@lexprompt/core';

export interface SuggestRevisionContext {
  matterId?: string;
  reviewId?: string;
  clauseId?: string;
}

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
  settings: WorkspaceSettings,
  context: SuggestRevisionContext = {},
): Promise<string> {
  const system = 'You are an expert contract drafter.';
  const user = `Clause: ${clauseTitle} | Original: "${original}" | Issue: ${issue}
Rewrite this clause to mitigate the risk while maintaining commercial viability. Return ONLY the text.`;

  const answer = await gatewayModelClient.chat({
    modelChoiceId: settings.modelChoiceId,
    purpose: 'export.suggest_fix',
    context: {
      matterId: context.matterId,
      reviewId: context.reviewId,
      clauseId: context.clauseId,
    },
    system,
    user,
  });
  return answer.content;
}
