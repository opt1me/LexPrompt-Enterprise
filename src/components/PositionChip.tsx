import React from 'react';
import type { PositionOutcome } from '../types';

const POSITION_CLASSES: Record<PositionOutcome, string> = {
  meets: 'text-outcome-meets border-outcome-meets',
  deviates: 'text-outcome-deviates border-outcome-deviates',
  unclear: 'text-outcome-unclear border-outcome-unclear',
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
 * Deliberately NOT styled to match `RiskChip`: R-G16 makes that the wrong
 * goal, because `outcome-deviates` shares a hue with `risk-high` and
 * `outcome-unclear` shares one with `risk-med` — colour alone cannot tell
 * a reader which question a chip is answering. The three chips are three
 * *shapes* instead: `RiskChip` is a filled dot with no border, `StateChip`
 * is an icon in a bordered fill, and this one is a label inside a
 * role-coloured border on a transparent fill.
 */
export function PositionChip({ outcome }: PositionChipProps) {
  if (!outcome) return null;
  return (
    <span className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border bg-transparent ${POSITION_CLASSES[outcome]}`}>
      {POSITION_LABEL[outcome]}
    </span>
  );
}
