import React from 'react';
import type { RiskLevel } from '../types';

const RISK_CLASSES: Record<RiskLevel, string> = {
  High: 'bg-red-500/20 text-red-400',
  Medium: 'bg-yellow-500/20 text-yellow-400',
  Low: 'bg-green-500/20 text-green-400',
  Info: 'bg-blue-500/20 text-blue-400',
};

export function RiskBadge({ level }: { level: RiskLevel | undefined }) {
  if (!level) return null;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${RISK_CLASSES[level]}`}>
      {level}
    </span>
  );
}
