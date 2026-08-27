import React from 'react';
import { FileWarning } from 'lucide-react';
import type { NetPosition, TrailStep } from '../../types';
import { Modal } from '../../components/Modal';
import { NetPositionPanel } from './NetPositionPanel';
import { stepEffectText } from '../../lib/netPosition';

/** What the trail needs to know about a contributing document, keyed by its
 *  id — nothing else in this app needs a lookup shaped quite like this, so
 *  it lives here rather than being forced into `EvidenceList`'s
 *  name-only `documentNames`. `documentDate` is the same field
 *  `DocumentRecord` carries; omitted (not guessed) when it isn't known,
 *  exactly as `DocumentRecord.documentDate` itself is. */
export interface TrailDocumentInfo {
  name: string;
  documentDate?: number;
}

export interface VariationTrailModalProps {
  open: boolean;
  onClose: () => void;
  netPosition: NetPosition;
  /** documentId to what's known about it. A step whose id has no entry here
   *  renders as unavailable rather than being skipped — a missing amendment
   *  is exactly the case a net position must not silently absorb. */
  documents: Record<string, TrailDocumentInfo>;
  busy?: boolean;
  onConfirm?: () => void;
  onAmend?: (text: string) => void;
}

function formatDate(at: number | undefined): string | null {
  return typeof at === 'number' ? new Date(at).toLocaleDateString() : null;
}

function TrailStepCard({ step, info, index }: { step: TrailStep; info: TrailDocumentInfo | undefined; index: number }) {
  const date = formatDate(info?.documentDate);
  const hasEffect = step.effect.trim() !== '';
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {index + 1}. {step.kind === 'original' ? 'Original' : 'Varies'}
        </span>
        {info ? (
          <span className="text-[11px] text-gray-300">
            {info.name}{date ? ` · ${date}` : ''}
          </span>
        ) : (
          <span className="text-[11px] text-red-300 inline-flex items-center gap-1">
            <FileWarning className="w-3 h-3" aria-hidden="true" /> Document unavailable
          </span>
        )}
      </div>

      {/* Never `{step.effect}` raw. A blank effect renders as an empty line
          under a correct document name and date, which reads as "considered,
          does nothing" — an empty result presented as a checked one, inside
          the derivation that exists to make the position checkable.
          `stepEffectText` states the absence instead, and is shared with
          `trailLines` so the exports say the same thing. */}
      <p className={`text-xs leading-relaxed ${hasEffect ? 'text-gray-300' : 'text-yellow-300'}`}>
        {stepEffectText(step)}
      </p>

      {step.citations.length > 0 && (
        <ul className="space-y-1">
          {step.citations.map((citation, i) => (
            <li key={i} className="text-[11px] text-gray-500 italic leading-relaxed">
              &ldquo;{citation.quote}&rdquo;
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The argument for a net position: one card per contributing document, in
 * reading order (`netPosition.trail` is already ordered — see
 * `extractCollectionClause`), followed by the conclusion itself. A
 * conclusion shown without this is an assertion; this is what makes it a
 * derivation a reader can check.
 *
 * The terminal card reuses `NetPositionPanel` wholesale rather than a second
 * copy of its badge/Confirm/Amend markup — `onOpenTrail` is simply not
 * passed, so its own "see trail" control has nothing to reopen.
 */
export function VariationTrailModal({ open, onClose, netPosition, documents, busy = false, onConfirm, onAmend }: VariationTrailModalProps) {
  return (
    <Modal isOpen={open} onClose={onClose} title="Variation trail" size="lg">
      <div className="space-y-3">
        {netPosition.trail.map((step, i) => (
          <TrailStepCard key={`${step.documentId}-${i}`} step={step} info={documents[step.documentId]} index={i} />
        ))}
        <NetPositionPanel netPosition={netPosition} busy={busy} onConfirm={onConfirm} onAmend={onAmend} />
      </div>
    </Modal>
  );
}
