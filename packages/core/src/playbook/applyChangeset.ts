/**
 * The domain logic that turns a changeset and a published version into the
 * NEXT version's content — which items reach it, whose words they carry, and
 * what the history entry says.
 *
 * ## Why it lives here
 *
 * §5: `packages/core` is "every piece of domain logic that is neither React
 * nor IO". These functions were file-local helpers in
 * `src/lib/db/changesets.ts` and are now needed on the SERVER too, because
 * `POST /v1/changesets/:id/publish` builds the next version inside the same
 * Postgres transaction that publishes it.
 *
 * They were MOVED, not copied. Two copies of the code that decides what a
 * published version says is the worst available instance of this project's
 * most repeated defect, and the two copies would be reachable only from two
 * different processes — so a drift between them would show up as one
 * client's playbook saying something the other's does not, with nothing on
 * either screen looking wrong.
 *
 * ## Where the types come from
 *
 * `StandardPosition` and `PlaybookClause` used to be DECLARED here, because
 * `packages/core` could not import `src/types.ts` — `RedlineEdit.kind` was
 * typed `import('./lib/docxRedlines').RedlineEditKind`, an inline type import
 * that pulls a browser module (and `DOMParser`, `Element`, `Document`) into
 * whatever program reads `types.ts`. `apps/api/src/db/rows.ts` hit exactly
 * this and records it at length. The two declarations were kept structurally
 * identical to their counterparts in `src/types.ts` by review alone, which
 * is precisely the drift S14 exists to prevent and precisely the drift
 * TypeScript will never report.
 *
 * They now come from `../domain/types.ts`, which is where `src/types.ts`
 * re-exports them from too. One declaration, three programs.
 *
 * `RedlineEdit` and the changeset shapes below stay declared here: nothing
 * in the review closure reads them, and a type moves to `domain/` when
 * something on the server needs it, not because it happened to be nearby.
 */
import type { StandardPosition, PlaybookClause } from '../domain/types.ts';

export type { StandardPosition, PlaybookClause };

/** Mirrors `src/lib/docxRedlines.ts`'s `RedlineEditKind`. `'moved'` is in
 *  the union deliberately (R-F3): without it a relocated clause is
 *  misreported as an unrelated delete-then-insert. */
export type RedlineEditKind = 'insertion' | 'deletion' | 'comment' | 'moved';

export interface RedlineEdit {
  documentId: string;
  kind: RedlineEditKind;
  text: string;
  context: string;
  clauseRef?: string;
  source: 'tracked' | 'diff';
  author?: string;
  at?: number;
}

export type ChangeKind = 'confirm' | 'drift' | 'new_clause';

export interface ChangesetItem {
  id: string;
  kind: ChangeKind;
  title?: string;
  clauseId?: string;
  currentText?: string;
  proposedText: string;
  rationale: string;
  basis: RedlineEdit[];
  decision: 'open' | 'accepted' | 'reworded' | 'declined';
  rewordedText?: string;
}

export interface ChangesetLike {
  id: string;
  playbookId: string;
  fromVersionId: string;
  sourceSummary: string;
  items: ChangesetItem[];
}

/** A decision that has actually been made, one way or the other — the
 *  complement of `'open'`. Distinguishing this from "truthy decision string"
 *  matters because `'declined'` is exactly as decided as `'accepted'`; both
 *  are excluded from `isPublishable` below for different reasons. */
export function isDecided(item: ChangesetItem): boolean {
  return item.decision !== 'open';
}

/**
 * The publish filter (spec §7, §9 — mutation-tested). ONLY an `accepted` or
 * `reworded` item may reach a published version. A `declined` item is a
 * person's explicit "no" and an `open` one has no decision at all yet —
 * "not yet decided" and "decided no" are different claims, and neither
 * belongs in the instrument every future review measures documents against.
 */
export function isPublishable(item: ChangesetItem): boolean {
  return item.decision === 'accepted' || item.decision === 'reworded';
}

/** The text to publish for an accepted/reworded item. A `reworded` item
 *  publishes the HUMAN's rewording, never the model's original proposal —
 *  rewording is itself the decision, and publishing the untouched proposal
 *  instead would put words into the playbook that nobody actually
 *  approved. Falls back to `proposedText` only if `rewordedText` is somehow
 *  absent (should not happen — the reword control always supplies one — but
 *  a missing field is not license to publish nothing). */
export function publishedTextFor(item: ChangesetItem): string {
  return item.decision === 'reworded' ? (item.rewordedText ?? item.proposedText) : item.proposedText;
}

/** `StandardPosition.provenance` for a position that reached the playbook
 *  through a changeset — the same honesty rule `authoringDraft.ts`'s
 *  `positionProvenance` follows for E, drawn here because a changeset's
 *  provenance facts (the source deal, whether a person reworded it) live on
 *  the `Changeset`/`ChangesetItem`, not on an `AuthoringDraft`. */
