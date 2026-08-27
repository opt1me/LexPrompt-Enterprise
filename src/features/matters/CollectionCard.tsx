import React, { useState } from 'react';
import { Layers, AlertTriangle, Wrench, Play, Ungroup as UngroupIcon, Loader } from 'lucide-react';
import type { Collection, DocumentRecord, ReviewTarget } from '../../types';
import { orderedMembers } from '../../lib/collectionOrder';
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
    <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-violet-400 shrink-0" />
          <p className="text-sm font-semibold text-white truncate">{collection.name}</p>
          {broken && (
            <span className="text-[10px] px-2 py-0.5 rounded-full uppercase font-bold border inline-flex items-center gap-1 bg-red-500/15 text-red-300 border-red-500/20 shrink-0">
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
        <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-3 space-y-2">
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            This collection's base document is missing. It cannot be reviewed until you choose a new
            base from its remaining documents, or ungroup it.
          </p>
          {repairCandidates.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-gray-500 uppercase font-semibold tracking-wider flex items-center gap-1">
                <Wrench className="w-3 h-3" /> Repair — choose a new base
              </p>
              <div className="flex flex-wrap gap-2">
                {repairCandidates.map(m => (
                  <button
                    key={m.documentId}
                    onClick={() => handleRepair(m.documentId)}
                    disabled={busy}
                    className="text-xs px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white transition-colors disabled:opacity-50"
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
          <li key={m.documentId} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider shrink-0 ${
                m.kind === 'original' ? 'bg-violet-600/20 text-violet-300' : 'bg-white/10 text-gray-300'
              }`}
            >
              {m.kind === 'original' ? 'Base' : 'Varies'}
            </span>
            {m.document ? (
              <span className="text-sm text-white truncate">{m.document.name}</span>
            ) : (
              <span className="text-sm text-red-400 flex items-center gap-1.5">
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
