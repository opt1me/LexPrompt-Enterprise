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
 *
 * Sub-project G restyle: `KIND_BADGE_CLASS` maps straight onto the token
 * system's own examples — `confirm` (a position held again) is ACCENT, the
 * same teal `health-held` uses for exactly this fact; `drift` is risk-med,
 * the same amber a conceded position wears; `new_clause` is `draft` blue,
 * which §6.3's role table names "new clause" under explicitly. `ITEM_ACCENT`
 * gives each item card a left accent that tracks its decision — accepted
 * and reworded (the two decisions that actually reach the published
 * version) get the same accent bar; declined gets a neutral one — so a
 * scan down the list shows what will and won't survive publish without
 * reading every decision line (state checklist: "declined and open items
 * stay visibly not-publishable").
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
  confirm: 'bg-accent-tint border-accent-edge text-accent',
  drift: 'bg-risk-med-tint border-risk-med-edge text-risk-med',
  new_clause: 'bg-draft-tint border-draft text-draft',
};

/** Which decisions actually reach a publish (`accepted`, `reworded`) versus
 *  which do not (`open`, `declined`) — the left-accent bar on each item card
 *  reads off this, not off the decision string directly, so the mapping
 *  can't drift between "what colour is this" and "will this be in v{N+1}." */
const ITEM_ACCENT: Record<ChangesetItem['decision'], string> = {
  open: '',
  accepted: 'border-l-2 border-l-accent',
  reworded: 'border-l-2 border-l-accent',
  declined: 'border-l-2 border-l-rule-strong',
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
    <div className="p-6 max-w-4xl mx-auto space-y-6 bg-paper">
      <header className="space-y-2">
        <p className="font-mono text-label uppercase text-ink-4">
          v{fromVersion.version} &rarr; v{fromVersion.version + 1} proposed
        </p>
        <h2 className="font-prose text-section text-ink-1">{changeset.sourceSummary}</h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-ui text-meta text-ink-3">
          <span>{kinds.confirm} confirm</span>
          <span>{kinds.drift} drift</span>
          <span>{kinds.new_clause} new</span>
        </div>
      </header>

      <div className="bg-draft-tint border border-draft rounded-panel p-4">
        <p className="font-ui text-ui text-ink-1">
          Nothing changes in the live version until you publish. Review every item below, then publish to create
          the next version from only what you accept.
        </p>
      </div>

      {published ? (
        <div className="bg-accent-tint border border-accent-edge rounded-panel p-4">
          <p className="font-ui text-ui text-accent">
            {publishedVersion
              ? `Published as v${publishedVersion.version} — the live version now reflects the accepted and reworded items.`
              : 'Published — the live version now reflects the accepted and reworded items.'}
          </p>
        </div>
      ) : changeset.items.length === 0 ? (
        <p className="font-ui text-ui text-ink-3 italic">This deal raised nothing to review against the playbook.</p>
      ) : (
        <div className="space-y-3">
          {changeset.items.map((item) => (
            <ChangesetItemCard key={item.id} item={item} onDecide={onDecide} />
          ))}
        </div>
      )}

      {!published && (
        <div className="border-t border-rule pt-4 space-y-2">
          <p className="font-ui text-meta text-ink-3">
            {counts.accepted} accepted &middot; {counts.reworded} reworded &middot; {counts.declined} declined
            {counts.open > 0 ? ` · ${counts.open} still open` : ''}
          </p>
          {publishError && <p className="font-ui text-ui text-risk-high">{publishError}</p>}
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
    <div className={`border border-rule rounded-card p-4 bg-card space-y-3 ${ITEM_ACCENT[item.decision]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-label uppercase text-ink-4">{title}</p>
          <p className="font-ui text-meta text-ink-3 mt-1">{item.rationale}</p>
        </div>
        <span
          className={`shrink-0 font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border whitespace-nowrap ${KIND_BADGE_CLASS[item.kind]}`}
        >
          {KIND_BADGE_LABEL[item.kind]}
        </span>
      </div>

      {item.kind === 'drift' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="font-mono text-label uppercase text-ink-4 mb-1">Current</p>
            <p className="font-prose text-finding text-ink-2 bg-paper border border-rule rounded-inset p-2">
              {item.currentText ?? '(no standing position yet)'}
            </p>
          </div>
          <div>
            <p className="font-mono text-label uppercase text-ink-4 mb-1">Proposed</p>
            <p className="font-prose text-finding text-ink-prose bg-paper border border-rule rounded-inset p-2">{item.proposedText}</p>
          </div>
        </div>
      ) : item.kind === 'confirm' ? (
        <p className="font-prose text-finding text-ink-prose bg-paper border border-rule rounded-inset p-2">Held again: {item.proposedText}</p>
      ) : (
        <p className="font-prose text-finding text-ink-prose bg-paper border border-rule rounded-inset p-2">{item.proposedText}</p>
      )}

      {item.decision !== 'open' && (
        <p className="font-ui text-meta text-ink-3">
          Decision:{' '}
          <span
            className={`font-semibold ${item.decision === 'declined' ? 'text-ink-3 line-through' : 'text-accent'}`}
          >
            {item.decision}
          </span>
          {item.decision === 'reworded' && item.rewordedText ? ` — "${item.rewordedText}"` : ''}
        </p>
      )}

      {rewording ? (
        <div className="space-y-2">
          <textarea
            aria-label={`Reworded text for ${title}`}
            value={rewordText}
            onChange={(e) => setRewordText(e.target.value)}
            className="w-full bg-paper border border-rule rounded-control p-2 text-xs text-ink-1 outline-none focus:border-accent min-h-[60px]"
          />
          <div className="flex gap-2">
            <Button onClick={handleSaveReword}>Save reword</Button>
            <Button variant="ghost" onClick={() => setRewording(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-rule">
          <Button onClick={() => onDecide(item, 'accepted')}>Accept</Button>
          <Button variant="ghost" onClick={() => setRewording(true)}>Reword</Button>
          <Button variant="danger" onClick={() => onDecide(item, 'declined')}>Decline</Button>
        </div>
      )}
    </div>
  );
}
