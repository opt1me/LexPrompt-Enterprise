import type { Citation, Finding, NetPosition, RiskLevel } from '@lexprompt/core';
import { absentUnless } from '../db/rows.ts';

/**
 * `finding` <-> `Finding`, in one place — the mapping the backfill, the
 * shadow writer, the run worker and Task 14's read route all share.
 *
 * Its own file rather than another section of `db/rows.ts` because it is the
 * biggest of them and the only one four callers reach for; the conventions
 * are `db/rows.ts`'s, and `absentUnless` is imported from there rather than
 * written a second time (the sibling-drift rule, applied before the second
 * copy exists).
 *
 * ## `verification` and `notes` are NOT columns here, and this file never
 * produces them
 *
 * A finding's `Verification` is a person's judgement and lives in
 * `finding_disposition`; its notes live in `note`. `FindingContent` below is
 * `Omit<Finding, 'verification' | 'notes'>` so that is enforced by the
 * compiler rather than by care: a `fromFindingRow` that invented
 * `verification: unchecked()` would be the engine deriving a human judgement
 * one layer down from where anybody is looking for it, and it would be
 * invisible on every screen that renders the result.
 *
 * ## Three absences that are not nulls
 *
 * `truncatedDocuments`, `positionOutcome` and `netPosition` each mean
 * something different absent from what they mean present-and-empty, and
 * `structuredClone` (how the browser's store writes every record) preserves
 * an `undefined`-valued key — so each goes back over the wire ABSENT, never
 * as `key: undefined`. See `absentUnless`.
 */

/** Everything a `finding` row carries. Deliberately not `Finding`: see above. */
export type FindingContent = Omit<Finding, 'verification' | 'notes'>;

/** The three columns that identify one finding. `findingsKey` is whatever
 *  `findingsKeyFor` produced — a document id, or a COLLECTION id — and is
 *  never re-derived from a document here. */
export interface FindingKey {
  reviewId: string;
  findingsKey: string;
  clauseId: string;
}

export interface FindingRow {
  review_id: string;
  findings_key: string;
  clause_id: string;
  workspace_id: string;
  status: Finding['status'];
  summary: string | null;
  risk_level: RiskLevel | null;
  risk_analysis: string | null;
  error: string | null;
  auth_error: boolean;
  truncated: boolean;
  /** `text[]`, which `pg` hands back as a real array. NULL, never `[]`, on a
   *  single-document finding. */
  truncated_documents: string[] | null;
  no_content: boolean;
  edited: boolean;
  position_outcome: 'meets' | 'deviates' | 'unclear' | null;
  position_rationale: string | null;
  /** Written as a JSON STRING with an explicit `::jsonb` cast — an array
   *  parameter is ambiguous to `pg` between `text[]` and `jsonb`, and getting
   *  it wrong is a cryptic runtime type error rather than a typecheck one.
   *  `db/rows.ts` says the same thing about `document_ids`. */
  citations: unknown;
  net_position: unknown;
  /** `bigint`, which `pg` hands back as a STRING. */
  version?: string | number | null;
  updated_at?: Date;
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * A finding to a row.
 *
 * `f.clauseId` supplies `clause_id`: the finding already knows which clause
 * it answers, and taking it as a fourth parameter would create the chance for
 * a caller to disagree with the object it is writing.
 */
export function toFindingRow(
  f: FindingContent,
  reviewId: string,
  findingsKey: string,
  workspaceId: string,
): FindingRow {
  return {
    review_id: reviewId,
    findings_key: findingsKey,
    clause_id: f.clauseId,
    workspace_id: workspaceId,
    status: f.status,
    summary: f.summary ?? null,
    risk_level: f.riskLevel ?? null,
    risk_analysis: f.riskAnalysis ?? null,
    error: f.error ?? null,
    auth_error: f.authError ?? false,
    truncated: f.truncated ?? false,
    // NULL, never `[]` — the empty array is a different claim.
    truncated_documents: f.truncatedDocuments ?? null,
    no_content: f.noContent ?? false,
    edited: f.edited ?? false,
    position_outcome: f.positionOutcome ?? null,
    position_rationale: f.positionRationale ?? null,
    citations: JSON.stringify(f.citations ?? []),
    net_position: f.netPosition === undefined ? null : JSON.stringify(f.netPosition),
  };
}

/**
 * A row back to a finding — WITHOUT a verification and WITHOUT notes, by
 * type. Task 14's read assembles those from their own tables.
 */
export function fromFindingRow(row: FindingRow): FindingContent {
  return {
    clauseId: row.clause_id,
    status: row.status,
    ...absentUnless('summary', row.summary),
    citations: (parsedJson(row.citations) ?? []) as Citation[],
    ...absentUnless('riskLevel', row.risk_level),
    ...absentUnless('riskAnalysis', row.risk_analysis),
    ...absentUnless('error', row.error),
    // The four booleans are NOT NULL columns with a `false` default, and a
    // `false` goes back as an ABSENT key rather than `edited: false`: the
    // shipped `Finding` marks all four optional and the browser's own
    // extractors omit them when they do not apply, so returning them always
    // would make a round-tripped finding unequal to the one that went in.
    ...absentUnless('edited', row.edited || null),
    ...absentUnless('authError', row.auth_error || null),
    ...absentUnless('truncated', row.truncated || null),
    ...absentUnless('truncatedDocuments', row.truncated_documents),
    ...absentUnless('noContent', row.no_content || null),
    ...absentUnless('netPosition', parsedJson(row.net_position) as NetPosition | null),
    ...absentUnless('positionOutcome', row.position_outcome),
    ...absentUnless('positionRationale', row.position_rationale),
  };
}

/** The column list every writer of this table shares, so an added column
 *  cannot be written by one caller and forgotten by another. */
export const FINDING_COLUMNS = [
  'review_id', 'findings_key', 'clause_id', 'workspace_id', 'status', 'summary',
  'risk_level', 'risk_analysis', 'error', 'auth_error', 'truncated', 'truncated_documents',
  'no_content', 'edited', 'position_outcome', 'position_rationale', 'citations', 'net_position',
] as const;

/** The row's values in `FINDING_COLUMNS` order, ready to be bound. */
export function findingValues(row: FindingRow): unknown[] {
  return FINDING_COLUMNS.map(c => (row as unknown as Record<string, unknown>)[c]);
}
