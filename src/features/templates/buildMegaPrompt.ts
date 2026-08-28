import type { PlaybookDraft } from '../../types';

export type MegaPromptFormat = 'copilot' | 'json';

/**
 * Whether the risk block belongs in the prompt by default.
 *
 * R-D1: `mode` is gone, so nothing declares an intent to assess risk any
 * more — the PRESENCE of risk wording is the intent. A playbook that says
 * nothing about risk anywhere gets a prompt that does not pretend to, and
 * one that does gets it turned on without the author having to remember a
 * toggle. `MegaPromptModal`'s toggle stays a user choice on top of this.
 */
export function defaultIncludeRisk(template: PlaybookDraft): boolean {
  return Boolean(template.riskTolerance || (template.clauses || []).some(c => c.riskCriteria));
}

/**
 * The comparison ask, worded once. The house rule travels with the clause,
 * and so must the question asked about it: a DIY prompt that shipped the
 * position without this would answer a DIFFERENT question from the one the
 * app answers for the same playbook — a summary where the app gives a
 * comparison. Both output formats now read it from here rather than each
 * carrying its own copy; the JSON branch shipped the position without the
 * instruction for exactly as long as the two were written separately.
 */
const POSITION_COMPARISON_INSTRUCTION =
  'State whether the document MEETS, DEVIATES FROM, or is UNCLEAR against that position, and say why.';

/** The four levels `extractClause`'s `RISK_LEVELS` accepts. Named in full so
 *  a DIY answer can be read back into the app's own vocabulary; the copilot
 *  branch used to offer three of them. */
const RISK_LEVEL_LIST = 'High, Medium, Low or Info';

/**
 * Builds the "DIY mode" mega-prompt: a self-contained prompt a user can paste
 * into any chat model to do the review by hand, without this app. Pure
 * string-building so it is testable without mounting the modal.
 *
 * Both formats have to describe what the app ACTUALLY does for the same
 * playbook, because that is the whole claim DIY Mode makes. The reference is
 * `extractClause` (`src/features/review/extractClause.ts`): its system
 * message is the playbook's `systemPrompt` followed by
 * "OUTPUT RULES: <formatPrompt>"; its risk block is resolved by
 * `riskCriteriaBlock` (`src/lib/riskBlock.ts`) as the clause's own criteria
 * else the playbook's global tolerance; its position block is present only
 * for a clause carrying a `standardPosition`; and it names its return fields
 * explicitly. The JSON branch used to drop the format prompt and the global
 * tolerance, tell the model the criteria were "Use global tolerance" (a
 * pointer to a value the prompt did not contain), ship the position without
 * ever asking for the comparison, and never state a return shape at all.
 */
export function buildMegaPrompt(template: PlaybookDraft, format: MegaPromptFormat, includeRisk: boolean): string {
  const clauses = template.clauses || [];
  const riskTolerance = template.riskTolerance || 'Use standard commercial risk judgment.';
  const anyPosition = clauses.some(c => c.standardPosition);

  const clauseListStr = clauses.map((c, i) => {
    let str = `${i + 1}. **${c.title}**`;
    str += `\n   - Instruction: ${c.extractPrompt}`;
    // The house rule travels with the clause. A DIY prompt that dropped it
    // would answer a different question from the one the app answers for
    // the same playbook — a summary where the app gives a comparison.
    if (c.standardPosition) {
      str += `\n   - Our standard position: ${c.standardPosition.text}`;
      str += `\n   - ${POSITION_COMPARISON_INSTRUCTION}`;
    }
    if (includeRisk && c.riskCriteria) {
      str += `\n   - Risk Criteria: ${c.riskCriteria}`;
    }
    return str;
  }).join('\n\n');

  if (format === 'copilot') {
    return `
# ROLE
${template.systemPrompt}

# TASK
I will upload one or more contract documents. You must review them against the rules below.

# EXTRACTION RULES
${template.formatPrompt}

${includeRisk ? `# RISK ASSESSMENT RULES\n- Assess risk based on: "${riskTolerance}"\n- Flag each clause as ${RISK_LEVEL_LIST} risk.` : '# RISK ASSESSMENT\n- Risk reporting is DISABLED.'}

# CLAUSES TO REVIEW
${clauseListStr}

# OUTPUT FORMAT
Please provide a clear, structured report.
${includeRisk
  ? `Include: Clause Name, Summary, Verbatim Quote (copied exactly from the document), Risk Level (${RISK_LEVEL_LIST}), Risk Analysis.`
  : 'Include: Clause Name, Summary, Verbatim Quote (copied exactly from the document).'}${
  anyPosition
    ? '\nFor each clause that carries a standard position, also include the outcome — MEETS, DEVIATES FROM or UNCLEAR — and the reason for it.'
    : ''}

# INSTRUCTIONS
Acknowledge this prompt and tell me when you are ready.
    `.trim();
  }

  // `return_for_each_clause` mirrors the "Return:" list `buildClausePrompt`
  // sends and the properties `clauseSchema` requires — a JSON-only API told
  // nothing about what JSON to return was the fourth gap here.
  const jsonStructure = {
    role: template.systemPrompt,
    output_rules: template.formatPrompt,
    task: 'Review the uploaded contract document(s) against the clauses below, answering strictly from the document text.',
    ...(includeRisk ? { risk_tolerance: riskTolerance } : {}),
    clauses: clauses.map(c => ({
      title: c.title,
      instruction: c.extractPrompt,
      ...(c.standardPosition
        ? {
            standard_position: c.standardPosition.text,
            position_instruction: POSITION_COMPARISON_INSTRUCTION,
          }
        : {}),
      // Resolved, not pointed at: `riskCriteriaBlock` gives the real
      // extraction call the clause's own criteria else the playbook's
      // tolerance, so the DIY prompt resolves the same fallback rather than
      // naming a value it does not carry.
      ...(includeRisk ? { risk_criteria: c.riskCriteria || riskTolerance } : {}),
    })),
    return_for_each_clause: {
      summary: 'What the document says on this point, or that it is silent.',
      citations: 'Exact verbatim substrings copied from the document text supporting the summary. Never clause numbers — the literal text.',
      ...(includeRisk
        ? {
            risk_level: `One of: ${RISK_LEVEL_LIST}.`,
            risk_analysis: 'Why that level.',
          }
        : {}),
      // Asked only when some clause actually carries a house rule, the same
      // gate `clauseSchema` applies before adding these to the schema: a
      // clause with nothing to compare against must not be pushed into
      // inventing a comparison.
      ...(anyPosition
        ? {
            position_outcome:
              'For a clause with a standard_position only: one of "meets", "deviates", "unclear". Use "unclear" if you cannot tell — do not guess.',
            position_rationale:
              'For a clause with a standard_position only: why. For "deviates", say what the difference is.',
          }
        : {}),
    },
  };
  return `
*** SYSTEM PROMPT ***
You are a JSON-only API.
${JSON.stringify(jsonStructure, null, 2)}
  `.trim();
}
