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

  // The copy defect a browser check found: the editor's own placeholder for
  // this field used to model a complete sentence ("e.g. We ask for a
  // 6-month break notice…"), which taught an author to type the label's own
  // words into the field. The card then stuttered: "We ask for We ask for
  // a 6-month break notice, no conditions." `pos` above is already the
  // noun-phrase shape the (now-fixed) placeholder suggests — this pins that
  // the label is never duplicated even when a position starts with a
  // capitalised word, the shape a noun-phrase placeholder produces.
  it('does not stutter the label for a noun-phrase position, the shape the placeholder now suggests', () => {
    const nounPhrase: StandardPosition = {
      text: 'A 6-month break notice, no conditions.',
      origin: 'authored',
      reviewedByHuman: true,
    };
    const out = text(<PositionComparison position={nounPhrase} finding={deviatingFinding} />);
    expect(out).toContain('We ask for A 6-month break notice, no conditions.');
    expect(out).not.toMatch(/we ask for we ask for/i);
  });

  it('says a position is only a suggestion when no human has reviewed it', () => {
    const unreviewed: StandardPosition = { ...pos, origin: 'ai-drafted', reviewedByHuman: false };
    const out = text(<PositionComparison position={unreviewed} finding={deviatingFinding} />);
    // An AI-drafted position nobody has read is not the firm's position.
    expect(out).toMatch(/not (yet )?reviewed|suggestion/i);
  });
});
