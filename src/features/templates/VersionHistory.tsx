import React from 'react';
import type { PlaybookVersion } from '../../types';
import { Modal } from '../../components/Modal';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { actorPhrase, type DispositionAudience } from '../../lib/findingOutcome';

export interface VersionHistoryProps {
  /** Newest first, as `listVersions` returns them. */
  versions: PlaybookVersion[];
  /** Set when the load FAILED. Renders the error branch instead of the
   *  list, never an empty list — CLAUDE.md's rule that every screen backed
   *  by IndexedDB distinguishes "empty" from "broken" and offers a retry.
   *  A string rather than the raw error because every other load site in
   *  this app classifies through `describeLoadError` before rendering. */
  error?: string;
  /** Optional, but its ABSENCE no longer suppresses the error: the branch
   *  below turns on `error` alone. `error && onRetry` meant a caller that
   *  had a failure and no retry rendered "Nothing published yet" over a
   *  playbook with four versions — empty-versus-broken, inverted by the
   *  guard meant to enforce it. */
  onRetry?: () => void;
  onClose: () => void;
  loading?: boolean;
  /** ADDED BY TASK 10, and OPTIONAL: version id to the names of the matters
   *  whose reviews ran against it. Built by the caller from `listReviews()`
   *  + `Review.playbookVersionId` (Task 4). A version absent from this map
   *  has not been used yet, which the row says in words — a blank cell
   *  reads as a rendering failure. Absent map, same words: a caller that
   *  has not gathered reviews gets the same honest "not used yet" for every
   *  version, rather than this component guessing. */
  matterNamesByVersion?: Record<string, string[]>;
  /**
   * How a `publishedByUserId` becomes a name — M2, and the reason the
   * component doc comment below was rewritten.
   *
   * Optional on the same terms as every other audience prop in this app: a
   * caller with no directory gets a sentence saying no name is available,
   * never an invented one and never a raw uuid.
   */
  audience?: DispositionAudience;
}

/**
 * What each published version of a playbook said, and when.
 *
 * Spec §8 gives the editor "a link to version history"; this is what the
 * link leads to. There is deliberately NO edit affordance: a published
 * version is immutable, because a review that says "ran against v4" has to
 * be able to prove what v4 was, so offering to edit one would promise
 * something the store refuses.
 *
 * Started here by Task 9A rather than duplicated, so Task 10 extends this
 * file (matter usage per version, and the review header's link into it)
 * instead of replacing a temporary block. Task 9A deliberately omitted two
 * things, both added here: `matterNamesByVersion`, and each version's
 * author.
 *
 * ## THE AUTHOR IS NAMED, AND THIS IS THE SCREEN WHERE THAT MATTERS MOST
 *
 * Every row used to read "Published by you" whenever `publishedByUserId` was
 * set, justified by ruling R1 — *"this app is single-user … so the one local
 * profile that could have published a version always is it"*. That reasoning
 * expired in Stage 4 and this screen is the worst place for it to have
 * survived: publishing is the ONE `partner` write in the entire route table
 * (`POST /v1/playbooks/:id/versions`), so a reviewer cannot publish and a
 * partner can, which makes the version history the one screen where the
 * author is GUARANTEED to sometimes be somebody other than the reader. A
 * reviewer opening it read "v3 … Published by you" over a partner's changed
 * standard position, with no way to find who actually did it.
 *
 * The raw `publishedByUserId` is still never printed — that is a defect this
 * project shipped once and fixed (`NetPositionPanel`, commit cd89c27:
 * "Confirmed by vzcsj71fs7mtalycwr" reached a reader). `actorPhrase` is the
 * third option and the one both rules allow: a name, or a sentence saying no
 * name is available. A version with no recorded author at all (pre-migration
 * data) is a statement about the RECORD, which `actorPhrase` says in its own
 * words rather than this file inventing a second wording for it.
 */
/** The audience this modal falls back to when its caller hands it none. It
 *  names NOBODY, for the reason `FindingCard`'s copy of this gives: honest
 *  rather than helpful, and never a name somebody did not have. */
const NO_DIRECTORY: DispositionAudience = {
  nameOf: () => undefined,
  initialsOf: () => undefined,
  timeOf: (at: number) => new Date(at).toLocaleString(),
};

export function VersionHistory({
  versions, error, onRetry, onClose, loading, matterNamesByVersion, audience,
}: VersionHistoryProps) {
  return (
    <Modal isOpen title="Version history" onClose={onClose} size="lg">
      {error ? (
        <LoadErrorPanel message={error} onRetry={onRetry} compact />
      ) : loading ? (
        <p className="font-ui text-ui text-ink-4">Loading versions…</p>
      ) : versions.length === 0 ? (
        <p className="font-ui text-ui text-ink-3">
          Nothing published yet. Publishing freezes the current draft as v1.
        </p>
      ) : (
        // 4c timeline (§9.6): the current version is a FILLED node, every
        // prior one an OUTLINE node, joined by a hairline connector — no
        // "Current" label text, because the shapes already say which one is
        // which and adding a word here would be new copy this cosmetic task
        // has no licence for (R-G6). `versions[0]` is current because the
        // caller hands them newest-first (see the prop doc comment).
        <ol className="space-y-3">
          {versions.map((v, i) => {
            const matterNames = matterNamesByVersion?.[v.id] ?? [];
            const isCurrent = i === 0;
            return (
              <li key={v.id} className="relative pl-6">
                {i < versions.length - 1 && (
                  <span aria-hidden="true" className="absolute left-[5px] top-5 bottom-[-12px] w-px bg-rule" />
                )}
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-2 w-[11px] h-[11px] rounded-meter ${
                    isCurrent ? 'bg-accent' : 'border border-ink-4 bg-card'
                  }`}
                />
                <div className="border border-rule rounded-card p-3 bg-card">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-chip uppercase text-accent">v{v.version}</span>
                    <span className="font-mono text-pin text-ink-4">
                      {new Date(v.publishedAt).toLocaleString()}
                    </span>
                    <span className="font-mono text-pin text-ink-4">{v.clauses.length} clauses</span>
                    {/* The PERSON, never "you" and never the raw
                       `publishedByUserId` — see the component doc comment.
                       Rendered for every version, including one whose author
                       the record does not hold: an author line that
                       disappears reads as "nobody published this", which is
                       the blank-CSV-cell defect at a new surface. */}
                    <span className="font-ui text-meta text-ink-4">
                      Published by {actorPhrase(v.publishedByUserId, audience ?? NO_DIRECTORY)}
                    </span>
                  </div>
                  {/* v1 legitimately has no summary — there was nothing for it to
                     have changed from — and saying so reads as the fact it is,
                     where a blank line reads as a rendering failure. */}
                  <p className="mt-1 font-prose text-field text-ink-prose">
                    {v.changeSummary || 'No change summary — this was the first version.'}
                  </p>
                  {/* A blank cell reads as a rendering failure; "not used by any
                     review yet" reads as the fact it is. */}
                  <p className="mt-2 font-ui text-meta text-ink-4">
                    {matterNames.length > 0
                      ? `Used by ${matterNames.join(', ')}`
                      : 'Not used by any review yet.'}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
