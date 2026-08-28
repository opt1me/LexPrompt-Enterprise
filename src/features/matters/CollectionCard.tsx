import React, { useState } from 'react';
import { Layers, AlertTriangle, Wrench, Play, Ungroup as UngroupIcon, Loader } from 'lucide-react';
import type { Collection, DocumentRecord, ReviewTarget } from '../../types';
import { orderedMembers } from '../../lib/collectionOrder';
import { DocumentNotices } from './DocumentNotices';
import { Button } from '../../components/Button';

export interface CollectionCardProps {
  collection: Collection;
  /** The matter's full document list (standalone AND collection members) —
   *  `orderedMembers` needs the whole thing to tell "not loaded yet" apart
   *  from "genuinely gone". */
  documents: DocumentRecord[];
  onUngroup: (collectionId: string) => Promise<void>;
  /** Repairs a collection whose base is missing by promoting one of its
   *  surviving members to base. Never inferred or automatic — the spec's
   *  own words are "choose a new base, or ungroup"; this is the "choose"
   *  half, and it is always a human's explicit click on a named document. */
  onRepair: (collectionId: string, newBaseDocumentId: string) => Promise<void>;
  /** Builds the `ReviewTarget` and hands it up rather than running anything
   *  itself — `MatterHome` owns the playbook picker every run (standalone
   *  or collection) goes through. */
  onRunReview: (target: ReviewTarget) => void;
}

/**
 * One collection in the matter home's documents section: its name, its
 * members in reading order (base first, then amendments as stored — never
 * re-sorted by `documentDate`, ruling R-C3), `Ungroup`, and its own
 * `Run a review`.
 *
 * A member whose document has been deleted out from under the collection
 * renders as an explicit "Unavailable" row — `orderedMembers` already
 * reports it as `document: null` at its rightful position rather than
 * dropping it, and this component must not undo that by filtering the row
 * away. When the MISSING member is the base, the whole collection is
 * "broken" (spec §8): reviewing it would fail every clause against a
 * synthesis with nothing to vary, so `Run a review` is offered disabled
 * with the reason visible, and a repair action offers to promote a
 * surviving member to base instead of silently doing so.
 */
export function CollectionCard({ collection, documents, onUngroup, onRepair, onRunReview }: CollectionCardProps) {
  const [busy, setBusy] = useState(false);
  const members = orderedMembers(collection, documents);
  // `orderedMembers` always puts the base at position 1 (kind 'original') —
  // see its own doc comment on never promoting an amendment into that slot.
  const base = members[0];
  const broken = !base?.document;
  const repairCandidates = members.filter(m => m.kind === 'varies' && m.document);

  const handleUngroup = async () => {
    setBusy(true);
    try {
      await onUngroup(collection.id);
    } finally {
      setBusy(false);
    }
  };

  const handleRepair = async (newBaseDocumentId: string) => {
    setBusy(true);
    try {
      await onRepair(collection.id, newBaseDocumentId);
    } finally {
      setBusy(false);
    }
  };

  const handleRunReview = () => {
    onRunReview({
      kind: 'collection',
      collectionId: collection.id,
      documentIds: members.map(m => m.documentId),
    });
  };

  return (
    <div className="bg-card border border-rule rounded-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-accent shrink-0" />
          <p className="font-prose text-section text-ink-1 truncate">{collection.name}</p>
          {broken && (
            <span className="font-mono text-chip uppercase px-2 py-0.5 rounded-chip border inline-flex items-center gap-1 bg-risk-high-tint text-risk-high border-risk-high-edge shrink-0">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              Broken
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span title={broken ? "The base document is missing, so this collection can't be reviewed until it's repaired." : undefined}>
            <Button variant="ghost" onClick={handleRunReview} disabled={broken || busy}>
              <Play className="w-4 h-4" /> Run a review
            </Button>
          </span>
          <Button variant="ghost" onClick={handleUngroup} disabled={busy}>
            {busy ? <Loader className="w-4 h-4 animate-spin" /> : <UngroupIcon className="w-4 h-4" />}
            Ungroup
          </Button>
        </div>
      </div>

      {broken && (
        <div className="rounded-card border border-risk-high-edge bg-risk-high-tint p-3 space-y-2">
          <p className="text-sm text-risk-high flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            This collection's base document is missing. It cannot be reviewed until you choose a new
            base from its remaining documents, or ungroup it.
          </p>
          {repairCandidates.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-mono text-label text-ink-4 uppercase flex items-center gap-1">
                <Wrench className="w-3 h-3" /> Repair — choose a new base
              </p>
              <div className="flex flex-wrap gap-2">
                {repairCandidates.map(m => (
                  <button
                    key={m.documentId}
                    onClick={() => handleRepair(m.documentId)}
                    disabled={busy}
                    className="text-xs px-2.5 py-1.5 rounded-control bg-chip-fill hover:bg-rule-soft border border-rule text-ink-1 transition-colors disabled:opacity-50"
                  >
                    Make "{m.document!.name}" the base
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {members.map(m => (
          <li key={m.documentId} className="flex items-start gap-3 bg-chip-fill rounded-control px-3 py-2">
            <span
              className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border shrink-0 mt-0.5 ${
                m.kind === 'original'
                  ? 'bg-accent-tint text-accent border-accent-edge'
                  : 'bg-chip-fill text-ink-3 border-rule'
              }`}
            >
              {m.kind === 'original' ? 'Base' : 'Varies'}
            </span>
            {m.document ? (
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-1 truncate">{m.document.name}</p>
                {/* The same notices the standalone document list shows, for
                   the same reason: grouping a document into a collection
                   must not be the act that hides "this looks like a scan"
                   or "this parsed with every tracked change accepted".
                   `extractCollectionClause` still declines a member it
                   cannot read at run time, so the run stays safe either
                   way — what a silent row costs is the chance to know
                   BEFORE spending the tokens, which is the whole point of
                   saying it here (R-G13). */}
                <DocumentNotices doc={m.document} />
              </div>
            ) : (
              <span className="text-sm text-risk-high flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Unavailable — this document could not be found
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
