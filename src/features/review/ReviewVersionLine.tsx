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
   *  `null` means the lookup ran, SUCCEEDED, and found nothing (R-D15's
   *  dangling case: the id is present but the version it named has been
   *  deleted). It must never be derived from `versionId`'s mere presence —
   *  that is exactly the confident-wrong-answer shape this component exists
   *  to close off, which is why this prop is required rather than
   *  defaulting to `null`. A lookup that never ran to completion at all
   *  (threw) is a DIFFERENT fact than "ran and found nothing" and must not
   *  be reported here — see `lookupFailed`. */
  version: PlaybookVersion | null;
  /** True when the attempt to resolve `versionId` itself threw — a DB read
   *  failure, not a successful lookup that found the version gone. This is
   *  the third outcome R-D15's caller can land in, and it must be
   *  distinguishable from both `version === null` (deleted: the lookup
   *  succeeded and PROVED the version is gone — a specific claim this
   *  component has no evidence for when the read itself failed) and from
   *  omitting this line entirely (which reads as "nothing to report," the
   *  same confident-silence shape CLAUDE.md's "fail loudly" rule exists to
   *  close). A caller that could not even attempt the lookup, or whose
   *  attempt is still in flight, passes `false`/omits this — that is a
   *  genuinely different, and genuinely quiet, case: there is nothing wrong
   *  to report yet. Ignored when `versionId` is absent. */
  lookupFailed?: boolean;
  /** Opens Version History for the playbook this review ran against.
   *  Omitted, the resolved case renders as plain text with nothing to
   *  click — there is no live destination to send the reader to until a
   *  caller supplies one. */
  onOpenHistory?: () => void;
}

/**
 * The review header's "ran against vN" line (spec §8 / DoD #6, ruling
 * R-D15). R-D15 requires at least THREE distinguishable outcomes, not two,
 * because "we never recorded which version this ran against" and "the
 * version it ran against has been deleted" are different facts about the
 * same review, and only the second explains why Version History has nothing
 * to show. A fourth was added after a browser check found the resolution
 * itself failing silently: "the lookup found nothing" and "the lookup could
 * not run at all" are also different facts, and collapsing the second into
 * either of the first two is either a false claim ("deleted") or a
 * confident-looking silence (no line at all) — CLAUDE.md's "fail loudly"
 * rule applies here exactly as much as it does to a document the app failed
 * to parse.
 *
 *  1. `versionId` absent — never recorded (predates versioning, or the
 *     playbook never existed).
 *  2. `versionId` present, `lookupFailed` — the resolution attempt itself
 *     threw; nothing is known about whether the version still exists.
 *  3. `versionId` present, `version` resolved — the ordinary case.
 *  4. `versionId` present, `version` null, not `lookupFailed` — DELETED
 *     since (Task 3's cascade removes a deleted playbook's versions with
 *     it).
 *
 * Taking `versionId`, `version`, AND `lookupFailed` — never deriving one
 * from another's presence — means a caller cannot render a version claim
 * without having actually tried to resolve it: the defect R-D15 exists to
 * close is structurally unreachable through this component's props, not
 * just avoided by convention in whoever calls it.
 */
export function ReviewVersionLine({ versionId, version, lookupFailed, onOpenHistory }: ReviewVersionLineProps) {
  if (versionId === undefined) {
    // m4 (final honesty review): "no longer recorded" asserts a recording
    // that was later lost, which is a different and more alarming claim
    // than the truth — this branch means one was NEVER made (pre-versioning
    // data, or a playbook that never existed), per this prop's own doc
    // comment above.
    return (
      <span className="text-xs text-gray-500">
        This review predates playbook versioning, so it does not record which version it ran against.
      </span>
    );
  }

  if (lookupFailed) {
    return (
      <span className="text-xs text-amber-500">
        Could not check which playbook version this review ran against. Try reloading.
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
