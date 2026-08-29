import { uid } from '../../lib/uid';
import type { AuthoringDraft, DraftClause } from '../../lib/authoringDraft';
import type { InferredPosition } from '../../lib/inferPositions';

/**
 * Turns the positions a person ADOPTED or REWORDED on "What we learned"
 * into sub-project E's session-only `AuthoringDraft`, so a playbook learned
 * from redlines is published as a genuine **v1** through E's draft review
 * and `saveDraftAsV1` — not through F's changeset mechanism.
 *
 * Why this exists at all (Task 10A's correction). Task 10A routed this flow
 * into `buildChangeset`/`publishChangeset`, which both require a LIVE
 * `PlaybookVersion`, so it minted a playbook and published an **empty v1**
 * for the adopted positions to be a v2 against. That was wrong four times
 * over, and the first is the one that matters here: a version history in
 * this app is an audit trail — every review records the version it ran
 * against — and an empty v1 records a state the playbook was never in. It
 * also orphaned a playbook whenever the flow was abandoned after intake,
 * made the `confirm`/`drift`/`new_clause` classification degenerate (an
 * empty version matches nothing, so everything is `new_clause`), and spent
 * a second model call producing that empty classification.
 *
 * The changeset mechanism is still exactly right for its own case — a new
 * deal read against a version that really exists — and is untouched. It is
 * simply not the mechanism for creating a playbook that has no prior
 * version to compare against.
 *
 * Nothing here writes anything. The draft this returns is session-only
 * (R-E1) and becomes durable at exactly one moment: when a person clears
 * E's save gate (`canSaveDraft` — every clause kept or cut, at least one
 * kept) and `saveDraftAsV1` publishes it. Abandon the flow before that and
 * no playbook, and no version, exists.
 */

/** The positions this flow carries forward. A `rejected` position ("not a
 *  house rule") and an `undecided` one both contribute nothing — "not a
 *  house rule" has to actually keep the position out of the playbook, not
 *  merely hide a button. */
export function includedPositions(positions: InferredPosition[]): InferredPosition[] {
  return positions.filter((p) => p.disposition === 'adopted' || p.disposition === 'reworded');
}

/** The words that will become the standard position: what the person wrote
 *  if they reworded it, otherwise what the model stated and they adopted.
 *  A `reworded` position whose text is empty falls back to the statement
 *  rather than publishing a blank house rule (the same guard
 *  `StandardPositionField` and `DraftReview` apply for the same reason:
 *  a position with no text reads as one until something looks at it). */
export function positionText(position: InferredPosition): string {
  const reworded = position.rewordedText?.trim();
  return position.disposition === 'reworded' && reworded ? reworded : position.statement;
}

/**
 * The extraction instruction a learned clause starts with.
 *
 * The redlines say what the firm's POSITION is; they say nothing about how
 * a reviewer should go looking for the clause in a new contract. Rather
 * than ask a model to invent one (a second call, for a field the person is
 * about to be shown anyway), every clause starts from this plainly-derived
 * instruction and is shown in `DraftReview`'s "Extract"
 * field, where it must be read before the clause can be kept — E's save
 * gate does not let an unreviewed clause through.
 */
export function defaultExtractPrompt(clauseTitle: string): string {
  return `What does this agreement say about ${clauseTitle}? Quote the operative wording.`;
}

/**
 * The documents that actually taught this draft — only those behind a
 * SUPPORTING basis entry of a position being carried forward.
 *
 * Deliberately not "every document in the session", mirroring E's
 * `usedFewShotSources` (its m2 fix) for the same reason: `learnedFrom`
 * feeds `positionProvenance`, which is stamped onto every published
 * position, and crediting a document that contributed nothing — or one
 * whose only edits fed a position the person rejected — overstates what
 * happened. Names come from the caller's session map; a document with no
 * name recorded contributes nothing rather than an opaque id.
 */
export function learnedFromNames(
  positions: InferredPosition[],
  documentNames: Record<string, string>,
): string[] {
  const names: string[] = [];
  for (const position of positions) {
    for (const entry of position.basis) {
      if (!entry.supports) continue;
      const name = documentNames[entry.documentId];
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Builds the draft. Every clause arrives `unreviewed`: adopting a position
 * on "What we learned" is a judgement about the POSITION, and a playbook
 * clause is more than that — it also carries the instruction that will go
 * looking for it. The person sees each one in E's draft review before any
 * of it is published.
 *
 * `standardPosition.reviewedByHuman` starts `false`, exactly as a
 * model-drafted position does in E. `toPlaybookDraft` flips it to `true` at
 * the moment of publish, which is the moment a person has actually read the
 * text being published; claiming it here would move that claim one screen
 * earlier than the act it describes.
 *
 * `origin: 'learned'` — not `'ai-drafted'` — because that is what happened:
 * the position was read out of the firm's own documents. It is also what
 * makes `positionProvenance` say "Learned from <documents>" rather than
 * naming a model as the author of a house rule the firm wrote in its own
 * redlines.
 *
 * `contractType` names the playbook this will become — a ruling on the gap
 * Task 10A-fix left open (R-F-fix-1): that version named every redlines
 * playbook with the same constant, which is unusable the moment the flow
 * runs twice — two playbooks in the library named identically, neither
 * saying what contract it is for. The caller reads it from a field on the
 * precedent-intake screen (`PrecedentIntake`'s "Playbook name"), the natural
 * place: the person is already telling the app what these documents are.
 * It is REQUIRED here and never defaulted — `handleRedlinesToDraftReview`
 * refuses to call this function at all until it is non-empty, mirroring how
 * `DraftForm` gates its own submit on `contractType.trim() !== ''` rather
 * than letting a blank one through to be silently named something generic.
 */
export function positionsToDraft(
  positions: InferredPosition[],
  documentNames: Record<string, string>,
  /** Already resolved by the caller through `modelProvenanceName` — a model
   *  NAME, never the allowlist alias. See `AuthoringDraft.modelId`. */
  modelId: string,
  contractType: string,
): AuthoringDraft {
  const included = includedPositions(positions);
  const clauses: DraftClause[] = included.map((position) => {
    // `edited`/`positionEdited` record whether a PERSON changed the wording
    // (R-E5) — a reword on "What we learned" is exactly that, and it is the
    // only thing that happened to this text before the draft review. They
    // are OR'd forward by `applyEdits`, so a reword here survives a clause
    // the person then keeps unchanged.
    const reworded = position.disposition === 'reworded';
    return {
      id: uid(),
      title: position.clauseTitle,
      extractPrompt: defaultExtractPrompt(position.clauseTitle),
      standardPosition: {
        text: positionText(position),
        origin: 'learned' as const,
        reviewedByHuman: false,
      },
      disposition: 'unreviewed' as const,
      edited: reworded,
      positionEdited: reworded,
      suggestions: [],
    };
  });

  return {
    contractType,
    learnedFrom: learnedFromNames(included, documentNames),
    modelId,
    clauses,
  };
}
