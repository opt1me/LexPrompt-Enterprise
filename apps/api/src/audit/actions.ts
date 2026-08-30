/**
 * WHAT AN AUDIT ROW CAN SAY — a CLOSED set. A string not in it fails to
 * compile.
 *
 * §6.5's list, and the closure is the point rather than a formality: an
 * action with no reader is an action nobody has decided the wording of, and
 * an open `string` here turns the audit log into a log of function calls
 * that nobody can query and nobody trusts. Adding a verb is a decision, made
 * once, in this file.
 *
 * ## WHAT IS DELIBERATELY NOT IN THIS LIST: ANY DISPOSITION ACTION
 *
 * S22: *"A disposition change is recorded once, in
 * `finding_disposition_event`, and is not also written to `audit_event`."*
 *
 * Two append-only records of one fact is this project's most repeated defect
 * placed exactly where a divergence would be least likely to be noticed and
 * most damaging — between what a lawyer reads on the card and what the firm
 * exports as evidence. An auditor reconciling the two logs would find a
 * discrepancy that is really a duplicate, and the activity feed would show
 * the same act twice.
 *
 * `stage4aDoD.test.ts` asserts that absence over this file's own source, so
 * a `finding.verified` arriving here fails a named test rather than being
 * caught in review.
 */
export const AUDIT_ACTIONS = [
  'matter.created', 'matter.deleted',
  'document.added', 'document.deleted',
  'playbook.published', 'playbook.imported',
  'review.created', 'review.deleted',
  'run.started', 'run.cancelled',
  'assignment.created', 'assignment.resolved',
  'workspace.settings_changed',
  'user.role_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Whether a string is one of the closed set — for a reader coming back off
 *  the wire or out of the database, where the compiler cannot help. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}
