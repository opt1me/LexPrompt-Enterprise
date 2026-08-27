import { describe, it, expect } from 'vitest';
import {
  describeFindingOutcome, verificationLabel, verificationCounts, exportSummaryLine, noteLines, isVerifiable,
  netPositionLabel, netPositionAmendmentLabel, trailLines,
} from './findingOutcome';
import { unconfirmedPosition, confirmPosition, amendPosition } from './netPosition';
import type { Finding, TrailStep, Verification } from '../types';

// Minor 3 (final fix round): `isVerifiable` replaces what used to be two
// independent `status === 'done'` checks — `FindingCard`'s render and
// `ResultsView`'s keyboard-shortcut gate. This file tests the rule directly;
// `FindingCard.test.tsx` and `ResultsView.test.tsx` cover each consumer.
describe('isVerifiable', () => {
  it('is true for a done finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(isVerifiable(finding)).toBe(true);
  });

  it.each(['pending', 'running', 'error', 'cancelled'] as const)('is false for a %s finding', (status) => {
    const finding: Finding = { clauseId: 'c1', status, citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(isVerifiable(finding)).toBe(false);
  });

  it('is false for a missing finding', () => {
    expect(isVerifiable(undefined)).toBe(false);
  });
});

describe('describeFindingOutcome', () => {
  it('returns the summary for a done finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', summary: 'Auto-renews annually.', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('Auto-renews annually.');
  });

  it('returns an empty string for a done finding with no summary, not "undefined"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('');
  });

  it('reports a missing finding as "not yet reviewed"', () => {
    expect(describeFindingOutcome(undefined)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a pending finding as "not yet reviewed"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a running finding honestly rather than as empty', () => {
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toMatch(/could not be reviewed/);
  });

  it('includes the error message for an errored finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [], error: 'timed out', verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: timed out');
  });

  it('falls back to "unknown error" for an errored finding with no message', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: unknown error');
  });

  it('reports a cancelled finding distinctly from an error', () => {
    const finding: Finding = { clauseId: 'c1', status: 'cancelled', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(describeFindingOutcome(finding)).toBe(
      'This clause could not be reviewed: the run was cancelled before this clause was reviewed',
    );
  });
});

function finding(state: Verification['state'], reason?: string): Finding {
  return {
    clauseId: 'c', status: 'done', summary: 's', citations: [], notes: [],
    verification: reason ? { state, reason } : { state },
  } as Finding;
}

describe('verificationLabel', () => {
  it('labels an unchecked finding as unverified AI output', () => {
    expect(verificationLabel(finding('unchecked'))).toBe('UNVERIFIED AI OUTPUT');
  });

  it('labels a flagged finding', () => {
    expect(verificationLabel(finding('flagged'))).toBe('FLAGGED');
  });

  it('carries the reason on a rejected finding', () => {
    expect(verificationLabel(finding('rejected', 'Wrong clause'))).toBe('REJECTED: Wrong clause');
  });

  it('returns null for a verified finding — a label there would be noise', () => {
    expect(verificationLabel(finding('verified'))).toBeNull();
  });

  it('labels a missing finding as unverified rather than saying nothing', () => {
    expect(verificationLabel(undefined)).toBe('UNVERIFIED AI OUTPUT');
  });

  it('never returns an empty string for a rejection with no readable reason', () => {
    const f = { ...finding('rejected'), verification: { state: 'rejected' as const } };
    expect(verificationLabel(f)).toBe('REJECTED: no reason recorded');
  });
});

describe('noteLines (Important 3 — spec section 6: "a flagged finding carries its flag and any note")', () => {
  it('returns nothing for a finding with no notes', () => {
    expect(noteLines(finding('flagged'))).toEqual([]);
  });

  it('returns nothing for a missing finding', () => {
    expect(noteLines(undefined)).toEqual([]);
  });

  it('formats one note, attributed to who wrote it', () => {
    const f: Finding = {
      ...finding('flagged'),
      notes: [{ id: 'n1', findingId: 'x', text: 'Check this against the side letter.', byUserId: 'u1', at: 1 }],
    };
    expect(noteLines(f)).toEqual(['Note: Check this against the side letter.']);
  });

  it('formats every note on a finding, not just the first', () => {
    const f: Finding = {
      ...finding('flagged'),
      notes: [
        { id: 'n1', findingId: 'x', text: 'First note.', byUserId: 'u1', at: 1 },
        { id: 'n2', findingId: 'x', text: 'Second note.', byUserId: 'u1', at: 2 },
      ],
    };
    expect(noteLines(f)).toEqual([
      'Note: First note.',
      'Note: Second note.',
    ]);
  });

  it('is not limited to flagged findings — a note on a verified finding still carries', () => {
    const f: Finding = {
      ...finding('verified'),
      notes: [{ id: 'n1', findingId: 'x', text: 'Confirmed against the executed copy.', byUserId: 'u1', at: 1 }],
    };
    expect(noteLines(f)).toEqual(['Note: Confirmed against the executed copy.']);
  });
});

