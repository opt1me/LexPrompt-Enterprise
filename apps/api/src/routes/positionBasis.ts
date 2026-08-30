import type { FastifyInstance } from 'fastify';
import { ModelError, uid } from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';

/**
 * `position_basis` — where a house rule came from, still answerable next
 * year (§6.5, §11.1).
 *
 * ## The one number this must not produce
 *
 * A learned position's STRENGTH is computed in `strength.ts` and nowhere
 * else: `supporting === total` is checked only after `total > 1`, and any
 * `strength`/`supporting`/`total` a model volunteers is discarded, not read.
 * Nothing here stores one, and `parseBasis` below drops those keys if a
 * caller sends them — storing them would create a second, frozen copy of the
 * one number this feature's credibility rests on, and it would be the copy a
 * panel read six months later. The table has no column for them and
 * `positionBasis.pg.test.ts` asserts that against `information_schema`.
 *
 * ## Why the key is not what §6.5 writes (P13)
 *
 * §6.5 writes `position_basis(standard_position_id, …)`. A `StandardPosition`
 * has no id — it is a field on a `PlaybookClause` inside an immutable
 * `PlaybookVersion` — so the only id-shaped thing available is the version's,
 * and keying on that would delete a firm's evidence on every publish. The key
 * is `(playbook_id, clause_id)`, the clause's identity across versions.
 *
 * ## Which makes `adopted_text` load-bearing
 *
 * Four leases support the sentence that was ADOPTED, not whatever the
 * sentence says today. `positionHealth.ts` already scopes verifications to a
 * position's current wording for the same reason; evidence has the same
 * problem one layer down, and the answer is the same: the panel compares, and
 * SAYS SO. `adoptedTextMatchesCurrent: false` is rendered as its own
 * sentence naming both wordings — never silently, and never by hiding the
 * evidence, because "the wording has moved since these four leases were
 * read" is a fact a partner needs rather than a reason to show nothing.
 *
 * ## And why "unresolvable" is not "empty"
 *
 * §17 Q3 is open: a precedent set may be disposed of under a retention
 * schedule while the playbook it taught lives on. §11.1 names the
 * consequence — *"delete the set and a position's basis becomes unresolvable
 * (and must then say so on screen rather than showing an empty evidence
 * panel — 'empty is not broken', again)"*. `precedent_set_id` is `on delete
 * set null` and every insert supplies one, so a NULL there means DELETED and
 * cannot mean "there never was a set".
 */
