import { ModelError } from '@lexprompt/core';
import { apiGet, apiGetOrNull, apiSend } from '../api/client';
import type { Changeset, ChangesetItem, PlaybookVersion } from '../../types';

/**
 * The changesets repository — an HTTP client over `apps/api` since Stage 2.
 *
 * Same file, same exports, same signatures (R3). What moved OUT is the
 * publish itself: `publishChangeset` is now one route running one Postgres
 * transaction over `changeset`, `playbook` and `playbook_version`, and the
 * domain logic underneath it — which items reach the version, whose words
 * they carry, what the history entry says — moved to
 * `packages/core/src/playbook/applyChangeset.ts` so the browser and the
 * server share ONE implementation rather than one each. Two copies of the
 * code that decides what a published version says, reachable only from two
 * different processes, is this project's most repeated defect in its worst
 * available form.
 *
 * The file-local helpers that went with it (`isDecided`, `isPublishable`,
 * `publishedTextFor`, `provenanceFor`, `newClauseTitle`,
 * `defaultExtractPrompt`, `applyItem`, `changeSummaryFor`) are re-exported
 * from `@lexprompt/core` for anything that still reads them.
 */

/**
 * Thrown when the playbook has moved on since this changeset was built —
 * `Playbook.currentVersionId` no longer matches `Changeset.fromVersionId`.
 * Someone published a newer version in the meantime, and that version's
 * clauses are not in this changeset's `basis` at all.
 *
 * Publishing anyway would build the next version from `fromVersionId`'s OLD
 * clause list and silently REVERT whatever the newer version added — a lost
 * update dressed as a normal publish, presented with the same confidence as
 * a version anyone actually approved. Refusing is the loud, recoverable
 * failure; reverting a colleague's published work with no trace is the
 * quiet, catastrophic one.
 *
 * UNCHANGED in shape and in meaning; only its PROVENANCE moved. It used to
 * be thrown here after a local read of the playbook. It is now reconstructed
 * from the API's `changeset_stale_base` code, so `ChangesetReview.tsx` and
 * every existing test keep catching exactly the class they already catch.
 *
 * **The CODE is the contract and the message is not.** An exception's
 * identity dies at the wire; what arrives is a status and a body. A browser
 * matching on the server's wording across a network is a coupling nothing
 * tests, and this project has already shipped that exact defect (ruling S1):
 * *"reword any one and the browser silently stops classifying — no error, no
 * failing test."* So `'changeset_stale_base'` is in `MODEL_ERROR_CODES`, and
 * the server's message is free to change.
 *
 * `serverMessage` carries the API's own words — which name BOTH version
 * numbers, because "stale" with no numbers tells a person nothing they can
 * act on — while `message` keeps the sentence this class has always carried,
 * so a caller rendering `err.message` shows what it always showed.
 */
export class ChangesetStaleBaseError extends Error {
  /** What the server said, when this was reconstructed from a refusal.
   *  Absent when the class was constructed directly. */
  readonly serverMessage?: string;

  constructor(serverMessage?: string) {
    super(
      'This playbook has moved on since this changeset was built — a newer version has already been published. '
        + 'The decisions recorded on this changeset are safe and have not been lost, but it needs to be rebuilt '
        + 'against the current version before it can be published.',
    );
    this.name = 'ChangesetStaleBaseError';
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
  }
}

/**
 * Persists a changeset — a create or an update, since `Changeset.id` is
 * minted once by `buildChangeset` and never reused. Callers write through
 * this on every decision (accept/reword/decline) as well as on first build,
 * per CLAUDE.md's "await-then-apply" rule: the UI must not believe a
 * decision was recorded until the store confirms it.
 *
 * Returns the SAVED record, carrying the `version` the next save must state,
 * so a decision recorded against a changeset somebody else has since changed
 * is refused rather than applied over their work.
 */
export async function saveChangeset(changeset: Changeset): Promise<Changeset> {
  return apiSend<Changeset>(
    'PUT', `/v1/changesets/${encodeURIComponent(changeset.id)}`, changeset);
}

/** `null` for "there is no such changeset", and ONLY for that. */
export async function getChangeset(id: string): Promise<Changeset | null> {
  return apiGetOrNull<Changeset>(`/v1/changesets/${encodeURIComponent(id)}`);
}

/** A playbook's changesets, most recently created first. The order is the
 *  server's and is not re-derived here. Rejects rather than resolving to
 *  `[]` on a failure: "no changesets yet" and "the server failed" look
 *  identical on screen and only the first is a fact. */
export async function listChangesets(playbookId: string): Promise<Changeset[]> {
  return apiGet<Changeset[]>(
    `/v1/playbooks/${encodeURIComponent(playbookId)}/changesets`);
}

/**
 * Records a person's decision on one item and persists the whole changeset —
 * the write every accept/reword/decline control goes through, per CLAUDE.md's
 * "await-then-apply" rule.
 *
 * Takes the whole `changeset` as a value rather than an id: the caller
 * already holds the current object, and a second read here would only be a
 * chance for it to be stale against an in-flight edit the caller has not
 * saved yet.
 *
 * `rewordedText` is stamped ONLY when `decision` is `'reworded'`, and
 * deleted — never set to `undefined` — otherwise: `structuredClone`
 * PRESERVES an `undefined`-valued key, so an item accepted after once being
 * reworded must not still carry stale reword text a reader could mistake for
 * what was actually decided. JSON drops such a key instead, which is the
 * OTHER half of the same trap and the reason this stays a delete.
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

/**
 * Publishes a changeset's ACCEPTED and REWORDED items as the playbook's next
 * version.
 *
 * One request, one Postgres transaction. Everything the IndexedDB version
 * did in sequence — check every item is decided, read the playbook, refuse a
 * stale base, build the clause list, publish, point the playbook at it,
 * stamp the changeset — now happens together or not at all. The last step is
 * the one that gained a guarantee: stamping `publishedVersionId` used to be
 * a SECOND write after the publish returned, and a failure between them left
 * a version published with no changeset pointing at it.
 *
 * The refusals keep their meanings:
 *
 *  - An item still `'open'` refuses the publish. "Not yet decided" and
 *    "decided no" are different claims, and publishing while either is
 *    present would either drop a proposal nobody rejected or let a triager
 *    believe skipping review is the same as declining.
 *  - A stale base throws `ChangesetStaleBaseError`, RECONSTRUCTED FROM THE
 *    SERVER'S CODE. See that class's own note.
 *
 * Every decision already recorded on the changeset is left exactly as it was
 * when a publish fails — the review work is the expensive part and must not
 * be lost to a write failure. That is now the transaction's guarantee rather
 * than an ordering this function has to get right.
 */
export async function publishChangeset(
  changeset: Changeset,
  byUserId: string,
): Promise<PlaybookVersion> {
  void byUserId;
  try {
    return await apiSend<PlaybookVersion>(
      'POST', `/v1/changesets/${encodeURIComponent(changeset.id)}/publish`, {});
  } catch (err) {
    // ON THE CODE, never on the message. A `ModelError` carries the code
    // through `toModelError`, which reads it out of `body.error.code` and
    // checks it against `MODEL_ERROR_CODES` — so an unrecognised string
    // falls through rather than being cast into the union.
    if (err instanceof ModelError && err.code === 'changeset_stale_base') {
      throw new ChangesetStaleBaseError(err.message);
    }
    throw err;
  }
}