export function provenanceFor(changeset: ChangesetLike, item: ChangesetItem): string {
  const engagement = item.decision === 'reworded'
    ? 'reworded and accepted by a person reviewing a changeset'
    : 'accepted by a person reviewing a changeset';
  return `Learned from ${changeset.sourceSummary}; ${engagement}.`;
}

/**
 * The title for a brand-new clause a `new_clause` item proposes.
 *
 * Reads `item.title` — `buildChangeset.ts`'s `resolveItem` sets it directly
 * (`matched?.title ?? clauseTitle`). Falls back to `basis[0]?.clauseRef`
 * only for a changeset saved before that field existed: `resolveItem` never
 * returns an item with an empty `basis` — an item resting on zero resolvable
 * edits is dropped entirely rather than kept with no evidence — so the
 * fallback is always available for such a record. `ChangesetReview.tsx`'s
 * `itemTitle` makes the identical read, for the identical reason.
 */
export function newClauseTitle(item: ChangesetItem): string {
  const title = item.title?.trim() || item.basis[0]?.clauseRef?.trim();
  if (!title) throw new Error('This new-clause proposal has no title recorded to publish it under.');
  return title;
}

/** A visible placeholder, not a guess — the same choice `generateDraft.ts`'s
 *  `repairClause` makes for a clause with a title but no instruction: an
 *  empty or generic extraction prompt is a gap someone can see and fill in
 *  from the playbook editor, which is honester than fabricating a specific
 *  instruction a changeset never actually reasoned about. */
export function defaultExtractPrompt(title: string): string {
  return `Extract the clause on ${title}.`;
}

/** Applies ONE accepted/reworded item onto a working clause list, returning
 *  a new array. A matched item (`clauseId` set) updates that clause's
 *  `standardPosition` in place, keeping its id and title — the clause is
 *  unchanged if the caller never reaches this function for it (a declined or
 *  open item never does). An unmatched (`new_clause`) item appends a fresh
 *  clause. Applied uniformly regardless of `kind`: a `confirm` item's
 *  `proposedText` is by construction identical to the clause's current text
 *  (`buildChangeset`'s own classification rule), so applying it is a
 *  content no-op that still records the reconfirmation's provenance — one
 *  code path rather than a `confirm` special case that could itself drift
 *  from the other two.
 *
 *  `mintId` is a PARAMETER because minting an id is the one thing here that
 *  is not pure, and the two callers mint differently — the browser's `uid()`
 *  and the API's own. Passing it is what let this function move into
 *  `packages/core` at all.
 */
export function applyItem(
  clauses: PlaybookClause[],
  changeset: ChangesetLike,
  item: ChangesetItem,
  mintId: () => string,
): PlaybookClause[] {
  const standardPosition: StandardPosition = {
    text: publishedTextFor(item),
    origin: 'learned',
    reviewedByHuman: true,
    provenance: provenanceFor(changeset, item),
  };

  if (item.clauseId) {
    const idx = clauses.findIndex(c => c.id === item.clauseId);
    if (idx === -1) {
      throw new Error(
        'This changeset refers to a clause that no longer exists in the playbook — publish it against a fresh '
        + 'changeset instead.',
      );
    }
    const next = [...clauses];
    next[idx] = { ...next[idx], standardPosition };
    return next;
  }

  const title = newClauseTitle(item);
  const newClause: PlaybookClause = {
    id: mintId(),
    title,
    extractPrompt: defaultExtractPrompt(title),
    standardPosition,
  };
  return [...clauses, newClause];
}

/** The change summary D's publish path requires on every version after v1 —
 *  composed here, not left blank, because a version history whose entries do
 *  not say what changed is a list of dates (CLAUDE.md). Names the deal the
 *  changeset came from and what was decided, never invents detail the
 *  changeset does not actually record. */
export function changeSummaryFor(changeset: ChangesetLike, applied: ChangesetItem[]): string {
  const accepted = applied.filter(i => i.decision === 'accepted').length;
  const reworded = applied.filter(i => i.decision === 'reworded').length;
  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (reworded > 0) parts.push(`${reworded} reworded`);
  const decided = parts.length > 0 ? parts.join(', ') : 'no changes accepted';
  return `Changeset from ${changeset.sourceSummary} — ${decided}.`;
}

/**
 * The whole derivation, in one call: the clause list a changeset's decided
 * items produce from a base version's, plus the summary that describes it.
 *
 * Both callers need exactly this and nothing else around it, so it is here
 * rather than assembled twice. It does NOT check whether the base is stale
 * or whether any item is still open — those are refusals, they need a store
 * to diagnose, and each side answers them in its own vocabulary (an
 * exception in the browser, a `ModelError` with a code on the wire).
 */
export function nextVersionContent(
  changeset: ChangesetLike,
  baseClauses: PlaybookClause[],
  mintId: () => string,
): { clauses: PlaybookClause[]; changeSummary: string } {
  const applied = changeset.items.filter(isPublishable);
  let clauses = structuredClone(baseClauses);
  for (const item of applied) clauses = applyItem(clauses, changeset, item, mintId);
  return { clauses, changeSummary: changeSummaryFor(changeset, applied) };
}
