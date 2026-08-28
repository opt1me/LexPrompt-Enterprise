import React from 'react';
import type { RiskLevel } from '../types';

const RISK_CLASSES: Record<RiskLevel, string> = {
  High: 'text-risk-high',
  Medium: 'text-risk-med',
  Low: 'text-risk-low',
  Info: 'text-draft',
};

const RISK_DOT: Record<RiskLevel, string> = {
  High: 'bg-risk-high',
  Medium: 'bg-risk-med',
  Low: 'bg-risk-low',
  Info: 'bg-draft',
};

/** The risk level the *model* assigned. Its counterpart is `StateChip`,
 *  which shows what a *human* concluded. They are deliberately two
 *  components and must never be merged into one badge: a High-risk finding
 *  nobody has checked and a High-risk finding a lawyer has verified are
 *  different things, and a single badge cannot say which is which. */
export function RiskChip({ level }: { level: RiskLevel | undefined }) {
  if (!level) return null;
  return (
    <span className={`font-mono text-chip uppercase inline-flex items-center gap-1.5 ${RISK_CLASSES[level]}`}>
      <span className={`w-1.5 h-1.5 rounded-meter ${RISK_DOT[level]}`} aria-hidden="true" />
      {level}
    </span>
  );
}
