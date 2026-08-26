import { chatJson } from '../../lib/openrouter';
import { mapWithConcurrency } from '../../lib/concurrency';
import { newTemplate } from '../../lib/storage';
import type { Clause, Settings, Template } from '../../types';

export type Depth = 'Light-Touch' | 'Standard' | 'Detailed';
export type Verbosity = 'Concise' | 'Standard' | 'Lengthy';

export interface GenerateOptions {
  contractType: string;
  depth: Depth;
  verbosity: Verbosity;
  context?: string;
  settings: Settings;
  onStatus?: (message: string) => void;
}

interface ClausePlan {
  title: string;
  instructionSummary: string;
  riskCriteriaSummary: string;
}

interface Plan {
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance: string;
  clausePlans: ClausePlan[];
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    systemPrompt: { type: 'string' },
    formatPrompt: { type: 'string' },
    riskTolerance: { type: 'string' },
    clausePlans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          instructionSummary: { type: 'string' },
          riskCriteriaSummary: { type: 'string' },
        },
        required: ['title', 'instructionSummary', 'riskCriteriaSummary'],
        additionalProperties: false,
      },
    },
  },
  required: ['systemPrompt', 'formatPrompt', 'riskTolerance', 'clausePlans'],
  additionalProperties: false,
};

const CLAUSE_PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' }, riskCriteria: { type: 'string' } },
  required: ['prompt', 'riskCriteria'],
  additionalProperties: false,
};

const DEPTH_GUIDANCE: Record<Depth, string> = {
  'Light-Touch': 'Light-Touch: roughly 8-12 high-level commercial risks.',
  Standard: 'Standard: roughly 15-22 balanced legal and commercial points.',
  Detailed: 'Detailed: roughly 25-35 deep-dive points, only where genuinely relevant.',
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function generateTemplate(options: GenerateOptions): Promise<Template> {
  const { contractType, depth, verbosity, context, settings, onStatus } = options;

  onStatus?.(`Planning a ${depth} review template for ${contractType}...`);

  // Phase 1: planning. Must fail loudly — there is nothing to degrade to if
  // the plan itself doesn't come back.
  const plan = await chatJson<Plan>({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
    system:
      'You are an expert legal contract architect planning a contract review template. ' +
      'Use legal judgement to choose the number of clauses; do not pad to hit a count.',
    user: `Plan a "${depth}" contract review template for a "${contractType}".
${DEPTH_GUIDANCE[depth]}
Verbosity of the eventual prompts: ${verbosity}.
Context: ${context || 'None'}

Return systemPrompt, formatPrompt, riskTolerance, and clausePlans[{title, instructionSummary, riskCriteriaSummary}].`,
    jsonSchema: PLAN_SCHEMA,
    temperature: 0.7,
  });

  if (!Array.isArray(plan.clausePlans) || plan.clausePlans.length === 0) {
    throw new Error('The model returned a plan with no clauses. Try again, or pick a different model.');
  }

  // A loosely-parsed response (the fallback path for the ~86/417 OpenRouter
  // models that don't advertise structured_outputs) can satisfy "non-empty
  // array" while still containing an entry missing title/instructionSummary.
  // That garbage would otherwise get baked into a SAVED, reusable template —
  // every future review run against it burns a live API call on nonsense
  // like "CLAUSE TO REVIEW: undefined". Drop those entries here, before they
  // ever reach clause generation or storage.
  const validClausePlans = plan.clausePlans.filter(
    (cp): cp is ClausePlan =>
      typeof cp?.title === 'string' && cp.title.trim() !== '' &&
      typeof cp?.instructionSummary === 'string' && cp.instructionSummary.trim() !== '',
  );

  if (validClausePlans.length === 0) {
    throw new Error('The model returned a plan with no usable clauses. Try again, or pick a different model.');
  }

  onStatus?.(`Planned ${validClausePlans.length} clauses for ${contractType}. Writing prompts...`);

  // Phase 2: bounded, not Promise.all over up to 35 at once — the old code
  // reliably tripped rate limits. A failed clause degrades to its planned
  // summary rather than losing the whole template.
  const clauses = await mapWithConcurrency<ClausePlan, Clause>(
    validClausePlans,
    settings.concurrency,
    async cp => {
      try {
        const generated = await chatJson<{ prompt: string; riskCriteria: string }>({
          apiKey: settings.apiKey,
          modelId: settings.modelId,
          system: 'You are a legal prompt engineer.',
          user: `Write an extraction prompt for the clause "${cp.title}".
Context: ${cp.instructionSummary}
Risk criteria: ${cp.riskCriteriaSummary}
Verbosity: ${verbosity}

Return { prompt, riskCriteria }.`,
          jsonSchema: CLAUSE_PROMPT_SCHEMA,
          temperature: 0.5,
        });
        return {
          id: uid(),
          title: cp.title,
          prompt: generated.prompt,
          riskCriteria: generated.riskCriteria,
        };
      } catch {
        // Degrade rather than fail: keep the clause with its planned summary,
        // which the user can edit, instead of losing the whole template.
        return {
          id: uid(),
          title: cp.title,
          prompt: cp.instructionSummary,
          riskCriteria: cp.riskCriteriaSummary,
        };
      }
    },
  );

  onStatus?.('Finalising template...');

  return {
    ...newTemplate(contractType),
    contractType,
    mode: 'risk',
    systemPrompt: plan.systemPrompt,
    formatPrompt: plan.formatPrompt,
    riskTolerance: plan.riskTolerance,
    clauses,
  };
}
