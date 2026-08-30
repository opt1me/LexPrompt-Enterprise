import {
  ModelError, findingKey, unchecked,
  type Finding, type FindingsPage, type Note, type Verification, type VerificationState,
} from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { fromFindingRow, type FindingRow } from './rows.ts';

/**
 * P17's second move: THE READER FLIPS. Findings are assembled from
 * `finding` + `finding_disposition` + `note` and handed back in the exact
 * nested shape `types.ts` declares, so not one consumer of `run.findings` in
 * `src/` has to change.
 *
 * ## Why this is a different function from `fromFindingRow`
 *
 * `fromFindingRow` returns a `FindingContent` — `Omit<Finding,
 * 'verification' | 'notes'>` — and that omission is enforced by the compiler
 * on purpose: a row mapper that invented `verification: unchecked()` would be
 * the engine deriving a human judgement one layer below where anybody looks
 * for it. This module is the one place allowed to put the two halves back
 * together, and it does so from the tables that actually hold them.
 *
 * ## `unchecked()` here is a READING, not a derivation
 *
 * `changed_count = 0` means nobody has ever touched this finding — the row
 * `ensureDisposition` creates, with a NULL actor and a NULL instant, because
 * §6.3 says such a finding renders as "Not checked" and names nobody. So
 * `unchecked()` is what the stored row SAYS, not a default this module
 * chooses when it cannot tell. A disposition row that is missing entirely
 * (a finding written before its disposition, which the schema's own foreign
 * key makes impossible) reads the same way and for the same reason.
 *
 * Nothing here can produce `verified`, `flagged` or `rejected` from
 * anything but a stored `finding_disposition` whose `changed_count` is
 * greater than zero. There is no path from silence to a claim that somebody
 * checked something.
 *
 * ## The disposition's `version` travels beside the findings, not inside them
 *
 * A disposition write is version-guarded (`setDisposition` refuses a stale
 * one with a 409 carrying the current row), so the browser has to know the
 * version it was looking at. It is deliberately NOT a field on `Finding`:
 * `Finding` is the domain shape three programs share and an
 * optimistic-concurrency token is a fact about one table's row, not about
 * the answer to a clause. It travels in a parallel map instead, which
 * `src/lib/api/findings.ts` remembers exactly the way `src/lib/db/reviews.ts`
 * remembers a review's — "the version this browser last SAW".
 *
 * ## Absent keys survive the reassembly
 *
 * `fromFindingRow` returns `netPosition`, `positionOutcome`,
 * `truncatedDocuments` and the four booleans ABSENT rather than null, and
 * this module spreads its result rather than rebuilding it field by field,
 * so that property is inherited rather than re-implemented. A collection
 * finding comes back under the COLLECTION key, because that is the key the
 * row was written under (`findingsKeyFor`) and nothing here re-derives one.
 */

/** One row of the join: a finding, its disposition and its notes. */
interface AssembledRow extends FindingRow {
  d_state: VerificationState | null;
  d_reason: string | null;
  d_by_user_id: string | null;
  d_at: Date | null;
  d_changed_count: number | null;
  /** `bigint`, which `pg` hands back as a STRING. */
  d_version: string | number | null;
  /** `jsonb_agg`'s array, already parsed by `pg`. `[]` when there are none —
   *  `coalesce` in the statement, so this is never null. */
  notes: unknown;
}

/** The wire shape, declared in `@lexprompt/core` so the browser reads the
 *  same one. Aliased rather than re-declared. */
export type FindingsRead = FindingsPage;

/**
 * ONE statement with two left joins, never N+1.
 *
 * The notes come through a lateral `jsonb_agg` rather than a plain join, so
 * a finding with three notes stays ONE row: a plain join would multiply the
 * finding across its notes and every field of it would be read three times.
 *
 * Written as a single template literal, not two concatenated strings —
 * `workspaceScope.test.ts` reads string literals out of the source and
 * checks the predicate region of each, and a statement split across a `+`
 * puts `from finding` in one literal and `where … workspace_id` in another.
 * The guard is right to: a statement it cannot read whole is a statement
 * nothing is checking.
 */
const SELECT_FINDINGS = `
  select f.review_id, f.findings_key, f.clause_id, f.workspace_id, f.status, f.summary,
         f.risk_level, f.risk_analysis, f.error, f.auth_error, f.truncated,
         f.truncated_documents, f.no_content, f.edited, f.position_outcome,
         f.position_rationale, f.citations, f.net_position, f.version, f.updated_at,
         d.state as d_state, d.reason as d_reason, d.by_user_id::text as d_by_user_id,
         d.at as d_at, d.changed_count as d_changed_count, d.version as d_version,
         coalesce(n.notes, '[]'::jsonb) as notes
    from finding f
    left join finding_disposition d
      on d.review_id = f.review_id and d.findings_key = f.findings_key
     and d.clause_id = f.clause_id
    left join lateral (
      select jsonb_agg(
               jsonb_build_object(
                 'id', note.id,
                 'text', note.text,
                 'byUserId', note.by_user_id::text,
                 'at', (extract(epoch from note.at) * 1000)::bigint)
               order by note.at, note.id) as notes
        from note
       where note.review_id = f.review_id and note.findings_key = f.findings_key
         and note.clause_id = f.clause_id) n on true
   where f.review_id = any($1::text[]) and f.workspace_id = $2
   order by f.findings_key, f.clause_id`;

interface RawNote { id: string; text: string; byUserId: string; at: number }

