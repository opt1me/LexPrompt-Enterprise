import { chat } from '../../lib/openrouter';
import type { ReviewRun, RiskLevel, Settings } from '../../types';
import { buildReportRows } from '../review/exportDocx';

const RISK_ORDER: Record<RiskLevel, number> = { High: 0, Medium: 1, Low: 2, Info: 3 };

/** Findings with no risk level (e.g. a clause that could not be reviewed)
 *  sort after every recognised level, but still appear in the email. */
function riskRank(level: RiskLevel | undefined): number {
  return level ? RISK_ORDER[level] : 4;
}

/**
 * Drafts a client-facing summary email from a completed run, high-risk
 * clauses first. Built on `buildReportRows` rather than raw finding JSON —
 * one source of truth for "what does this run say about this document"
 * shared with the DOCX export.
 *
 * Returns markdown; the caller renders it (in a Modal, not `alert()`).
 */
export async function draftEmail(run: ReviewRun, docId: string, settings: Settings): Promise<string> {
  const rows = [...buildReportRows(run, docId)].sort((a, b) => riskRank(a.riskLevel) - riskRank(b.riskLevel));

  // Fail-loudly rule (see `exportDocx`'s identical guard): a run with no
  // findings at all for this document/collection must refuse rather than
  // ask the model to summarise nothing and hand back a plausible-sounding
  // email about a review that never happened.
  if (rows.length === 0) {
    throw new Error('No findings to draft an email from. This review has no results to report yet.');
  }

  const findingsText = rows.map(row => {
    const lines = [`Clause: ${row.title}`, `Summary: ${row.summary}`];
    if (row.riskLevel) lines.push(`Risk: ${row.riskLevel}`);
    if (row.riskAnalysis) lines.push(`Analysis: ${row.riskAnalysis}`);
    return lines.join('\n');
  }).join('\n\n');

  const system = 'You are a professional legal consultant.';
  const user = `Draft a concise email to the client summarizing these findings:
${findingsText}
Highlight high-risk items first.`;

  return chat({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
    system,
    user,
  });
}
