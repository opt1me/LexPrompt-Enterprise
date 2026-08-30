import React from 'react';
import { FileWarning, Check } from 'lucide-react';
import type { NetPosition, TrailStep } from '../../types';
import { Modal } from '../../components/Modal';
import { NetPositionPanel } from './NetPositionPanel';
import { stepEffectText } from '@lexprompt/core';

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

/** The trail's three distinct node shapes (state checklist): an outline
 *  ring for the original document, a solid amber dot for a step that varies
 *  it, and a teal dot with a check for the terminal net position. Shape,
 *  not just hue, carries the distinction — the same reasoning as `RiskChip`
 *  vs `StateChip` vs `PositionChip` (R-G16). */
function TrailNode({ kind }: { kind: TrailStep['kind'] }) {
  if (kind === 'original') {
    return <span className="w-3 h-3 rounded-meter border-2 border-ink-4 bg-paper shrink-0" aria-hidden="true" />;
  }
  return <span className="w-3 h-3 rounded-meter bg-risk-med shrink-0" aria-hidden="true" />;
}

/** The third node form — the terminal net position, drawn here rather than
 *  inside `NetPositionPanel` itself, since that component is also rendered
 *  with no trail at all (directly on `FindingCard`) and must not always
 *  carry a node it has nowhere sensible to put. */
function NetNode() {
  return (
    <span className="w-3 h-3 rounded-meter bg-accent text-page flex items-center justify-center shrink-0" aria-hidden="true">
      <Check className="w-2 h-2" strokeWidth={3} />
    </span>
  );
}

function TrailStepCard({ step, info, index, isLast }: {
  step: TrailStep; info: TrailDocumentInfo | undefined; index: number; isLast: boolean;
}) {
  const date = formatDate(info?.documentDate);
  const hasEffect = step.effect.trim() !== '';
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <TrailNode kind={step.kind} />
        {/* The connector between nodes — omitted after the last step card,
           since the terminal net position card supplies its own shell. */}
        {!isLast && <span className="w-px flex-1 bg-rule mt-1" aria-hidden="true" />}
      </div>
      <div className="rounded-control border border-rule bg-card p-3 space-y-1.5 mb-3 flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-mono text-label uppercase text-ink-4">
            {index + 1}. {step.kind === 'original' ? 'Original' : 'Varies'}
          </span>
          {info ? (
            <span className="font-ui text-meta text-ink-3">
              {info.name}{date ? ` · ${date}` : ''}
            </span>
          ) : (
            <span className="font-ui text-meta text-risk-high inline-flex items-center gap-1">
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
        <p className={`font-ui text-ui-sm leading-relaxed ${hasEffect ? 'text-ink-2' : 'text-risk-med'}`}>
          {stepEffectText(step)}
        </p>

        {step.citations.length > 0 && (
          <ul className="space-y-1">
            {step.citations.map((citation, i) => (
              <li key={i} className="font-prose text-quote text-ink-quote italic leading-relaxed">
                &ldquo;{citation.quote}&rdquo;
              </li>
            ))}
          </ul>
        )}
      </div>
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
      <div>
        {netPosition.trail.map((step, i) => (
          <TrailStepCard
            key={`${step.documentId}-${i}`}
            step={step}
            info={documents[step.documentId]}
            index={i}
            isLast={i === netPosition.trail.length - 1}
          />
        ))}
        <div className="flex gap-3">
          <div className="flex flex-col items-center pt-0.5">
            <NetNode />
          </div>
          <div className="flex-1 min-w-0">
            <NetPositionPanel netPosition={netPosition} busy={busy} onConfirm={onConfirm} onAmend={onAmend} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
