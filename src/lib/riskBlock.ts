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
/**
 * What a pre-D `mode: 'risk'` playbook sent when it had neither a global
 * tolerance nor criteria on the clause: the whole risk block was gated on
 * the flag, so an empty one still emitted
 * `RISK CRITERIA: General commercial reasonableness.`
 *
 * The flag is gone and presence decides instead, so this cannot be a
 * fallback HERE — it would switch the risk block on for every post-D
 * playbook that simply has no risk strings. It is materialised ONCE, by
 * `migrateDraft`, onto the `riskTolerance` of a record that carried an
 * explicit `mode: 'risk'`, which reproduces the pre-D prompt exactly
 * (clause criteria still win; a clause without any gets this). Exported
 * from here rather than typed twice: it is risk-block wording, and this
 * module is where risk-block wording lives.
 *
 * Spec 11 requires this to be a test rather than an assumption — see
 * "the risk block a migrated playbook emits" in `playbookMigration.test.ts`.
 */
export const DEFAULT_RISK_TOLERANCE = 'General commercial reasonableness.';

export function riskCriteriaBlock(clause: PlaybookClause, version: PlaybookVersion): string {
  const criteria = clause.riskCriteria?.trim() || version.riskTolerance?.trim() || '';
  return criteria ? `\nRISK CRITERIA: ${criteria}` : '';
}