function notesOf(findingsKey: string, clauseId: string, raw: unknown): Note[] {
  const rows = (typeof raw === 'string' ? JSON.parse(raw) : raw) as RawNote[] | null;
  if (!Array.isArray(rows)) return [];
  return rows.map(n => ({
    id: n.id,
    // RECONSTRUCTED through `findingKey`, the one place that string is
    // built, rather than stored: `note` has no `finding_id` column, because
    // the three columns that identify the note already say the same thing
    // and a fourth copy could disagree with them. Nothing in `src/` reads
    // this field for anything but a migration — it exists so a note stays
    // self-describing.
    findingId: findingKey(findingsKey, clauseId),
    text: n.text,
    byUserId: n.byUserId,
    at: Number(n.at),
  }));
}

/**
 * The verification a stored disposition SAYS, and `unchecked()` for anything
 * that says nothing. See the module docstring: this is a reading of a row,
 * not a default chosen in the absence of one.
 *
 * `assigneeId` is gone (P24) and is NOT synthesised: multi-user is
 * schema-ready and not built, assignment reaches nobody, and inventing the
 * field here would put a name on a card that no screen can honour.
 */
function verificationOf(row: AssembledRow): Verification {
  const changed = Number(row.d_changed_count ?? 0);
  if (!row.d_state || changed === 0 || row.d_state === 'unchecked') return unchecked();
  return {
    state: row.d_state,
    ...(row.d_reason ? { reason: row.d_reason } : {}),
    ...(row.d_by_user_id ? { byUserId: row.d_by_user_id } : {}),
    ...(row.d_at ? { at: row.d_at.getTime() } : {}),
  };
}

/**
 * Every finding of one review, assembled.
 *
 * REFUSES rather than answering an empty map when the review is not there:
 * a findings pane that renders "no findings" for a review this workspace
 * cannot see is the founding defect wearing a new coat. The 404 is what
 * `describeLoadError` turns into a sentence.
 */
export async function readFindings(
  db: Db, reviewId: string, workspaceId: string,
): Promise<FindingsRead> {
  const reviews = await db.query<{ version: string | number }>(
    'select version from review where id = $1 and workspace_id = $2', [reviewId, workspaceId]);
  if (!reviews[0]) throw new ModelError('There is no such review.', 'not_found', 404);

  const rows = await db.query<AssembledRow>(SELECT_FINDINGS, [[reviewId], workspaceId]);
  const { findings, dispositionVersions, findingVersions } = assemble(rows);
  return {
    findings: findings[reviewId] ?? {},
    dispositionVersions: dispositionVersions[reviewId] ?? {},
    findingVersions: findingVersions[reviewId] ?? {},
    version: Number(reviews[0].version),
  };
}

/**
 * The same assembly for MANY reviews in one statement — what
 * `GET /v1/matters/:id/reviews` needs.
 *
 * It exists because the list route cannot go on serving `review.findings`
 * after this task. Five callers read a listed review's findings —
 * `positionHealthMap`, `matterStats`, `matterActivity`, `MatterHome`'s
 * progress label and `fewShot` — and the first of those counts VERIFIED
 * findings to say what a standard position has actually been tested
 * against. Serving them the blob once the rows are authoritative would let
 * the editor report a position as tested by a verification that has since
 * been cleared, which is the same class of quiet wrongness the flip exists
 * to end. One query for the whole matter rather than one per review.
 */
export async function readFindingsForReviews(
  db: Db, reviewIds: string[], workspaceId: string,
): Promise<Record<string, Record<string, Record<string, Finding>>>> {
  if (reviewIds.length === 0) return {};
  const rows = await db.query<AssembledRow>(SELECT_FINDINGS, [reviewIds, workspaceId]);
  const { findings } = assemble(rows);
  // Every review asked about gets an entry, so a review with no findings
  // yet is `{}` rather than absent — the caller is filling a required field
  // and "this review has no findings" is a fact the rows can state.
  const out: Record<string, Record<string, Record<string, Finding>>> = {};
  for (const id of reviewIds) out[id] = findings[id] ?? {};
  return out;
}

function assemble(rows: AssembledRow[]): {
  findings: Record<string, Record<string, Record<string, Finding>>>;
  dispositionVersions: Record<string, Record<string, Record<string, number>>>;
  findingVersions: Record<string, Record<string, Record<string, number>>>;
} {
  const findings: Record<string, Record<string, Record<string, Finding>>> = {};
  const dispositionVersions: Record<string, Record<string, Record<string, number>>> = {};
  const findingVersions: Record<string, Record<string, Record<string, number>>> = {};
  for (const row of rows) {
    const byKey = (findings[row.review_id] ??= {});
    const byClause = (byKey[row.findings_key] ??= {});
    byClause[row.clause_id] = {
      // SPREAD, not rebuilt. `fromFindingRow` is what keeps an absent
      // `netPosition`/`positionOutcome`/`truncatedDocuments` absent rather
      // than `undefined`-valued, and a second field-by-field copy here is
      // exactly the sibling drift that would lose it.
      ...fromFindingRow(row),
      verification: verificationOf(row),
      notes: notesOf(row.findings_key, row.clause_id, row.notes),
    };
    const versionsByKey = (dispositionVersions[row.review_id] ??= {});
    const versionsByClause = (versionsByKey[row.findings_key] ??= {});
    versionsByClause[row.clause_id] = Number(row.d_version ?? 1);
    const findingByKey = (findingVersions[row.review_id] ??= {});
    const findingByClause = (findingByKey[row.findings_key] ??= {});
    findingByClause[row.clause_id] = Number(row.version ?? 1);
  }
  return { findings, dispositionVersions, findingVersions };
}
