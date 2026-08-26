import { chatJson } from '../../lib/openrouter';
import type { Clause, DocumentFile, Finding, RiskLevel, Settings, Template } from '../../types';

const RISK_LEVELS: RiskLevel[] = ['High', 'Medium', 'Low', 'Info'];

export const CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'EXACT VERBATIM SUBSTRINGS copied from the document text. Never clause numbers such as "Clause 14.2" — the literal text, so it can be located and highlighted.',
    },
    risk_level: { type: 'string', enum: RISK_LEVELS },
    risk_analysis: { type: 'string' },
  },
  required: ['summary', 'citations', 'risk_level', 'risk_analysis'],
  additionalProperties: false,
} as const;

interface RawFinding {
  summary?: string;
  citations?: unknown;
  risk_level?: string;
  risk_analysis?: string;
}

export function buildClausePrompt(doc: DocumentFile, clause: Clause, template: Template): string {
  const riskBlock =
    template.mode === 'risk'
      ? `\nRISK CRITERIA: ${clause.riskCriteria || template.riskTolerance || 'General commercial reasonableness.'}`
      : '';

  return `DOCUMENT: ${doc.name}

DOCUMENT TEXT:
${doc.text}

CLAUSE TO REVIEW: ${clause.title}
INSTRUCTION: ${clause.prompt}${riskBlock}

Return:
- summary: what the document says on this point, or that it is silent.
- citations: exact verbatim substrings from the document text supporting the summary.
- risk_level: one of High, Medium, Low, Info.
- risk_analysis: why that level.

If the document text above is empty and images are attached, read the images instead.`;
}

/** Never rejects: a failed clause resolves to an error Finding so a run
 *  completes with partial results and the cell can be retried on its own. */
export async function extractClause(
  doc: DocumentFile,
  clause: Clause,
  template: Template,
  settings: Settings,
  signal?: AbortSignal,
): Promise<Finding> {
  const base: Finding = { clauseId: clause.id, status: 'error', citations: [] };

  if (doc.parseError) {
    return { ...base, error: `Could not read ${doc.name}: ${doc.parseError}` };
  }

  try {
    const raw = await chatJson<RawFinding>(
      {
        apiKey: settings.apiKey,
        modelId: settings.modelId,
        system: `${template.systemPrompt}\n\nOUTPUT RULES: ${template.formatPrompt}`,
        user: buildClausePrompt(doc, clause, template),
        images: doc.pageImages,
        jsonSchema: CLAUSE_SCHEMA,
        temperature: 0.1,
      },
      signal,
    );

    const level = RISK_LEVELS.find(l => l === raw.risk_level);

    return {
      clauseId: clause.id,
      status: 'done',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      citations: Array.isArray(raw.citations) ? raw.citations.filter(c => typeof c === 'string') : [],
      riskLevel: level,
      riskAnalysis: typeof raw.risk_analysis === 'string' ? raw.risk_analysis : undefined,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
