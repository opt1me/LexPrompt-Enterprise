/**
 * Reads a new deal's redlines against a playbook's LIVE published version
 * and proposes a `Changeset`: for each clause the deal actually has
 * something to say about, is this deal CONFIRMING the standing position,
 * DRIFTING from it, or raising something the version never covered at all
 * (`new_clause`)? Spec §5, §9 (sub-project F).
 *
 * Mirrors `inferPositions.ts`'s division of labour (spec §6): the model's
 * only job is to read the edits and state, per clause, the position THIS
 * deal takes and why. Whether that proposal matches an existing clause —
 * and therefore whether it is a confirm or a drift — is decided HERE, in
 * code, by matching the model's `clause_title` against `version.clauses`
 * and comparing the matched clause's `standardPosition` text against the
 * proposal, never by trusting the model's own claim to be addressing an
 * existing clause. A proposal that mis-titles itself (or invents a title
 * close to but not matching a real one) degrades to `new_clause` rather
 * than silently landing on — and later overwriting — the wrong clause.
 *
 * A clause the deal never mentions produces no item at all. This is the
 * changeset analogue of spec §2's "never guess a position from silence": a
 * playbook clause this deal is simply silent on is not evidence the deal
 * confirms it, so no `confirm` item is manufactured for it.
 *
 * Every item MUST carry a non-empty `rationale` and start `decision: 'open'`
 * — a proposal without a reason is not reviewable, and a decision is a
 * person's act, never something this function may default (the same rule
 * that gives every `Finding` an `unchecked()` verification and every net
 * position an unconfirmed start).
 */

import { gatewayModelClient } from './model/gatewayModelClient';
import { uid } from './uid';
import type { PlaybookVersion, PlaybookClause, Changeset, ChangesetItem, ChangeKind, RedlineEdit } from '../types';
import type { WorkspaceSettings } from '@lexprompt/core';
import type { ParsedEdit } from './docxRedlines';

export type { ChangeKind };

