import type { Template } from '../../types';

export type MegaPromptFormat = 'copilot' | 'json';

/**
 * Builds the "DIY mode" mega-prompt: a self-contained prompt a user can paste
 * into any chat model to do the review by hand, without this app. Pure
 * string-building so it is testable without mounting the modal.
 */
export function buildMegaPrompt(template: Template, format: MegaPromptFormat, includeRisk: boolean): string {
  const clauses = template.clauses || [];
  const riskTolerance = template.riskTolerance || 'Use standard commercial risk judgment.';

  const clauseListStr = clauses.map((c, i) => {
    let str = `${i + 1}. **${c.title}**`;
    str += `\n   - Instruction: ${c.prompt}`;
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
      instruction: c.prompt,
      ...(includeRisk ? { risk_criteria: c.riskCriteria || 'Use global tolerance' } : {}),
    })),
  };
  return `
*** SYSTEM PROMPT ***
You are a JSON-only API.
${JSON.stringify(jsonStructure, null, 2)}
  `.trim();
}
