import { getDb } from './open';
import { STORES } from './schema';
import { getPlaybook, publishAndPoint } from './playbooks';
import { getVersion } from './playbookVersions';
import { uid } from '../uid';
import type { Changeset, ChangesetItem, PlaybookClause, PlaybookDraft, PlaybookVersion } from '../../types';

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

/**
 * Thrown by `publishChangeset` when the playbook has moved on since this
 * changeset was built — `Playbook.currentVersionId` no longer matches
 * `Changeset.fromVersionId`. Someone published a newer version in the
 * meantime (from the playbook editor, or another changeset), and that
 * version's clauses are not in this changeset's `basis` at all: it was
 * built by reading a version that is no longer the live one.
 *
 * Publishing anyway would build the next version from `fromVersionId`'s
 * OLD clause list (see `publishChangeset`'s docstring) and silently
 * REVERT whatever the newer version added — a lost update dressed as a
 * normal publish, presented with the same confidence as a version anyone
 * actually approved. CLAUDE.md's rule outranks convenience here: refusing
 * is the loud, recoverable failure; reverting a colleague's published
 * work with no trace is the quiet, catastrophic one.
 *
 * A distinguishable type (not a generic `Error`) so `ChangesetReview` — or
 * any future caller — can choose to react to it specifically rather than
 * just display its text; today it is displayed exactly like the generic
 * storage-full message, through the same `publishError` string prop.
 */
export class ChangesetStaleBaseError extends Error {
  constructor() {
    super(
      'This playbook has moved on since this changeset was built — a newer version has already been published. ' +
        'The decisions recorded on this changeset are safe and have not been lost, but it needs to be rebuilt ' +
        'against the current version before it can be published.',
    );
    this.name = 'ChangesetStaleBaseError';
  }
}

/**
 * Persists a changeset — a create or an update, since `Changeset.id` is
 * minted once by `buildChangeset` and never reused, so `put` is always an
 * upsert of the SAME record rather than a risk of colliding with another
 * one. Callers write through this on every decision (accept/reword/decline)
 * as well as on first build, per CLAUDE.md's "await-then-apply" rule: the
 * UI must not believe a decision was recorded until the store confirms it.
 *
 * Mirrors `playbookVersions.ts`'s shape: an explicit readwrite transaction
 * with nothing non-IDB awaited inside it, `tx.done` awaited before
 * returning, and a generic storage-full message on any failure — the same
 * idiom every store in this module uses, rather than a second one invented
 * here. There is no sequence number to allocate (a `Changeset` has no
 * monotonic ordering the way a `PlaybookVersion` does — `createdAt` plus its
 * own minted `id` is enough), so this is `publishVersion`'s shape minus the
 * allocation step it exists for.
 */
export async function saveChangeset(changeset: Changeset): Promise<Changeset> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORES.changesets, 'readwrite');
    await tx.store.put(changeset);
    await tx.done;
  } catch {
    throw new Error(STORAGE_FULL_MESSAGE);
  }
  return changeset;
}

export async function getChangeset(id: string): Promise<Changeset | null> {
  const db = await getDb();
  return (await db.get(STORES.changesets, id)) ?? null;
}

