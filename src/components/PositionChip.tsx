import React from 'react';
import type { PositionOutcome } from '../types';

const POSITION_CLASSES: Record<PositionOutcome, string> = {
  meets: 'bg-emerald-500/20 text-emerald-400',
  deviates: 'bg-red-500/20 text-red-400',
  unclear: 'bg-yellow-500/20 text-yellow-400',
};

const POSITION_LABEL: Record<PositionOutcome, string> = {
  meets: 'Meets',
  deviates: 'Deviates',
  unclear: 'Unclear',
};

export interface PositionChipProps {
  /** Absent renders nothing at all — "no position to compare against" is not
   *  a question, so it gets no chip. */
  outcome?: PositionOutcome;
}

/**
 * Whether this finding matches the firm's own standard position for the
 * clause — a third, independent question from `StateChip` (has a human
 * checked the AI's answer?) and `RiskChip` (how risky is what it found?).
 * Spec §11: three chips, three questions, never merged. A finding can be
 * `verified`, `Medium` risk, and `deviates` from house position all at the
 * same time, and this chip must be able to sit beside the other two without
 * being confused for either.
 *
 * Styled to match `RiskChip` exactly (same sizing, same "flat badge of
 * colour" idiom) rather than inventing a third convention — the two already
 * read as siblings on the card header and this is their sibling, not a new
 * kind of thing.
 */
export function PositionChip({ outcome }: PositionChipProps) {
  if (!outcome) return null;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${POSITION_CLASSES[outcome]}`}>
      {POSITION_LABEL[outcome]}
    </span>
  );
}
