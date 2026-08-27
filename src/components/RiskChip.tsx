import React from 'react';
import type { RiskLevel } from '../types';

const RISK_CLASSES: Record<RiskLevel, string> = {
  High: 'bg-red-500/20 text-red-400',
  Medium: 'bg-yellow-500/20 text-yellow-400',
  Low: 'bg-green-500/20 text-green-400',
  Info: 'bg-blue-500/20 text-blue-400',
};

/** The risk level the *model* assigned. Its counterpart is `StateChip`,
 *  which shows what a *human* concluded. They are deliberately two
 *  components and must never be merged into one badge: a High-risk finding
 *  nobody has checked and a High-risk finding a lawyer has verified are
 *  different things, and a single badge cannot say which is which. */
export function RiskChip({ level }: { level: RiskLevel | undefined }) {
  if (!level) return null;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${RISK_CLASSES[level]}`}>
      {level}
    </span>
  );
}
