import React from 'react';
import type { PlaybookVersion } from '../../types';

export interface ReviewVersionLineProps {
  /** `Review`/`ReviewRun`'s `playbookVersionId`. Absent means the review
   *  never recorded which version it ran against — pre-versioning data, or
   *  a playbook that never existed (R-D4). */
  versionId?: string;
  /** The result of actually resolving `versionId` against the LIVE
   *  playbookVersions store (e.g. `getVersion`), not a restatement of the
   *  review's own frozen snapshot: a snapshot's content survives its
   *  playbook being deleted, but the live version record does not (Task 3's
   *  delete cascade) — this line reports on the live record, which is the
   *  only thing that tells a reader whether Version History still has
   *  anywhere to send them.
   *
   *  `null` means the lookup ran and found nothing (R-D15's dangling case:
   *  the id is present but the version it named has been deleted). It must
   *  never be derived from `versionId`'s mere presence — that is exactly
   *  the confident-wrong-answer shape this component exists to close off,
   *  which is why this prop is required rather than defaulting to `null`. */
  version: PlaybookVersion | null;
  /** Opens Version History for the playbook this review ran against.
   *  Omitted, the resolved case renders as plain text with nothing to
   *  click — there is no live destination to send the reader to until a
   *  caller supplies one. */
  onOpenHistory?: () => void;
}

/**
 * The review header's "ran against vN" line (spec §8 / DoD #6, ruling
 * R-D15). R-D15 requires THREE distinguishable outcomes, not two, because
 * "we never recorded which version this ran against" and "the version it
 * ran against has been deleted" are different facts about the same review,
 * and only the second explains why Version History has nothing to show:
 *
 *  1. `versionId` absent — never recorded (predates versioning, or the
 *     playbook never existed).
 *  2. `versionId` present, `version` resolved — the ordinary case.
 *  3. `versionId` present, `version` null — DELETED since (Task 3's cascade
 *     removes a deleted playbook's versions with it).
 *
 * Taking BOTH `versionId` and `version` — never deriving one from the
 * other's presence — means a caller cannot render a version claim without
 * having actually tried to resolve it: the defect R-D15 exists to close is
 * structurally unreachable through this component's props, not just
 * avoided by convention in whoever calls it.
 */
export function ReviewVersionLine({ versionId, version, onOpenHistory }: ReviewVersionLineProps) {
  if (versionId === undefined) {
    return (
      <span className="text-xs text-gray-500">
        Ran against a playbook version that is no longer recorded.
      </span>
    );
  }

  if (version === null) {
    return (
      <span className="text-xs text-amber-500">
        The version this review ran against has been deleted.
      </span>
    );
  }

  const label = `Ran against v${version.version}`;
  if (!onOpenHistory) {
    return <span className="text-xs text-gray-500">{label}</span>;
  }

  return (
    <button
      type="button"
      onClick={onOpenHistory}
      className="text-xs text-violet-300 hover:text-violet-200 underline underline-offset-2"
    >
      {label}
    </button>
  );
}
