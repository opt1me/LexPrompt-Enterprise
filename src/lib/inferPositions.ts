/**
 * Turns a firm's own past redlines into proposed standard positions, per
 * spec §6: **"the evidence is assembled deterministically; only the claim
 * is a model call."** Which edits exist, which document each came from,
 * and how many documents support a pattern are all counted in this file,
 * from the parsed edits the caller hands in. The model is asked only to
 * *state* the position a group of edits implies and to say which edits go
 * with which — never to count them, and never to rate how strongly they
 * agree.
 *
 * Any `strength`, `supporting` or `total` the model volunteers in its JSON
 * is never read by this module. `computeStrength`/`isContradicted`
 * (`strength.ts`) are the only source of those numbers, over a basis this
 * module resolves itself from the model's `edit_ids`/`opposing_edit_ids`
 * against the caller's own edit list. Letting the model supply the count
 * would let it be confidently wrong about "4 of 4" — the one figure this
 * feature's credibility rests on.
 *
 * **Never a position from silence (spec §2, §11).** A clause every document
 * left untouched is not "the firm accepts the standard wording" — it is a
 * question the redlines never settled. `unamendedClauses` is turned into
 * `OpenQuestion`s directly, in code, without ever being described to the
 * model as something it might propose a position for. Positions can only
 * ever be built from `edits` that were actually resolved back to a real,
 * caller-supplied edit — an id the model invents is dropped, never trusted
 * into a basis (R-F5), and a group that resolves to zero real edits is
 * dropped entirely rather than kept as a position with an empty basis,
 * which would be silence wearing a position's clothes.
 */

import { chatJson } from './openrouter';
import { uid } from './uid';
import type { Settings } from '../types';
import type { ParsedEdit } from './docxRedlines';
import { computeStrength, isContradicted, type BasisEntry, type PositionStrength } from './strength';

export interface InferredPosition {
  id: string;
  clauseTitle: string;
  statement: string;
  strength: PositionStrength;
  supporting: number;
  total: number;
  basis: { documentId: string; supports: boolean; edits: ParsedEdit[] }[];
  contradicted: boolean;
  disposition: 'undecided' | 'adopted' | 'reworded' | 'rejected';
  rewordedText?: string;
  /** True when every supporting edit is `source: 'diff'`. Rendered with
   *  lower confidence everywhere. A group with no valid supporting edits at
   *  all is never `true` here — "every one of zero" is the same vacuous
   *  shape `strength.ts` refuses to call `consistent`, and a group with no
   *  valid supporting edits never becomes a position in the first place. */
  diffDerivedOnly: boolean;
}

export interface OpenQuestion {
  id: string;
  clauseTitle: string;
  question: string;
  answer?: string;
}