export function registerPositionBasis(app: FastifyInstance, db: Db): void {
  app.get('/v1/playbooks/:id/clauses/:clauseId/basis', async (req): Promise<PositionBasis> => {
    const ws = req.actor!.workspaceId;
    const { id, clauseId } = req.params as { id: string; clauseId: string };

    // The PARENT first. A playbook that does not exist — or belongs to
    // another workspace — answering an empty basis would read on screen as
    // "no evidence was recorded", which is a different fact entirely. 404
    // rather than 403 for a foreign id, as every other read here.
    const playbook = await db.query<{ current_version_id: string | null }>(
      'select current_version_id from playbook where id = $1 and workspace_id = $2', [id, ws]);
    if (!playbook[0]) throw new ModelError('There is no such playbook.', 'not_found', 404);

    const rows = await db.query<BasisRow>(
      `select * from position_basis
       where playbook_id = $1 and clause_id = $2 and workspace_id = $3
       order by seq asc`,
      [id, clauseId, ws]);
    if (rows.length === 0) {
      // Genuinely nothing recorded — a clause authored by hand, or one from
      // before this table existed. Distinct from `resolvable: false` below,
      // which means evidence WAS recorded and its documents are gone.
      return { playbookId: id, clauseId, recorded: false, resolvable: true, entries: [] };
    }

    const currentText = await currentPositionText(db, ws, playbook[0].current_version_id, clauseId);
    // UNRESOLVABLE when the set has been disposed of. Reported for the basis
    // as a whole rather than per entry: a partner asking where a rule came
    // from is asking one question, and "three of the four leases still
    // exist" is a different, weaker answer that would read as the full one.
    const resolvable = rows.every(r => r.precedent_set_id !== null);

    // Names for the documents that are still here, read in one query rather
    // than one per entry. A document that is gone contributes no name and no
    // entry — never an id rendered as though it were a document.
    const names = await documentNames(db, ws, rows.map(r => r.document_id));

    return {
      playbookId: id,
      clauseId,
      recorded: true,
      adoptedText: rows[0].adopted_text,
      ...(rows[0].adopted_in_version_id === null
        ? {} : { adoptedInVersionId: rows[0].adopted_in_version_id }),
      ...(currentText === undefined ? {} : { currentText }),
      // ABSENT when the clause's current wording could not be read at all
      // (no published version yet, or the clause is not in it) — "the
      // wording has moved" and "I could not tell" are different facts, and
      // only the first should render the comparison. Same rule as
      // `positionOutcome.ts`'s refusal to default to `meets`.
      ...(currentText === undefined
        ? {} : { adoptedTextMatchesCurrent: currentText === rows[0].adopted_text }),
      // `strength.ts` is still the only place strength is computed, and this
      // is the input it takes: a basis, not a count.
      diffDerivedOnly: rows.every(r => r.diff_derived_only),
      resolvable,
      entries: resolvable
        ? rows.map(r => ({
          ...(r.precedent_set_id === null ? {} : { precedentSetId: r.precedent_set_id }),
          ...(r.document_id === null ? {} : { documentId: r.document_id }),
          ...(r.document_id !== null && names.has(r.document_id)
            ? { documentName: names.get(r.document_id)! } : {}),
          edits: asArray(r.edits),
          diffDerivedOnly: r.diff_derived_only,
        }))
        : [],
    };
  });
}

export interface BasisEntry {
  precedentSetId?: string;
  documentId?: string;
  documentName?: string;
  edits: unknown[];
  /** The flag AS RECORDED on this row. `positionsToDraft` writes the
   *  position's own `diffDerivedOnly` — computed by `inferPositions.ts`, never
   *  by the model — onto every one of its rows, so the basis-level value above
   *  is a faithful read of it rather than a second, per-document
   *  recomputation of the same judgement. */
  diffDerivedOnly: boolean;
}

export interface PositionBasis {
  playbookId: string;
  clauseId: string;
  /** False when nothing was ever recorded for this clause — which is not the
   *  same as a basis whose documents have since been disposed of. */
  recorded: boolean;
  adoptedText?: string;
  adoptedInVersionId?: string;
  currentText?: string;
  /** Absent when the current wording could not be read at all. */
  adoptedTextMatchesCurrent?: boolean;
  diffDerivedOnly?: boolean;
  /** False when the precedent set has been deleted. `entries` is then empty
   *  and the panel says what happened rather than rendering nothing. */
  resolvable: boolean;
  entries: BasisEntry[];
}

interface BasisRow {
  id: string;
  playbook_id: string;
  clause_id: string;
  adopted_in_version_id: string | null;
  adopted_text: string;
  precedent_set_id: string | null;
  document_id: string | null;
  edits: unknown;
  diff_derived_only: boolean;
}

/** One entry of what a caller asks to be recorded when a position is
 *  adopted. No `strength`, no `supporting`, no `total` — see the module
 *  docstring. */
export interface BasisInput {
  clauseId: string;
  adoptedText: string;
  precedentSetId: string;
  documentId: string;
  edits: unknown[];
  diffDerivedOnly: boolean;
}

/**
 * Records a clause's basis, INSIDE the publish transaction that creates the
 * version it was adopted in.
 *
 * One transaction, not two: a position that was never saved has no house
 * rule to be the basis of, and a basis written outside the publish could
 * survive a publish that failed — evidence for a version nobody ever
 * published.
 */
