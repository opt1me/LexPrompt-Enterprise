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
 * Builds the "DIY mode" mega-prompt: a self-contained prompt a user can paste
 * into any chat model to do the review by hand, without this app. Pure
 * string-building so it is testable without mounting the modal.
 */
export function buildMegaPrompt(template: PlaybookDraft, format: MegaPromptFormat, includeRisk: boolean): string {
  const clauses = template.clauses || [];
  const riskTolerance = template.riskTolerance || 'Use standard commercial risk judgment.';

  const clauseListStr = clauses.map((c, i) => {
    let str = `${i + 1}. **${c.title}**`;
    str += `\n   - Instruction: ${c.extractPrompt}`;
    // The house rule travels with the clause. A DIY prompt that dropped it
    // would answer a different question from the one the app answers for
    // the same playbook — a summary where the app gives a comparison.
    if (c.standardPosition) {
      str += `\n   - Our standard position: ${c.standardPosition.text}`;
      str += '\n   - State whether the document MEETS, DEVIATES FROM, or is UNCLEAR against that position, and say why.';
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

${includeRisk ? `# RISK ASSESSMENT RULES\n- Assess risk based on: "${riskTolerance}"\n- Flag specific clauses as High/Medium/Low risk.` : '# RISK ASSESSMENT\n- Risk reporting is DISABLED.'}

# CLAUSES TO REVIEW
${clauseListStr}

# OUTPUT FORMAT
Please provide a clear, structured report.
${includeRisk ? 'Include: Clause Name, Summary, Verbatim Quote, Risk Level, Risk Analysis.' : 'Include: Clause Name, Summary, Verbatim Quote.'}

# INSTRUCTIONS
Acknowledge this prompt and tell me when you are ready.
    `.trim();
  }

  const jsonStructure = {
    role: template.systemPrompt,
    task: 'Extract and analyze contract clauses.',
    clauses: clauses.map(c => ({
      title: c.title,
      instruction: c.extractPrompt,
      ...(c.standardPosition ? { standard_position: c.standardPosition.text } : {}),
      ...(includeRisk ? { risk_criteria: c.riskCriteria || 'Use global tolerance' } : {}),
    })),
  };
  return `
*** SYSTEM PROMPT ***
You are a JSON-only API.
${JSON.stringify(jsonStructure, null, 2)}
  `.trim();
}
