import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
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
export async function draftEmail(
  run: ReviewRun, docId: string, settings: Settings, matterId?: string,
): Promise<string> {
  const rows = [...buildReportRows(run, docId)].sort((a, b) => riskRank(a.riskLevel) - riskRank(b.riskLevel));

  // Fail-loudly rule (see `exportDocx`'s identical guard): a run with no
  // findings at all for this document/collection must refuse rather than
  // ask the model to summarise nothing and hand back a plausible-sounding
  // email about a review that never happened.
  if (rows.length === 0) {
    throw new Error('No findings to draft an email from. This review has no results to report yet.');
  }

  const findingsText = rows.map(row => {
    const lines = [`Clause: ${row.title}`];
    // The honesty labels `buildReportRows` already computes, carried into
    // the prompt BEFORE the summary — the same order and the same reason the
    // CSV puts them first: a caveat met after the text it qualifies is a
    // caveat that does not qualify it.
    //
    // This is the most client-facing thing the app produces: markdown a user
    // copies into an email. For a collection review `row.summary` IS the net
    // position — a synthesis no document contains, unconfirmed until a human
    // says otherwise — and handing it over as bare fact asks the model to
    // write "the break date is 24 June 2030" to a client on nobody's
    // authority. Spec section 2: a net position "starts unconfirmed and says
    // so, everywhere it appears". The DOCX and the CSV both label; this is
    // the third consumer of the same rows and must not be the one that
    // drops them.
    for (const label of [row.verificationLabel, row.netPositionLabel, row.netPositionAmendmentLabel]) {
      if (label) lines.push(`Caveat: ${label}`);
    }
    lines.push(`Summary: ${row.summary}`);
    if (row.riskLevel) lines.push(`Risk: ${row.riskLevel}`);
    if (row.riskAnalysis) lines.push(`Analysis: ${row.riskAnalysis}`);
    return lines.join('\n');
  }).join('\n\n');

  const system = 'You are a professional legal consultant.';
  const user = `Draft a concise email to the client summarizing these findings:
${findingsText}
Highlight high-risk items first.
Where a finding carries a Caveat line, carry that caveat into the email in plain English rather
than dropping it: text nobody has checked, or a position across documents nobody has confirmed,
must not be written to a client as settled fact.`;

  const answer = await gatewayModelClient.chat({
    modelChoiceId: settings.modelChoiceId,
    purpose: 'export.email',
    context: { matterId, reviewId: run.id },
    system,
    user,
  });
  return answer.content;
}
