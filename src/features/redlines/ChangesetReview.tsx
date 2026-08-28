import React, { useState } from 'react';
import { Button } from '../../components/Button';
import type { ChangeKind, Changeset, ChangesetItem, PlaybookVersion } from '../../types';

/**
 * "The changeset" — spec §7. `WhatWeLearned`'s sibling: where that screen
 * triages standalone *positions*, this one triages a new deal's proposed
 * changes to a live playbook version, and both end at the same rule — a
 * house position is adopted only one item at a time, by a person.
 *
 * The rule this screen exists to protect (spec §7, §9; mutation-tested one
 * level down in `publishChangeset`): publishing must produce a new version
 * from ONLY the accepted and reworded items. This component never calls
 * `publishChangeset` itself — `onPublish` is the caller's job, exactly as
 * `WhatWeLearned` never calls a store function directly — but it says so on
 * screen, plainly, because someone triaging a long changeset needs to know
 * their decisions are not yet live: "Nothing changes in the live version
 * until you publish" appears unconditionally, not just once nothing has
 * been decided yet, since the honest reading of "not live" doesn't change
 * once a few items are.
 *
 * `itemTitle` reads `item.title` — set directly by `buildChangeset.ts`'s
 * `resolveItem` (`matched?.title ?? clauseTitle`) — falling back to
 * `item.basis[0]?.clauseRef` only for a changeset saved before that field
 * existed; an item is never kept with an empty basis, so the fallback is
 * always available for such a record. See `src/lib/db/changesets.ts`'s
 * `newClauseTitle` for the same read, used for the same reason on the
 * publish side.
 */

export interface ChangesetReviewProps {
  changeset: Changeset;
  /** The version this changeset was built against — used only for the
   *  "v{N} -> v{N+1} proposed" label (spec §7). Publishing itself numbers
   *  the new version independently, in `publishChangeset`. */
  fromVersion: PlaybookVersion;
  /** The version actually produced by publishing, once known — only for a
   *  more specific "Published as vN" message. Absent is fine; the plain
   *  "Published" message still tells the truth. */
  publishedVersion?: PlaybookVersion;
  onDecide: (item: ChangesetItem, decision: 'accepted' | 'reworded' | 'declined', rewordedText?: string) => void;
  onPublish: () => void;
  publishing?: boolean;
  publishError?: string;
}

function itemTitle(item: ChangesetItem): string {
  return item.title?.trim() || item.basis[0]?.clauseRef?.trim() || 'Untitled clause';
}

const KIND_BADGE_LABEL: Record<ChangeKind, string> = {
  confirm: 'confirm',
  drift: 'drift',
  new_clause: 'new',
};

const KIND_BADGE_CLASS: Record<ChangeKind, string> = {
  confirm: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  drift: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  new_clause: 'bg-sky-500/15 border-sky-500/30 text-sky-300',
};

interface DecisionCounts {
  open: number;
  accepted: number;
  reworded: number;
  declined: number;
}

/** Exported for the same reason `WhatWeLearned`'s `consistentPositions` is:
 *  a small, pure function is easier to pin with a direct test than the
 *  rendered text that depends on it. */
export function decisionCounts(items: ChangesetItem[]): DecisionCounts {
  return {
    open: items.filter((i) => i.decision === 'open').length,
    accepted: items.filter((i) => i.decision === 'accepted').length,
    reworded: items.filter((i) => i.decision === 'reworded').length,
    declined: items.filter((i) => i.decision === 'declined').length,
  };
}

function kindCounts(items: ChangesetItem[]): Record<ChangeKind, number> {
  return {
    confirm: items.filter((i) => i.kind === 'confirm').length,
    drift: items.filter((i) => i.kind === 'drift').length,
    new_clause: items.filter((i) => i.kind === 'new_clause').length,
  };
}

