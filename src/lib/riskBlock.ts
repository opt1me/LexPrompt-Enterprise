import type { PlaybookClause, PlaybookVersion } from '../types';

/**
 * The RISK CRITERIA block appended to an extraction prompt, or `''` when the
 * playbook asks for no risk assessment at all.
 *
 * R-D1: `Template.mode` used to decide this. The flag is gone, and the
 * PRESENCE of criteria — the clause's own, else the playbook's tolerance —
 * decides instead. That is why `migrateDraft` clears a stale `riskTolerance`
 * off an extraction-mode playbook: a leftover string would silently turn the
 * block back on for a playbook whose reviews never had it.
 *
 * One function rather than one copy per prompt builder. `extractClause` and
 * `collectionPrompt` had byte-identical copies of the `mode`-gated version,
 * which is the sibling drift CLAUDE.md names — and this is now the single
 * decision that says whether a review is a risk review at all.
 */
export function riskCriteriaBlock(clause: PlaybookClause, version: PlaybookVersion): string {
  const criteria = clause.riskCriteria?.trim() || version.riskTolerance?.trim() || '';
  return criteria ? `\nRISK CRITERIA: ${criteria}` : '';
}
