import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { uid } from '../../lib/uid';
import type { AuthoringDraft, DraftClause } from '../../lib/authoringDraft';
import type { Settings, StandardPosition } from '../../types';
import { modelProvenanceName } from '../../lib/model/modelChoice';
import type { FewShotSource } from './fewShot';

/** The AI-draft form's fields (spec §3.2, §5). */
export interface DraftFormValues {
  contractType: string;
  actingFor?: string;
  context?: string;
  /** ~N clauses. Guidance, never enforced (spec §5): a model asked for ~18
   *  clauses that returns 15 good ones has not failed, so nothing here pads
   *  the result to reach this number. */
  targetClauseCount?: number;
  answerLength?: 'brief' | 'standard' | 'detailed';
}

const ANSWER_LENGTH_GUIDANCE: Record<NonNullable<DraftFormValues['answerLength']>, string> = {
  brief: 'Keep each extract prompt short — a one- or two-sentence ask.',
  standard: 'Write each extract prompt as a clear, focused paragraph.',
  detailed: 'Write each extract prompt with enough detail to cover likely edge cases.',
};

interface RawClause {
  title?: unknown;
  extract_prompt?: unknown;
  risk_criteria?: unknown;
  standard_position?: unknown;
  suggestions?: unknown;
}

interface RawDraft {
  clauses?: RawClause[];
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          extract_prompt: { type: 'string' },
          risk_criteria: { type: 'string' },
          standard_position: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'extract_prompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['clauses'],
  additionalProperties: false,
} as const;

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Repairs a raw clause into a `DraftClause`, or drops it — the standing rule
 * (spec §5, and the CLAUDE.md rule it restates): a malformed clause is
 * repaired, not dropped, UNLESS it has no title at all, in which case there
 * is nothing to review and it is dropped. A clause with a title but no
 * `extract_prompt` arrives unreviewed with an empty prompt and a visible gap
 * (`extractPrompt: ''`), rather than vanishing where nobody would notice.
 */
function repairClause(raw: RawClause): DraftClause | undefined {
  const title = trimmedString(raw.title);
  if (!title) return undefined;

  const standardPositionText = trimmedString(raw.standard_position);
  // Every proposed standard position is `ai-drafted` and NOT yet
  // `reviewedByHuman` — nobody has read it yet; this call only proposes it.
  const standardPosition: StandardPosition | undefined = standardPositionText
    ? { text: standardPositionText, origin: 'ai-drafted', reviewedByHuman: false }
    : undefined;

  const suggestions = Array.isArray(raw.suggestions)
    ? raw.suggestions.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];

  const riskCriteria = trimmedString(raw.risk_criteria);

  return {
    id: uid(),
    title,
    extractPrompt: typeof raw.extract_prompt === 'string' ? raw.extract_prompt : '',
    // Minor 3 (integrity review): omitted, not assigned `undefined` — this
    // clause's fields eventually reach an IMMUTABLE `PlaybookVersion`
    // record, and `structuredClone` (how IndexedDB writes every record)
    // PRESERVES an `undefined`-valued key. An unconditional assignment here
    // would make a published clause answer `'riskCriteria' in clause` with
    // `true` while holding `undefined` — the same shape `standardPosition`
    // just below already avoids with its own conditional spread.
    ...(riskCriteria !== undefined ? { riskCriteria } : {}),
    ...(standardPosition ? { standardPosition } : {}),
    disposition: 'unreviewed',
    edited: false,
    positionEdited: false,
    suggestions,
  };
}

/**
 * The single call that turns the AI-draft form into an `AuthoringDraft`
 * (spec §5). Returns a clause list only — no `systemPrompt`/`formatPrompt`
 * (ruling R-E7): those govern how the review engine behaves, not what a
 * clause asks, and `toPlaybookDraft` (`src/lib/authoringDraft.ts`) supplies
 * the same generic defaults a brand-new empty playbook gets. Putting
 * un-reviewed model text into the instructions every future review runs on
 * is exactly what this sub-project's save gate exists to prevent.
 *
 * Errors from `chatJson` are propagated untouched, deliberately: an auth
 * failure must remain something `isAuthFailure` (`lib/model/authFailure.ts`)
 * recognises so the caller can route to Settings (spec §7), which wrapping
 * it in a new `Error` would break.
 */
export async function generateDraft(
  form: DraftFormValues,
  fewShot: string,
  sources: FewShotSource[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<AuthoringDraft> {
  const countGuidance = form.targetClauseCount
    ? `Aim for roughly ${form.targetClauseCount} clauses as guidance only. Do not pad to hit this ` +
      'count — a shorter list of genuinely relevant clauses is correct; use legal judgement.'
    : 'Use legal judgement to choose the number of clauses. Do not pad the list to hit any ' +
      'particular count.';
  const lengthGuidance = ANSWER_LENGTH_GUIDANCE[form.answerLength ?? 'standard'];

  const user = [
    `Draft a contract review playbook for a "${form.contractType}" contract.`,
    form.actingFor ? `Acting for: ${form.actingFor}.` : undefined,
    form.context ? `Context: ${form.context}` : undefined,
    countGuidance,
    lengthGuidance,
    fewShot ? `\nSTYLE MATERIAL FROM THE FIRM'S OWN PRIOR WORK:\n${fewShot}` : undefined,
    '\nFor each clause, return: title, extract_prompt (the instruction a reviewer would give an ' +
      'AI to extract this clause from a document), risk_criteria (optional), standard_position ' +
      "(optional — the firm's own answer to this clause, only if the style material above " +
      'suggests one), and suggestions (optional extra sub-questions worth asking).',
    '\nReturn { clauses: [...] }.',
  ].filter((line): line is string => line !== undefined).join('\n');

  const raw = await gatewayModelClient.chatJson<RawDraft>(
    {
      modelChoiceId: settings.modelChoiceId,
      purpose: 'playbook.draft',
      // No matter, review or document this call is about — a playbook is
      // drafted before any of those exist.
      context: {},
      system: 'You are an expert legal contract reviewer drafting a review playbook. ' +
        'Use legal judgement to choose the number and content of clauses; do not pad to hit a count.',
      user,
      jsonSchema: settings.modelSupportsStructuredOutput ? DRAFT_SCHEMA : undefined,
      temperature: 0.5,
    },
    signal,
  );

  const clauses = (raw.clauses ?? [])
    .map(repairClause)
    .filter((c): c is DraftClause => c !== undefined);

  // Zero usable clauses must not open an empty review screen that looks
  // like a draft of nothing (spec §7) — this is thrown, not returned as an
  // empty draft, so the form stays intact with everything the user typed
  // (the caller catches this alongside every other generation failure).
  if (clauses.length === 0) {
    throw new Error(
      'The model returned no clauses that could be used. Try again, or pick a different model.',
    );
  }

  return {
    contractType: form.contractType,
    actingFor: form.actingFor,
    context: form.context,
    learnedFrom: sources.map((s) => s.name),
    // NOT `settings.modelChoiceId`. That is an operator-defined allowlist
    // alias which identifies nothing outside this workspace, and which an
    // administrator can repoint at a different provider and a different
    // model without touching a record that has already printed it — at
    // which point `positionProvenance`'s sentence is not merely opaque, it
    // is false, on a published standard position that travels into every
    // export of the playbook.
    modelId: modelProvenanceName(settings),
    clauses,
  };
}
