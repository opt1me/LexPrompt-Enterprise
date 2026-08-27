import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { PositionComparison } from './PositionComparison';
import type { Finding, StandardPosition } from '../../types';

// No text()/html() helper exists anywhere in this project; these are local
// wrappers around the shared `mount`, same pattern other test files use for
// their own small helpers.
function text(node: React.ReactElement): string {
  return mount(node).textContent || '';
}

const pos: StandardPosition = {
  text: 'a 6-month break notice, no conditions.',
  origin: 'authored',
  reviewedByHuman: true,
};

const deviatingFinding: Finding = {
  clauseId: 'c1',
  status: 'done',
  summary: 'The lease gives 9 months.',
  citations: [],
  verification: { state: 'unchecked' },
  notes: [],
  positionOutcome: 'deviates',
  positionRationale: 'Nine months, not six.',
};

describe('PositionComparison', () => {
  it('shows we-ask-for against what the document says', () => {
    const out = text(<PositionComparison position={pos} finding={deviatingFinding} />);
    expect(out).toContain('We ask for');
    expect(out).toContain('We ask for a 6-month break notice, no conditions.');
    expect(out).toContain('This document says');
    expect(out).toContain('The lease gives 9 months.');
  });

  it('shows the rationale', () => {
    const out = text(<PositionComparison position={pos} finding={deviatingFinding} />);
    expect(out).toContain('Nine months, not six.');
  });

  it('says a position is only a suggestion when no human has reviewed it', () => {
    const unreviewed: StandardPosition = { ...pos, origin: 'ai-drafted', reviewedByHuman: false };
    const out = text(<PositionComparison position={unreviewed} finding={deviatingFinding} />);
    // An AI-drafted position nobody has read is not the firm's position.
    expect(out).toMatch(/not (yet )?reviewed|suggestion/i);
  });
});
