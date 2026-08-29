import { apiGet } from '../api/client';
import type { RedlineEdit } from '../../types';

/**
 * Where a house rule came from, still answerable next year (spec §6.5,
 * §11.1).
 *
 * ## What this is for
 *
 * "Learning from redlines" asserts that an inferred house position is
 * *evidenced* — that a lawyer can check what it was built from. Held only in
 * the session that produced it, that assertion was true for about ninety
 * seconds. This is the durable form: a position adopted six months ago still
 * resolves to the documents and the specific edits that produced it, so a
 * partner asking "where did this house rule come from?" gets the four leases
 * and the four strikes rather than a shrug.
 *
 * ## Three answers that must not be collapsed into one
 *
 * - **`recorded: false`** — nothing was ever recorded for this clause. A
 *   clause authored by hand, or one from before the basis existed.
 * - **`resolvable: false`** — evidence WAS recorded and the precedent set has
 *   since been disposed of. `entries` is empty, and the panel must say what
 *   happened rather than rendering an empty evidence panel. §11.1 names this
 *   case explicitly; "empty is not broken", again.
 * - **`adoptedTextMatchesCurrent: false`** — the evidence is here and the
 *   POSITION HAS BEEN REWORDED since it was gathered. Four leases support the
 *   sentence that was adopted, not whatever the sentence says today, and
 *   rendering them beside a sentence they never supported would be exactly
 *   the confidently-wrong claim `positionHealth.ts`'s wording scope exists to
 *   prevent, one layer down. The key is ABSENT — never `false` — when the
 *   current wording could not be read at all, because "the wording has moved"
 *   and "I could not tell" are different facts.
 *
 * ## No strength, ever
 *
 * There is no `strength`, `supporting` or `total` on this type, and the
 * server has no column for one. `strength.ts` computes strength from a basis
 * on every render, and `inferPositions.ts` discards any the model volunteers;
 * a stored copy would be a second, frozen answer to the one number this
 * feature's credibility rests on, and it would be the copy a panel read.
 */
export interface PositionBasisEntry {
  precedentSetId?: string;
  documentId?: string;
  /** The stored precedent document's name, when it is still on record. */
  documentName?: string;
  edits: RedlineEdit[];
  /** `source: 'diff'` never wears `source: 'tracked'`'s confidence, and
   *  "everywhere it appears" now includes a panel opened six months later. */
  diffDerivedOnly: boolean;
}

export interface PositionBasis {
  playbookId: string;
  clauseId: string;
  recorded: boolean;
  /** What the position SAID when this evidence was gathered. */
  adoptedText?: string;
  adoptedInVersionId?: string;
  /** What the clause's standard position says now. Absent when there is no
   *  published version, no such clause in it, or no position on that clause. */
  currentText?: string;
  adoptedTextMatchesCurrent?: boolean;
  diffDerivedOnly?: boolean;
  resolvable: boolean;
  entries: PositionBasisEntry[];
}

/**
 * The basis for one clause's standard position.
 *
 * REJECTS on any failure and never answers an empty basis for one — the rule
 * every repository here states: a caller must be able to tell "no evidence
 * was recorded" from "the server failed", and on this path the difference is
 * between a house rule that was never evidenced and one whose evidence could
 * not be fetched. Rendering the second as the first would quietly retire a
 * claim the feature rests on.
 */
export async function getPositionBasis(
  playbookId: string, clauseId: string, signal?: AbortSignal,
): Promise<PositionBasis> {
  return apiGet<PositionBasis>(
    `/v1/playbooks/${encodeURIComponent(playbookId)}`
    + `/clauses/${encodeURIComponent(clauseId)}/basis`, signal);
}
