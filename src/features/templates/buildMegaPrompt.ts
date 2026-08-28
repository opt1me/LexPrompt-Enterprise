import type { PlaybookDraft } from '../../types';
import { resolveRiskCriteria } from '../../lib/riskBlock';

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
 * Minor 7 (integrity review). `StandardPositionField.tsx`'s own docstring
 * states the rule: `origin` says where the words came from and
 * `reviewedByHuman` says whether a person has read them, and collapsing the
 * two is how an AI suggestion nobody read comes to be presented as the
 * firm's position. Both mega-prompt branches used to emit
 * `standardPosition.text` under an unqualified "Our standard position" /
 * `standard_position` regardless of `reviewedByHuman` — an unreviewed
 * AI-drafted proposal pasted into an outside model's prompt with the same
 * authority as a house rule a person actually signed off on, and with no
 * caveat telling the outside model (or the person reading its answer) that
 * the comparison it is about to run is against something nobody has
 * checked yet.
 */
function positionLabel(reviewedByHuman: boolean): string {
  return reviewedByHuman
    ? 'Our standard position'
    : 'Proposed standard position — DRAFTED BY AI, NOT YET REVIEWED by a person at the firm';
}

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
 *
 * Re-review N1: a later fix made the per-clause fallback resolve rather
 * than point, but resolved it against a FABRICATED default
 * ('Use standard commercial risk judgment.') where `riskCriteriaBlock`
 * resolves to nothing at all. Both branches now call `resolveRiskCriteria`
 * — the exact function the real extraction call uses — for every risk
 * value they emit, so a playbook with no tolerance and no clause criteria
 * gets no risk block here either, never an invented one.
 */
export function buildMegaPrompt(template: PlaybookDraft, format: MegaPromptFormat, includeRisk: boolean): string {
  const clauses = template.clauses || [];
  // The firm's own global tolerance, verbatim, or '' when it wrote none —
  // never a substitute for a value it did not write.
  const globalTolerance = template.riskTolerance?.trim() || '';
  const anyPosition = clauses.some(c => c.standardPosition);

  const clauseListStr = clauses.map((c, i) => {
    let str = `${i + 1}. **${c.title}**`;
    str += `\n   - Instruction: ${c.extractPrompt}`;
    // The house rule travels with the clause. A DIY prompt that dropped it
    // would answer a different question from the one the app answers for
    // the same playbook — a summary where the app gives a comparison.
    if (c.standardPosition) {
      str += `\n   - ${positionLabel(c.standardPosition.reviewedByHuman)}: ${c.standardPosition.text}`;
      str += `\n   - ${POSITION_COMPARISON_INSTRUCTION}`;
    }
    // Resolved through the same function `riskCriteriaBlock` uses for the
    // real extraction call — the clause's own criteria else the playbook's
    // tolerance, else nothing. Never the fabricated default N1 was filed
    // over.
    const riskCriteria = includeRisk ? resolveRiskCriteria(c, template) : '';
    if (riskCriteria) {
      str += `\n   - Risk Criteria: ${riskCriteria}`;
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

${includeRisk
  ? `# RISK ASSESSMENT RULES\n${globalTolerance ? `- Assess risk based on: "${globalTolerance}"\n` : ''}- Flag each clause as ${RISK_LEVEL_LIST} risk.`
  : '# RISK ASSESSMENT\n- Risk reporting is DISABLED.'}

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
    // Only when the firm actually wrote one — never the fabricated default
    // N1 was filed over. `riskCriteriaBlock` sends no global tolerance of
    // its own (it resolves per clause, below), so there is nothing to
    // substitute here either.
    ...(includeRisk && globalTolerance ? { risk_tolerance: globalTolerance } : {}),
    clauses: clauses.map(c => {
      // Resolved through the exact function `riskCriteriaBlock` uses for
      // the real extraction call — the clause's own criteria else the
      // playbook's tolerance, else '' when neither exists. Omitted, not
      // defaulted, when it resolves empty: `riskCriteriaBlock` sends no
      // risk instruction at all in that case, and inventing one here is
      // the fabricated-tolerance defect N1 was filed over.
      const riskCriteria = includeRisk ? resolveRiskCriteria(c, template) : '';
      return {
        title: c.title,
        instruction: c.extractPrompt,
        ...(c.standardPosition
          ? {
              standard_position: c.standardPosition.text,
              // Minor 7 — present only when it's true, the same convention
              // `provenance` uses: a reviewed position needs no caveat, and an
              // absent key must not be misread as "reviewed" by a consumer
              // that only checks for the field's presence.
              ...(c.standardPosition.reviewedByHuman
                ? {}
                : { standard_position_status: 'DRAFTED BY AI — NOT YET REVIEWED by a person at the firm' }),
              position_instruction: POSITION_COMPARISON_INSTRUCTION,
            }
          : {}),
        ...(riskCriteria ? { risk_criteria: riskCriteria } : {}),
      };
    }),
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
