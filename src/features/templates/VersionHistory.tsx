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
                    {/* "Published by you", never the raw `publishedByUserId` —
                       see the component doc comment / cd89c27. A version with
                       no recorded author (pre-migration data) says nothing
                       about who, rather than guessing. */}
                    {v.publishedByUserId && (
                      <span className="font-ui text-meta text-ink-4">Published by you</span>
                    )}
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