export async function recordPositionBasis(
  t: Tx, ws: string, playbookId: string, versionId: string, actorId: string,
  entries: BasisInput[],
): Promise<void> {
  for (const entry of entries) {
    await t.query(
      `insert into position_basis (id, workspace_id, playbook_id, clause_id,
                                   adopted_in_version_id, adopted_text, precedent_set_id,
                                   document_id, edits, diff_derived_only, created_at,
                                   created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now(), $11)`,
      [uid(), ws, playbookId, entry.clauseId, versionId, entry.adoptedText,
        entry.precedentSetId, entry.documentId, JSON.stringify(entry.edits),
        entry.diffDerivedOnly, actorId === '' ? null : actorId]);
  }
}

/**
 * The basis a publish body carries, checked rather than cast.
 *
 * **`strength`, `supporting` and `total` are not read.** They are not in the
 * shape at all, so a body that sends them is not "sanitised" — the keys
 * simply never reach a column, because there is no column. `strength.ts`
 * computes strength from the basis on every render; a stored number would be
 * the answer nobody recomputed.
 */
export function parseBasis(value: unknown): BasisInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) bad('basis is present but is not an array');
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) bad(`basis[${i}] is not an object`);
    const b = raw as Record<string, unknown>;
    const clauseId = typeof b.clauseId === 'string' ? b.clauseId.trim() : '';
    if (!clauseId) bad(`basis[${i}].clauseId is missing or empty`);
    if (typeof b.adoptedText !== 'string' || b.adoptedText.trim() === '') {
      // An empty adopted text would make the "wording has moved" comparison
      // meaningless in the direction that matters: everything would look
      // moved, so nothing would.
      bad(`basis[${i}].adoptedText is missing or empty`);
    }
    const precedentSetId = typeof b.precedentSetId === 'string' ? b.precedentSetId.trim() : '';
    if (!precedentSetId) bad(`basis[${i}].precedentSetId is missing or empty`);
    const documentId = typeof b.documentId === 'string' ? b.documentId.trim() : '';
    if (!documentId) bad(`basis[${i}].documentId is missing or empty`);
    if (!Array.isArray(b.edits)) bad(`basis[${i}].edits is missing or is not an array`);
    if (typeof b.diffDerivedOnly !== 'boolean') {
      bad(`basis[${i}].diffDerivedOnly is missing or is not a boolean`);
    }
    return {
      clauseId, adoptedText: b.adoptedText, precedentSetId, documentId,
      edits: b.edits, diffDerivedOnly: b.diffDerivedOnly,
    };
  });
}

/** What the clause's standard position says NOW, or `undefined` when there is
 *  no published version, no such clause in it, or no position on that clause.
 *  Never guessed — `undefined` is what makes "could not tell" distinct from
 *  "the wording has moved". */
async function currentPositionText(
  db: Db, ws: string, versionId: string | null, clauseId: string,
): Promise<string | undefined> {
  if (versionId === null) return undefined;
  const rows = await db.query<{ content: unknown }>(
    'select content from playbook_version where id = $1 and workspace_id = $2', [versionId, ws]);
  if (!rows[0]) return undefined;
  const content = typeof rows[0].content === 'string'
    ? JSON.parse(rows[0].content) as unknown : rows[0].content;
  const clauses = (content as { clauses?: unknown })?.clauses;
  if (!Array.isArray(clauses)) return undefined;
  const clause = clauses.find(c =>
    typeof c === 'object' && c !== null && (c as { id?: unknown }).id === clauseId) as
    { standardPosition?: { text?: unknown } } | undefined;
  const text = clause?.standardPosition?.text;
  return typeof text === 'string' ? text : undefined;
}

/** Display names for the precedent documents still on record. */
async function documentNames(
  db: Db, ws: string, ids: (string | null)[],
): Promise<Map<string, string>> {
  const present = ids.filter((v): v is string => v !== null);
  if (present.length === 0) return new Map();
  const rows = await db.query<{ id: string; name: string }>(
    `select id, name from document
     where workspace_id = $1 and kind = 'precedent' and id = any($2::text[])`,
    [ws, present]);
  return new Map(rows.map(r => [r.id, r.name]));
}

/** `pg` hands jsonb back already parsed; a string is the defensive case. */
function asArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed : [];
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this request (${detail}).`, 'unknown', 400);
}