describe('verificationCounts and exportSummaryLine', () => {
  const findings = {
    'doc-1': {
      a: finding('verified'), b: finding('unchecked'),
      c: finding('flagged'), d: finding('rejected', 'no'),
    },
    'doc-2': { a: finding('verified'), b: finding('unchecked') },
  };

  it('counts every finding across every document', () => {
    expect(verificationCounts(findings)).toEqual({
      total: 6, verified: 2, unchecked: 2, flagged: 1, rejected: 1,
    });
  });

  it('summarises in one line naming how many were verified', () => {
    expect(exportSummaryLine(findings)).toBe(
      '6 findings: 2 verified, 2 unverified, 1 flagged, 1 rejected.',
    );
  });

  it('handles an empty review without dividing by zero or saying nothing', () => {
    expect(exportSummaryLine({})).toBe('0 findings: 0 verified, 0 unverified, 0 flagged, 0 rejected.');
  });
});

const trail: TrailStep[] = [
  { documentId: 'lease', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
  { documentId: 'deed', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [{ quote: 'reduced to six months', documentId: 'deed' }] },
];

function collectionFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'break', status: 'done', citations: [],
    verification: { state: 'unchecked' }, notes: [],
    netPosition: unconfirmedPosition('Break on 6 months notice.', trail),
    ...overrides,
  };
}

// The three cases below are deliberately distinct, and each is asserted
// against a genuinely different input — an unconfirmed net position, a
// CONFIRMED one, and a finding with no net position at all — so a broken
// implementation that collapsed "confirmed" and "no position" into the same
// `null` (technically satisfying two of the three assertions) would still be
// caught: this app must never let a synthesis nobody has read export as
// though a human had already stood behind it, and must never claim a
// question arose that never did.
describe('netPositionLabel', () => {
  it('labels an unconfirmed net position, distinctly from a settled one', () => {
    const f = collectionFinding();
    expect(netPositionLabel(f)).toBe('UNCONFIRMED NET POSITION');
  });

  it('returns null for a confirmed net position — a label there would contradict the human sign-off', () => {
    const pos = confirmPosition(unconfirmedPosition('Break on 6 months notice.', trail), 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionLabel(f)).toBeNull();
  });

  it('returns null when there is no net position at all — "no position" is not "confirmed"', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(netPositionLabel(f)).toBeNull();
    expect('netPosition' in f).toBe(false);
  });

  it('returns null for a missing finding — there is no question of a net position to raise', () => {
    expect(netPositionLabel(undefined)).toBeNull();
  });
});

describe('netPositionAmendmentLabel', () => {
  it('says a human wrote the text for an amended position', () => {
    const pos = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionAmendmentLabel(f)).toMatch(/amend/i);
    expect(netPositionAmendmentLabel(f)).toMatch(/person/i);
  });

  it('does not say a person wrote it for a merely confirmed (unamended) position', () => {
    const pos = confirmPosition(unconfirmedPosition('model text', trail), 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(netPositionAmendmentLabel(f)).toBeNull();
  });

  it('does not say a person wrote it for an unconfirmed position', () => {
    expect(netPositionAmendmentLabel(collectionFinding())).toBeNull();
  });

  it('returns null for a finding with no net position at all', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(netPositionAmendmentLabel(f)).toBeNull();
  });
});

describe('trailLines — the derivation behind a net position', () => {
  it('emits one line per contributing document, naming the document and its effect', () => {
    const lines = trailLines(collectionFinding());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('lease');
    expect(lines[0]).toContain('Break on 12 months notice.');
    expect(lines[1]).toContain('deed');
    expect(lines[1]).toContain('Notice cut to 6 months.');
  });

  it('distinguishes the original document from a varying one', () => {
    const lines = trailLines(collectionFinding());
    expect(lines[0]).toMatch(/original/i);
    expect(lines[1]).toMatch(/varies/i);
  });

  it('returns nothing for a finding with no net position', () => {
    const f: Finding = { clauseId: 'c', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] };
    expect(trailLines(f)).toEqual([]);
  });

  it('returns nothing for a missing finding', () => {
    expect(trailLines(undefined)).toEqual([]);
  });
});

describe('describeFindingOutcome — a collection finding\'s net position', () => {
  // A collection finding (`extractCollectionClause`) never sets `summary` —
  // only `netPosition`. Before this, a done collection finding's outcome was
  // `finding.summary ?? ''`, i.e. always the empty string: exactly the
  // founding defect (an empty cell reading as "checked, nothing found") for
  // every collection review, independent of the Step 0 key bug.
  it('uses the proposed net position text when there is no summary', () => {
    const f = collectionFinding();
    expect(describeFindingOutcome(f)).toBe('Break on 6 months notice.');
  });

  it('prefers the human amendment over the model\'s proposal', () => {
    const pos = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 1);
    const f = collectionFinding({ netPosition: pos });
    expect(describeFindingOutcome(f)).toBe('human text');
  });

  it('still prefers an explicit summary when both are somehow present', () => {
    const f = collectionFinding({ summary: 'Explicit summary.' });
    expect(describeFindingOutcome(f)).toBe('Explicit summary.');
  });
});
