import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import type { PlaybookClause, Settings } from '../../types';

/** The three by-hand fields the editor can draft AI help for. `standardPosition`
 *  is included for parity with the AI-draft path (`generateDraft.ts` proposes
 *  one too) even though this branch of `TemplateEditor` does not yet render a
 *  standard-position field for a by-hand clause — a caller that gains one
 *  later needs no change here. */
export type SuggestableField = 'extractPrompt' | 'riskCriteria' | 'standardPosition';

/** Exported so callers (`TemplateEditor`'s "Draft this for me" buttons) name
 *  the field the same way the prompt built below does — a second, drifted
 *  copy of these labels is exactly the sibling drift CLAUDE.md warns about. */
export const FIELD_LABEL: Record<SuggestableField, string> = {
  extractPrompt: 'extraction instruction',
  riskCriteria: 'risk criteria',
  standardPosition: 'standard position',
};

const FIELD_GUIDANCE: Record<SuggestableField, string> = {
  extractPrompt:
    'The instruction a reviewer would give an AI to pull this specific clause out of a contract document.',
  riskCriteria:
    'What a reviewer should flag as risky when this specific clause is present — the scoring criteria for it.',
  standardPosition:
    "The firm's own ideal answer for this specific clause — what a reviewer would consider a satisfactory outcome.",
};

interface SuggestionResponse {
  text?: unknown;
}

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;

/**
 * Drafts ONE field of ONE clause (spec §5). Deliberately narrow: a call that
 * regenerated the clause around the field would silently discard whatever
 * extraction prompt the user had already written for it, and a call that
 * touched other clauses would make "draft this for me" on one field a
 * surprise edit to the rest of the playbook.
 *
 * Returns the suggested text only — it is never written into the clause by
 * this function. The caller (`TemplateEditor`) holds it as an unaccepted
 * suggestion until a human explicitly takes it; see `FieldSuggestion.tsx`.
 *
 * Errors from `chatJson` propagate untouched, so `isAuthFailure` (`lib/model/authFailure.ts`)
 * still recognises a 401/403 on whatever this throws.
 */
export async function suggestField(
  field: SuggestableField,
  clause: Pick<PlaybookClause, 'title' | 'extractPrompt'>,
  contractType: string,
  settings: Settings,
): Promise<string> {
  const user = [
    `Contract type: ${contractType || 'unspecified'}.`,
    `Clause: "${clause.title || 'Untitled clause'}".`,
    clause.extractPrompt
      ? `The clause's existing extraction instruction, for context only: ${clause.extractPrompt}`
      : undefined,
    `Draft ONLY the ${FIELD_LABEL[field]} for this one clause — nothing else.`,
    FIELD_GUIDANCE[field],
    'Return just this one field as { "text": "..." }.',
  ].filter((line): line is string => line !== undefined).join('\n');

  const result = await gatewayModelClient.chatJson<SuggestionResponse>({
    modelChoiceId: settings.modelChoiceId,
    purpose: 'playbook.suggest',
    system:
      'You are an expert legal contract reviewer drafting a single field of a single clause in a ' +
      "review playbook. Draft exactly the one field asked for, for exactly the one clause named — " +
      'nothing more.',
    user,
    jsonSchema: settings.modelSupportsStructuredOutput ? SUGGESTION_SCHEMA : undefined,
    temperature: 0.4,
  });

  const text = typeof result.text === 'string' ? result.text.trim() : '';
  // A schema-valid but empty suggestion is exactly the "quietly wrong"
  // shape CLAUDE.md warns about — it must fail loudly rather than let the
  // caller show an empty, silently-acceptable suggestion box.
  if (!text) {
    throw new Error('The model returned an empty suggestion. Try again, or write it yourself.');
  }
  return text;
}