type EditEntry = { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' };

/** The shape asked of the model: groups only, never a count or a strength.
 *  `opposing_edit_ids` exists because telling supporting and opposing
 *  evidence apart requires reading what an edit actually says — a
 *  semantic judgement only the model can make — but it is still only ever
 *  used here to decide *which side of the basis* an edit lands on, never
 *  to decide how many documents that basis spans or how strong it is. */
const INFER_POSITIONS_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clause_title: { type: 'string' },
          statement: { type: 'string' },
          edit_ids: { type: 'array', items: { type: 'string' } },
          opposing_edit_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['clause_title', 'statement', 'edit_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
} as const;

interface RawGroup {
  clause_title?: unknown;
  statement?: unknown;
  edit_ids?: unknown;
  opposing_edit_ids?: unknown;
  // Deliberately no `strength`/`supporting`/`total` fields in this type. A
  // model that adds them anyway is free to — they are simply never read.
}

interface RawInferResponse {
  groups?: unknown;
}

const MAX_SNIPPET = 600;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

/** One human-readable line per edit, tagged with the stable id the model
 *  must use to refer back to it. Ids are assigned by position in the
 *  caller's array (`e1`, `e2`, …) — stable for the lifetime of one call,
 *  which is all `edit_ids`/`opposing_edit_ids` need to be. */
function describeEdit(id: string, entry: EditEntry): string {
  return [
    `[${id}] document ${entry.documentId} — ${entry.source === 'diff' ? 'diff-detected change' : 'tracked change'} (${entry.edit.kind})`,
    `  context: ${truncate(entry.edit.context || entry.edit.text)}`,
    `  edit text: ${truncate(entry.edit.text)}`,
  ].join('\n');
}

function buildPrompt(byId: Map<string, EditEntry>): string {
  const lines = Array.from(byId.entries()).map(([id, entry]) => describeEdit(id, entry));
  return [
    "Below are tracked-change and diff-detected edits from a firm's own past negotiated documents, each with a stable id.",
    'Group the edits that are evidence of the SAME recurring negotiating position (e.g. always striking a landlord\'s ' +
      '"absolute discretion" over consent). For each group, state the clause it concerns and the position the edits ' +
      'imply, in your own words.',
    '',
    'For each group return:',
    '- clause_title: the clause this position concerns',
    '- statement: the position itself, stated plainly, as something the firm does',
    '- edit_ids: ids (from the list below) of edits that SUPPORT this statement',
    '- opposing_edit_ids: ids of edits that go the OTHER way — evidence the firm did not hold this position ' +
      'consistently',
    '',
    'Only use ids from the list below. Do not invent ids. Do NOT return a strength, a count, or a total — those are ' +
      'computed separately and anything you return for them is ignored. Only propose a group when there is real, ' +
      'specific textual evidence for it — do not propose a position for a clause nobody amended.',
    '',
    'Edits:',
    lines.join('\n\n'),
  ].join('\n');
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Deterministic, model-free: every un-amended clause becomes a question,
 * never a position. This is the direct implementation of spec §2/§11's
 * "never guess a position from silence" — the model is never even told
 * about these clauses in a way it could propose a position for, so there
 * is no path from "nobody touched this" to an adopted house rule.
 */
function questionsFor(unamendedClauses: { title: string; documentIds: string[] }[]): OpenQuestion[] {
  return unamendedClauses.map(clause => ({
    id: uid(),
    clauseTitle: clause.title,
    question:
      `This clause was never amended across ${pluralize(clause.documentIds.length, 'document')} — ` +
      'do you have a position on it, or is this an open question the redlines never settled?',
  }));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Resolves one group's `edit_ids`/`opposing_edit_ids` against the caller's
 * real edits, builds the per-document basis, and computes strength and
 * contradiction over it. Returns `undefined` when the group has no
 * clause title/statement, or when every id it named was invented or
 * unresolved (R-F5) — a group with no real edits behind it is exactly the
 * "position from silence" shape this module refuses to produce, so it is
 * dropped rather than kept with an empty basis.
 */
function resolveGroup(raw: RawGroup, byId: Map<string, EditEntry>): InferredPosition | undefined {
  const clauseTitle = typeof raw.clause_title === 'string' ? raw.clause_title.trim() : '';
  const statement = typeof raw.statement === 'string' ? raw.statement.trim() : '';
  if (!clauseTitle || !statement) return undefined;

  // R-F5: an id the model invents is dropped here, silently, rather than
  // trusted into the basis — it never reaches `total`/`supporting` or the
  // basis list rendered as "the workings".
  const supportingEntries = asStringArray(raw.edit_ids)
    .map(id => byId.get(id))
    .filter((e): e is EditEntry => e !== undefined);
  const opposingEntries = asStringArray(raw.opposing_edit_ids)
    .map(id => byId.get(id))
    .filter((e): e is EditEntry => e !== undefined);

  if (supportingEntries.length === 0 && opposingEntries.length === 0) return undefined;

  // One basis entry per document, not per edit — `computeStrength` counts
  // documents ("4 of 4 documents"), not edits. A document named by both a
  // supporting and an opposing id keeps its supporting classification
  // (processed first) but carries every one of its edits for "the
  // workings" to show.
  const basisByDoc = new Map<string, { documentId: string; supports: boolean; edits: ParsedEdit[] }>();
  const addEntry = (entry: EditEntry, supports: boolean) => {
    const existing = basisByDoc.get(entry.documentId);
    if (existing) {
      existing.edits.push(entry.edit);
    } else {
      basisByDoc.set(entry.documentId, { documentId: entry.documentId, supports, edits: [entry.edit] });
    }
  };
  for (const entry of supportingEntries) addEntry(entry, true);
  for (const entry of opposingEntries) addEntry(entry, false);

  const basis = Array.from(basisByDoc.values());
  const strengthBasis: BasisEntry[] = basis.map(b => ({ documentId: b.documentId, supports: b.supports }));
  const supporting = strengthBasis.filter(b => b.supports).length;

  return {
    id: uid(),
    clauseTitle,
    statement,
    strength: computeStrength(strengthBasis),
    supporting,
    total: strengthBasis.length,
    basis,
    contradicted: isContradicted(strengthBasis),
    disposition: 'undecided',
    // "Every supporting edit is diff-derived" — an edit-level fact, not a
    // document-level one, and vacuously false (never true) when there is
    // no valid supporting edit at all.
    diffDerivedOnly: supportingEntries.length > 0 && supportingEntries.every(e => e.source === 'diff'),
  };
}

/**
 * Proposes standard positions from a firm's own past redlines, with the
 * evidence attached, and separates out anything the redlines raise but
 * never settle. See the module comment for the rule this exists to
 * enforce: the model groups and states; the app counts.
 *
 * Returning `{ positions: [], questions: [] }` is a legitimate, honest
 * answer — spec §8: "the redlines did not settle anything we could state
 * as a position" is Task 6's screen for exactly this result, not an error
 * state this function should avoid producing.
 */
export async function inferPositions(
  edits: EditEntry[],
  unamendedClauses: { title: string; documentIds: string[] }[],
  settings: Settings,
): Promise<{ positions: InferredPosition[]; questions: OpenQuestion[] }> {
  const questions = questionsFor(unamendedClauses);

  // Nothing to group. Skip the call rather than asking a model to propose
  // positions over an empty edit list — there is no evidence it could
  // honestly ground a position in either way.
  if (edits.length === 0) {
    return { positions: [], questions };
  }

  const byId = new Map<string, EditEntry>();
  edits.forEach((entry, i) => byId.set(`e${i + 1}`, entry));

  const raw = await chatJson<RawInferResponse>({
    apiKey: settings.apiKey,
    modelId: settings.modelId,
    system:
      "You analyse a law firm's own past negotiated redlines to identify recurring standard positions. " +
      'You only ever group evidence and state the position it implies. You never count documents, never ' +
      'rate how consistent a pattern is, and never propose a position for a clause with no supporting edit.',
    user: buildPrompt(byId),
    jsonSchema: settings.modelSupportsStructuredOutput ? INFER_POSITIONS_SCHEMA : undefined,
    temperature: 0.2,
  });

  const rawGroups = Array.isArray(raw?.groups) ? (raw.groups as unknown[]) : [];
  const positions: InferredPosition[] = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const position = resolveGroup(g as RawGroup, byId);
    if (position) positions.push(position);
  }

  return { positions, questions };
}
