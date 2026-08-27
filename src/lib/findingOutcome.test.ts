import { describe, it, expect } from 'vitest';
import { describeFindingOutcome, verificationLabel, verificationCounts, exportSummaryLine, noteLines } from './findingOutcome';
import type { Finding, Verification } from '../types';

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
    expect(noteLines(f)).toEqual(['Note (u1): Check this against the side letter.']);
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
      'Note (u1): First note.',
      'Note (u1): Second note.',
    ]);
  });

  it('is not limited to flagged findings — a note on a verified finding still carries', () => {
    const f: Finding = {
      ...finding('verified'),
      notes: [{ id: 'n1', findingId: 'x', text: 'Confirmed against the executed copy.', byUserId: 'u1', at: 1 }],
    };
    expect(noteLines(f)).toEqual(['Note (u1): Confirmed against the executed copy.']);
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