type EditEntry = { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' };

/** The shape asked of the model: one proposal per clause the deal addresses,
 *  never a kind, a clause id, or a decision — all three are ours to decide,
 *  not the model's to claim. */
const BUILD_CHANGESET_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clause_title: { type: 'string' },
          proposed_text: { type: 'string' },
          rationale: { type: 'string' },
          edit_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['clause_title', 'proposed_text', 'rationale', 'edit_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

interface RawItem {
  clause_title?: unknown;
  proposed_text?: unknown;
  rationale?: unknown;
  edit_ids?: unknown;
  // Deliberately no `kind`/`clause_id`/`decision` fields in this type. A
  // model that adds them anyway is free to — they are simply never read.
}

interface RawResponse {
  items?: unknown;
}

const MAX_SNIPPET = 600;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

/** Trim plus whitespace-collapse — the same tolerance a redline's own
 *  reflow/rewrap gives, and no more. Content equality is checked
 *  case-sensitively: a wording difference that only changes case is still a
 *  wording difference, and calling it `confirm` would overclaim. */
function normaliseText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Case- and whitespace-insensitive — this is identifying which clause a
 *  proposal is ABOUT, not comparing what it says, so "Governing Law" and
 *  "governing law" are the same clause. */
function normaliseTitle(title: string): string {
  return normaliseText(title).toLowerCase();
}

function describeEdit(id: string, entry: EditEntry): string {
  return [
    `[${id}] document ${entry.documentId} — ${entry.source === 'diff' ? 'diff-detected change' : 'tracked change'} (${entry.edit.kind})`,
    `  context: ${truncate(entry.edit.context || entry.edit.text)}`,
    `  edit text: ${truncate(entry.edit.text)}`,
  ].join('\n');
}

function describeClause(clause: PlaybookClause): string {
  return clause.standardPosition
    ? `- "${clause.title}" — current position: ${truncate(clause.standardPosition.text)}`
    : `- "${clause.title}" — no standing position yet`;
}

function buildPrompt(version: PlaybookVersion, byId: Map<string, EditEntry>): string {
  const clauseLines = version.clauses.length > 0
    ? version.clauses.map(describeClause).join('\n')
    : '(this playbook has no clauses yet)';
  const editLines = Array.from(byId.entries()).map(([id, entry]) => describeEdit(id, entry));
  return [
    "Below is a law firm's current playbook for this contract type, and the tracked-change and diff-detected " +
      'edits from a NEW deal now being negotiated.',
    '',
    "The firm's existing clauses:",
    clauseLines,
    '',
    'For each clause the new deal actually has something to say about, return one item:',
    '- clause_title: if this is about a clause listed above, copy its title EXACTLY as written above. Otherwise, ' +
      'a short title for the new topic — do not reuse an existing title for something different.',
    '- proposed_text: what this deal proposes for that clause, stated as the position itself, in the same style ' +
      'as an existing standing position',
    '- rationale: why, citing what the deal actually did',
    '- edit_ids: ids (from the list below) of the edits this proposal is based on',
    '',
    'Do NOT propose an item for a clause the deal never touches — silence about a clause is not evidence it was ' +
      'confirmed. Only use ids from the list below; do not invent ids. Do NOT classify the item as confirm, ' +
      'drift or new, and do NOT invent a clause id — those are decided separately from what you return.',
    '',
    'Edits:',
    editLines.join('\n\n'),
  ].join('\n');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toRedlineEdit(entry: EditEntry, clauseRef: string): RedlineEdit {
  const redlineEdit: RedlineEdit = {
    documentId: entry.documentId,
    kind: entry.edit.kind,
    text: entry.edit.text,
    context: entry.edit.context,
    clauseRef,
    source: entry.source,
  };
  if (entry.edit.author !== undefined) redlineEdit.author = entry.edit.author;
  if (entry.edit.at !== undefined) redlineEdit.at = entry.edit.at;
  return redlineEdit;
}

/**
 * Resolves one raw item against the caller's real edits and the version's
 * real clauses. Returns `undefined` when the item has no clause title,
 * proposed text, or rationale, or when every edit id it named was invented
 * or unresolved — a proposal with no real evidence behind it is dropped
 * rather than kept with an empty basis, which would be a change from
 * silence wearing a model's confident-sounding proposal.
 */
function resolveItem(raw: RawItem, version: PlaybookVersion, byId: Map<string, EditEntry>): ChangesetItem | undefined {
  const clauseTitle = typeof raw.clause_title === 'string' ? raw.clause_title.trim() : '';
  const proposedText = typeof raw.proposed_text === 'string' ? raw.proposed_text.trim() : '';
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
  if (!clauseTitle || !proposedText || !rationale) return undefined;

  const editEntries = asStringArray(raw.edit_ids)
    .map(id => byId.get(id))
    .filter((e): e is EditEntry => e !== undefined);
  if (editEntries.length === 0) return undefined;

  const matched = version.clauses.find(c => normaliseTitle(c.title) === normaliseTitle(clauseTitle));
  const basis = editEntries.map(entry => toRedlineEdit(entry, matched?.title ?? clauseTitle));

  let kind: ChangeKind;
  let currentText: string | undefined;
  if (!matched) {
    kind = 'new_clause';
  } else {
    currentText = matched.standardPosition?.text;
    kind = currentText !== undefined && normaliseText(currentText) === normaliseText(proposedText)
      ? 'confirm'
      : 'drift';
  }

  const item: ChangesetItem = {
    id: uid(),
    kind,
    // The clause title this item is about, made explicit rather than left
    // for readers to dig out of `basis[0]?.clauseRef` (see `ChangesetItem`'s
    // `title` doc comment). Always non-empty here: `clauseTitle` was already
    // validated above, and `matched.title` comes from a real playbook clause.
    title: matched?.title ?? clauseTitle,
    proposedText,
    rationale,
    basis,
    decision: 'open',
  };
  // `clauseId`/`currentText` are set ONLY when there is a real value —
  // never to `undefined` — because `structuredClone` (how IndexedDB writes
  // every record) PRESERVES an `undefined`-valued key. A `clauseId:
  // undefined` on a `new_clause` item would persist as a claim that this
  // item refers to some clause.
  if (matched) item.clauseId = matched.id;
  if (currentText !== undefined) item.currentText = currentText;
  return item;
}

/**
 * Builds a changeset from a new deal's edits, read against `version`.
 *
 * Does not persist — `src/lib/db/changesets.ts`'s `saveChangeset` is the
 * caller's separate, explicit next step, per this app's "await-then-apply"
 * rule: nothing here should be mistaken for the record of a decision, only
 * for a batch of proposals awaiting one.
 *
 * `createdByUserId` is set to `''` here: this builder has no access to the
 * acting user's profile (its signature, fixed by the task brief, takes no
 * `byUserId`), so the caller that actually persists the result (via
 * `saveChangeset`) is responsible for stamping the real profile id first —
 * the same division `newCollection`/`publishVersion` make explicit with a
 * `byUserId` parameter, just drawn one call further out here.
 */
export async function buildChangeset(
  version: PlaybookVersion,
  edits: EditEntry[],
  sourceSummary: string,
  settings: WorkspaceSettings,
): Promise<Changeset> {
  const items: ChangesetItem[] = [];

  // Nothing to propose from. Skip the call rather than asking a model to
  // read a new deal with no edits in it at all.
  if (edits.length > 0) {
    const byId = new Map<string, EditEntry>();
    edits.forEach((entry, i) => byId.set(`e${i + 1}`, entry));

    // No `documentIds` — the same reasoning as `inferPositions.ts`, and the
    // same correction: those ids DO resolve since spec §11.1 stored
    // precedent documents server-side, so widening what this call reports is
    // now possible and is deferred to a change about the audit surface
    // rather than done here. `purpose: 'changeset.build'` already says what
    // the call was for.
    const raw = await gatewayModelClient.chatJson<RawResponse>({
      modelChoiceId: settings.modelChoiceId,
      purpose: 'changeset.build',
      context: {},
      system:
        "You compare a law firm's existing contract playbook against the redlines of a NEW deal, to identify " +
        'where the deal confirms, changes, or raises something outside the standing playbook. You only ever ' +
        'propose a position and explain it — you never decide whether something counts as a confirmation, a ' +
        'drift, or a brand-new clause, and you never propose anything for a clause the deal did not touch.',
      user: buildPrompt(version, byId),
      jsonSchema: settings.modelSupportsStructuredOutput ? BUILD_CHANGESET_SCHEMA : undefined,
      temperature: 0.2,
    });

    const rawItems = Array.isArray(raw?.items) ? (raw.items as unknown[]) : [];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const item = resolveItem(rawItem as RawItem, version, byId);
      if (item) items.push(item);
    }
  }

  return {
    id: uid(),
    playbookId: version.playbookId,
    fromVersionId: version.id,
    sourceSummary,
    items,
    createdAt: Date.now(),
    createdByUserId: '',
  };
}