export function ChangesetReview({
  changeset,
  fromVersion,
  publishedVersion,
  onDecide,
  onPublish,
  publishing = false,
  publishError,
}: ChangesetReviewProps) {
  const counts = decisionCounts(changeset.items);
  const kinds = kindCounts(changeset.items);
  const published = Boolean(changeset.publishedVersionId);
  const canPublish = !published && !publishing && counts.open === 0 && changeset.items.length > 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 bg-[#09090b]">
      <header className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">
          v{fromVersion.version} &rarr; v{fromVersion.version + 1} proposed
        </p>
        <h2 className="text-lg font-bold text-white">{changeset.sourceSummary}</h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
          <span>{kinds.confirm} confirm</span>
          <span>{kinds.drift} drift</span>
          <span>{kinds.new_clause} new</span>
        </div>
      </header>

      <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg p-4">
        <p className="text-sm text-violet-200">
          Nothing changes in the live version until you publish. Review every item below, then publish to create
          the next version from only what you accept.
        </p>
      </div>

      {published ? (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
          <p className="text-sm text-emerald-200">
            {publishedVersion
              ? `Published as v${publishedVersion.version} — the live version now reflects the accepted and reworded items.`
              : 'Published — the live version now reflects the accepted and reworded items.'}
          </p>
        </div>
      ) : changeset.items.length === 0 ? (
        <p className="text-sm text-gray-400 italic">This deal raised nothing to review against the playbook.</p>
      ) : (
        <div className="space-y-3">
          {changeset.items.map((item) => (
            <ChangesetItemCard key={item.id} item={item} onDecide={onDecide} />
          ))}
        </div>
      )}

      {!published && (
        <div className="border-t border-white/10 pt-4 space-y-2">
          <p className="text-xs text-gray-500">
            {counts.accepted} accepted &middot; {counts.reworded} reworded &middot; {counts.declined} declined
            {counts.open > 0 ? ` · ${counts.open} still open` : ''}
          </p>
          {publishError && <p className="text-xs text-red-400">{publishError}</p>}
          <Button onClick={onPublish} disabled={!canPublish} loading={publishing}>
            {counts.open > 0
              ? `Decide ${counts.open} more item${counts.open === 1 ? '' : 's'} before publishing`
              : `Publish v${fromVersion.version + 1}`}
          </Button>
        </div>
      )}
    </div>
  );
}

interface ChangesetItemCardProps {
  item: ChangesetItem;
  onDecide: ChangesetReviewProps['onDecide'];
}

function ChangesetItemCard({ item, onDecide }: ChangesetItemCardProps) {
  const [rewording, setRewording] = useState(false);
  const [rewordText, setRewordText] = useState(item.rewordedText ?? item.proposedText);
  const title = itemTitle(item);

  const handleSaveReword = () => {
    onDecide(item, 'reworded', rewordText);
    setRewording(false);
  };

  return (
    <div className="border border-white/10 rounded-xl p-4 bg-white/5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{title}</p>
          <p className="text-xs text-gray-400 mt-1">{item.rationale}</p>
        </div>
        <span
          className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded border whitespace-nowrap ${KIND_BADGE_CLASS[item.kind]}`}
        >
          {KIND_BADGE_LABEL[item.kind]}
        </span>
      </div>

      {item.kind === 'drift' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-[10px] uppercase text-gray-500 mb-1">Current</p>
            <p className="text-sm text-gray-300 bg-black/20 rounded p-2">
              {item.currentText ?? '(no standing position yet)'}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-gray-500 mb-1">Proposed</p>
            <p className="text-sm text-gray-100 bg-black/20 rounded p-2">{item.proposedText}</p>
          </div>
        </div>
      ) : item.kind === 'confirm' ? (
        <p className="text-sm text-gray-100 bg-black/20 rounded p-2">Held again: {item.proposedText}</p>
      ) : (
        <p className="text-sm text-gray-100 bg-black/20 rounded p-2">{item.proposedText}</p>
      )}

      {item.decision !== 'open' && (
        <p className="text-[11px] text-gray-500">
          Decision: <span className="font-semibold text-gray-300">{item.decision}</span>
          {item.decision === 'reworded' && item.rewordedText ? ` — "${item.rewordedText}"` : ''}
        </p>
      )}

      {rewording ? (
        <div className="space-y-2">
          <textarea
            aria-label={`Reworded text for ${title}`}
            value={rewordText}
            onChange={(e) => setRewordText(e.target.value)}
            className="w-full bg-black/50 border border-white/10 rounded-lg p-2 text-xs text-gray-200 outline-none focus:border-violet-500 min-h-[60px]"
          />
          <div className="flex gap-2">
            <Button onClick={handleSaveReword}>Save reword</Button>
            <Button variant="ghost" onClick={() => setRewording(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-white/10">
          <Button onClick={() => onDecide(item, 'accepted')}>Accept</Button>
          <Button variant="ghost" onClick={() => setRewording(true)}>Reword</Button>
          <Button variant="ghost" onClick={() => onDecide(item, 'declined')}>Decline</Button>
        </div>
      )}
    </div>
  );
}
