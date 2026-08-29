import { canSaveDraft, toPlaybookDraft, type AuthoringDraft } from '../../lib/authoringDraft';
import { newPlaybook, publishAndPoint, type PositionBasisInput } from '../../lib/db/playbooks';
import type { Playbook, PlaybookVersion } from '../../types';

/** Sub-project E, Task 5 — `Save as v1` (spec §6).
 *
 * Turns a fully-reviewed `AuthoringDraft` into a published `PlaybookVersion`
 * through D's atomic publish path. `publishAndPoint` (`src/lib/db/
 * playbooks.ts`) is ONE readwrite transaction spanning both the
 * `playbooks` and `playbookVersions` stores, so there is no moment at
 * which a version is durable and the identity record is not (or vice
 * versa) — the property that closes the orphan window D's Task 9 fix round
 * closed for `importPlaybook`.
 *
 * R-E3's original text ("create the identity first, publish second, and on
 * a publish failure delete the orphan") is SUPERSEDED: it was written
 * against a world where those were two transactions, and the delete-the-
 * orphan step existed only to clean up a window that no longer exists.
 * Reimplementing that two-write sequence here — even "for safety" — would
 * *reopen* the orphan window rather than guard against one, so this
 * function does exactly one thing: mint the identity, convert the draft,
 * and hand both to `publishAndPoint`. See `saveDraftAsV1.test.ts`'s
 * "exactly one transaction" test, which is what would catch a regression
 * back to a two-write sequence.
 *
 * `canSaveDraft` is re-checked here rather than trusted from the caller.
 * `DraftReview`'s Save button is disabled while `canSaveDraft(draft)` is
 * false, but a disabled button is a UI convenience, not the gate itself —
 * the whole point of a gate is that it holds even when something other
 * than its one intended button reaches this function.
 */
export async function saveDraftAsV1(
  draft: AuthoringDraft,
  name: string,
  byUserId: string,
): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  if (!canSaveDraft(draft)) {
    throw new Error(
      'This draft still has clauses waiting for review — every clause must be kept or cut before it can be saved.',
    );
  }
  const identity = newPlaybook(name);
  const playbookDraft = toPlaybookDraft(draft, name);
  // The redline evidence, read off the KEPT clauses only — `toPlaybookDraft`
  // filters to `kept`, and a basis for a clause that was cut would be
  // evidence for a house rule nobody adopted. Recorded in the SAME
  // transaction as the publish (server §6.5): a position that was never
  // saved has no house rule to be the basis of, and a basis written outside
  // the publish could survive one that failed.
  return publishAndPoint(identity, playbookDraft, byUserId, basisOf(draft));
}

/** `position_basis` rows for every clause this save will actually publish. */
function basisOf(draft: AuthoringDraft): PositionBasisInput[] {
  return draft.clauses
    .filter((c) => c.disposition === 'kept' && c.basis && c.basis.length > 0)
    .flatMap((c) => c.basis!.map((entry) => ({
      clauseId: c.id,
      // WHAT THE POSITION SAYS AT THE MOMENT IT IS PUBLISHED, not what the
      // model first stated. A person may have reworded it on "What we
      // learned" or again in draft review, and the evidence has to be
      // recorded against the sentence actually adopted — four leases support
      // the wording that was adopted, not one it was rewritten from. This is
      // what makes the panel's "the wording has moved" comparison mean
      // anything later.
      adoptedText: c.standardPosition?.text ?? '',
      precedentSetId: entry.precedentSetId,
      documentId: entry.documentId,
      edits: entry.edits,
      diffDerivedOnly: entry.diffDerivedOnly,
    })))
    // A kept clause whose standard position was blanked has nothing for the
    // comparison to compare, so it records no basis rather than an empty
    // `adoptedText` against which every future wording would read as moved.
    .filter((entry) => entry.adoptedText.trim() !== '');
}
