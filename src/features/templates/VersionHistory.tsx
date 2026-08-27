import React from 'react';
import type { PlaybookVersion } from '../../types';
import { Modal } from '../../components/Modal';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

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
 * author. The author is resolved to "you" rather than printed as the raw
 * `publishedByUserId` it is stored as — this app is single-user (ruling
 * R1: identity fields are schema-ready but nothing routes an assignment to
 * anyone else), so the one local profile that could have published a
 * version always is it, and printing the id instead is a defect this
 * project has already shipped once and fixed (`NetPositionPanel`, commit
 * cd89c27: "Confirmed by vzcsj71fs7mtalycwr" reached a reader). A version
 * with no recorded author (pre-migration data) says nothing about who,
 * rather than inventing "an unknown user" — which reads as "somebody else",
 * the very implication R1 forbids.
 */
export function VersionHistory({
  versions, error, onRetry, onClose, loading, matterNamesByVersion,
}: VersionHistoryProps) {
  return (
    <Modal isOpen title="Version history" onClose={onClose} size="lg">
      {error ? (
        <LoadErrorPanel message={error} onRetry={onRetry} compact />
      ) : loading ? (
        <p className="text-sm text-gray-500">Loading versions…</p>
      ) : versions.length === 0 ? (
        <p className="text-sm text-gray-400">
          Nothing published yet. Publishing freezes the current draft as v1.
        </p>
      ) : (
        <ol className="space-y-3">
          {versions.map(v => {
            const matterNames = matterNamesByVersion?.[v.id] ?? [];
            return (
              <li key={v.id} className="border border-white/10 rounded-lg p-3 bg-black/30">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-sm font-mono font-bold text-violet-300">v{v.version}</span>
                  <span className="text-xs text-gray-500">
                    {new Date(v.publishedAt).toLocaleString()}
                  </span>
                  <span className="text-xs text-gray-500">{v.clauses.length} clauses</span>
                  {/* "Published by you", never the raw `publishedByUserId` —
                     see the component doc comment / cd89c27. A version with
                     no recorded author (pre-migration data) says nothing
                     about who, rather than guessing. */}
                  {v.publishedByUserId && (
                    <span className="text-xs text-gray-500">Published by you</span>
                  )}
                </div>
                {/* v1 legitimately has no summary — there was nothing for it to
                   have changed from — and saying so reads as the fact it is,
                   where a blank line reads as a rendering failure. */}
                <p className="mt-1 text-sm text-gray-300">
                  {v.changeSummary || 'No change summary — this was the first version.'}
                </p>
                {/* A blank cell reads as a rendering failure; "not used by any
                   review yet" reads as the fact it is. */}
                <p className="mt-2 text-xs text-gray-500">
                  {matterNames.length > 0
                    ? `Used by ${matterNames.join(', ')}`
                    : 'Not used by any review yet.'}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}