/** A playbook's changesets, most recently created first. */
export async function listChangesets(playbookId: string): Promise<Changeset[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORES.changesets, 'byPlaybook', playbookId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Records a person's decision on one item and persists the whole changeset —
 * the write every accept/reword/decline control in `ChangesetReview` goes
 * through, per CLAUDE.md's "await-then-apply" rule: the screen must not show
 * a decision as recorded until the store has actually confirmed it.
 *
 * Takes the whole `changeset` as a value rather than an id, the same shape
 * `authoringDraft.ts`'s `editClause`/`keepClause` use: the caller already
 * holds the current object (there is no server copy to race against), and a
 * second read here would only be a chance for it to be stale against an
 * in-flight edit the caller has not saved yet.
 *
 * `rewordedText` is stamped ONLY when `decision` is `'reworded'`, and
 * deleted — never set to `undefined` — otherwise: `structuredClone` (how
 * IndexedDB writes every record) PRESERVES an `undefined`-valued key, so an
 * item accepted after once being reworded must not still carry stale reword
 * text a reader could mistake for what was actually decided.
 */
export async function recordDecision(
  changeset: Changeset,
  itemId: string,
  decision: ChangesetItem['decision'],
  rewordedText?: string,
): Promise<Changeset> {
  const items = changeset.items.map((item): ChangesetItem => {
    if (item.id !== itemId) return item;
    const next: ChangesetItem = { ...item, decision };
    if (decision === 'reworded' && rewordedText !== undefined) {
      next.rewordedText = rewordedText;
    } else {
      delete next.rewordedText;
    }
    return next;
  });
  return saveChangeset({ ...changeset, items });
}

/** A decision that has actually been made, one way or the other — the
 *  complement of `'open'`. Distinguishing this from "truthy decision string"
 *  matters because `'declined'` is exactly as decided as `'accepted'`; both
 *  are excluded from `isPublishable` below for different reasons. */
function isDecided(item: ChangesetItem): boolean {
  return item.decision !== 'open';
}

/**
 * The publish filter (spec §7, §9 — mutation-tested). ONLY an `accepted` or
 * `reworded` item may reach a published version. A `declined` item is a
 * person's explicit "no" and an `open` one has no decision at all yet —
 * "not yet decided" and "decided no" are different claims, and neither
 * belongs in the instrument every future review measures documents against.
 */
function isPublishable(item: ChangesetItem): boolean {
  return item.decision === 'accepted' || item.decision === 'reworded';
}

/** The text to publish for an accepted/reworded item. A `reworded` item
 *  publishes the HUMAN's rewording, never the model's original proposal —
 *  rewording is itself the decision, and publishing the untouched proposal
 *  instead would put words into the playbook that nobody actually
 *  approved. Falls back to `proposedText` only if `rewordedText` is somehow
 *  absent (should not happen — `ChangesetReview`'s reword control always
 *  supplies one — but a missing field is not license to publish nothing). */
function publishedTextFor(item: ChangesetItem): string {
  return item.decision === 'reworded' ? (item.rewordedText ?? item.proposedText) : item.proposedText;
}

/** `StandardPosition.provenance` for a position that reached the playbook
 *  through a changeset — the same honesty rule `authoringDraft.ts`'s
 *  `positionProvenance` follows for E, drawn here because a changeset's
 *  provenance facts (the source deal, whether a person reworded it) live on
 *  the `Changeset`/`ChangesetItem`, not on an `AuthoringDraft`. */
function provenanceFor(changeset: Changeset, item: ChangesetItem): string {
  const engagement = item.decision === 'reworded'
    ? 'reworded and accepted by a person reviewing a changeset'
    : 'accepted by a person reviewing a changeset';
  return `Learned from ${changeset.sourceSummary}; ${engagement}.`;
}

/**
 * The title for a brand-new clause a `new_clause` item proposes.
 *
 * Reads `item.title` — `buildChangeset.ts`'s `resolveItem` sets it directly
 * now (`matched?.title ?? clauseTitle`). Falls back to `basis[0]?.clauseRef`
 * only for a changeset saved before that field existed: `resolveItem` never
 * returns an item with an empty `basis` — an item resting on zero resolvable
 * edits is dropped entirely rather than kept with no evidence — so the
 * fallback is always available for such a record. `ChangesetReview.tsx`'s
 * `itemTitle` makes the identical read, for the identical reason.
 */
function newClauseTitle(item: ChangesetItem): string {
  const title = item.title?.trim() || item.basis[0]?.clauseRef?.trim();
  if (!title) throw new Error('This new-clause proposal has no title recorded to publish it under.');
  return title;
}

/** A visible placeholder, not a guess — the same choice `generateDraft.ts`'s
 *  `repairClause` makes for a clause with a title but no instruction: an
 *  empty or generic extraction prompt is a gap someone can see and fill in
 *  from the playbook editor, which is honester than fabricating a specific
 *  instruction a changeset never actually reasoned about. */
function defaultExtractPrompt(title: string): string {
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
 *  from the other two. */
function applyItem(clauses: PlaybookClause[], changeset: Changeset, item: ChangesetItem): PlaybookClause[] {
  const standardPosition = {
    text: publishedTextFor(item),
    origin: 'learned' as const,
    reviewedByHuman: true,
    provenance: provenanceFor(changeset, item),
  };

  if (item.clauseId) {
    const idx = clauses.findIndex((c) => c.id === item.clauseId);
    if (idx === -1) {
      throw new Error(
        'This changeset refers to a clause that no longer exists in the playbook — publish it against a fresh ' +
          'changeset instead.',
      );
    }
    const next = [...clauses];
    next[idx] = { ...next[idx], standardPosition };
    return next;
  }

  const title = newClauseTitle(item);
  const newClause: PlaybookClause = {
    id: uid(),
    title,
    extractPrompt: defaultExtractPrompt(title),
    standardPosition,
  };
  return [...clauses, newClause];
}

/** The change summary D's `publishVersionIn` requires on every version after
 *  v1 — composed here, not left blank, because a version history whose
 *  entries do not say what changed is a list of dates (CLAUDE.md). Names the
 *  deal the changeset came from and what was decided, never invents detail
 *  the changeset does not actually record. */
function changeSummaryFor(changeset: Changeset, applied: ChangesetItem[]): string {
  const accepted = applied.filter((i) => i.decision === 'accepted').length;
  const reworded = applied.filter((i) => i.decision === 'reworded').length;
  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (reworded > 0) parts.push(`${reworded} reworded`);
  const decided = parts.length > 0 ? parts.join(', ') : 'no changes accepted';
  return `Changeset from ${changeset.sourceSummary} — ${decided}.`;
}

/**
 * Publishes a changeset's ACCEPTED and REWORDED items as the playbook's next
 * version, through D's existing atomic publish path (`publishAndPoint` in
 * `./playbooks`) — spanning both the `playbooks` and `playbookVersions`
 * stores in one transaction, so there is no window in which a version is
 * durable and the identity record is not. This function does not reimplement
 * any part of that sequence: sub-project E's `saveDraftAsV1` already had
 * this exact ruling superseded once (see its docstring) after an earlier
 * two-write version of the same idea reopened the orphan window D closed.
 *
 * Refuses outright if any item is still `'open'` — "not yet decided" and
 * "decided no" are different claims, and publishing while either is present
 * would either drop a proposal nobody actually rejected or (if open items
 * were silently skipped) let a triager believe skipping review is the same
 * as declining. A `declined` item is fine to publish alongside others: it
 * simply contributes nothing (`isPublishable` below).
 *
 * The new version's clause list starts from `fromVersionId`'s clauses,
 * UNCHANGED except where an accepted/reworded item names a clause: that
 * clause's `standardPosition` is replaced, or (for a `new_clause` item) a
 * new clause is appended. Every clause the changeset never proposed
 * anything for — including one whose item was declined — carries forward
 * exactly as `fromVersionId` had it; `buildChangeset` never proposes an item
 * for a clause the deal did not address, so "carried forward unchanged"
 * covers the rest of a real playbook, not a hypothetical (spec §6's "never
 * guess a position from silence", applied here to publishing rather than
 * inference).
 *
 * On success, the changeset is updated with `publishedVersionId` so a
 * reviewer can see it was acted on — but ONLY after `publishAndPoint` has
 * actually returned, and this function does not touch the `changesets`
 * store at all before that. If `publishAndPoint` throws, the error
 * propagates immediately: every decision already recorded on the changeset
 * (via `recordDecision`, before this call) is left exactly as it was (spec
 * §8 — "the review work is the expensive part and must not be lost to a
 * write failure").
 *
 * REFUSES if the playbook's `currentVersionId` no longer matches
 * `changeset.fromVersionId` — throwing `ChangesetStaleBaseError` before
 * touching `playbookVersions` or `changesets` at all, for the same
 * "decisions are never lost to a write failure" reason above. This is not
 * a write failure; it is a diagnosed conflict caught before any write is
 * attempted, but the guarantee it must uphold is identical. Without this
 * check, the draft built below would start from `fromVersionId`'s clause
 * list even though a newer version is live — silently REVERTING whichever
 * clauses that newer version added or changed, with nothing on screen to
 * say so (ruling, `docs/superpowers/redesign/rulings.md`). Reconciling the
 * two instead of refusing is deliberately NOT attempted: merging a
 * changeset's proposals against clauses it never saw would produce a
 * version no human actually reviewed, which is worse than making someone
 * rebuild it.
 */
export async function publishChangeset(changeset: Changeset, byUserId: string): Promise<PlaybookVersion> {
  if (changeset.items.some((item) => !isDecided(item))) {
    throw new Error(
      'This changeset still has undecided items — every item must be accepted, reworded or declined before it ' +
        'can be published.',
    );
  }

  const playbook = await getPlaybook(changeset.playbookId);
  if (!playbook) throw new Error('The playbook this changeset belongs to no longer exists.');
  if (playbook.currentVersionId !== changeset.fromVersionId) throw new ChangesetStaleBaseError();
  const base = await getVersion(changeset.fromVersionId);
  if (!base) throw new Error('The version this changeset was built against no longer exists.');

  const applied = changeset.items.filter(isPublishable);
  let clauses = structuredClone(base.clauses);
  for (const item of applied) clauses = applyItem(clauses, changeset, item);

  const draft: PlaybookDraft = {
    name: base.name,
    contractType: base.contractType,
    systemPrompt: base.systemPrompt,
    formatPrompt: base.formatPrompt,
    clauses,
    changeSummary: changeSummaryFor(changeset, applied),
  };
  if (base.riskTolerance !== undefined) draft.riskTolerance = base.riskTolerance;

  const { version } = await publishAndPoint(playbook, draft, byUserId);
  await saveChangeset({ ...changeset, publishedVersionId: version.id });
  return version;
}
