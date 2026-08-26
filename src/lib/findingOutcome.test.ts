import { describe, it, expect } from 'vitest';
import { describeFindingOutcome } from './findingOutcome';
import type { Finding } from '../types';

describe('describeFindingOutcome', () => {
  it('returns the summary for a done finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', summary: 'Auto-renews annually.', citations: [] };
    expect(describeFindingOutcome(finding)).toBe('Auto-renews annually.');
  });

  it('returns an empty string for a done finding with no summary, not "undefined"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'done', citations: [] };
    expect(describeFindingOutcome(finding)).toBe('');
  });

  it('reports a missing finding as "not yet reviewed"', () => {
    expect(describeFindingOutcome(undefined)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a pending finding as "not yet reviewed"', () => {
    const finding: Finding = { clauseId: 'c1', status: 'pending', citations: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: not yet reviewed');
  });

  it('reports a running finding honestly rather than as empty', () => {
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [] };
    expect(describeFindingOutcome(finding)).toMatch(/could not be reviewed/);
  });

  it('includes the error message for an errored finding', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [], error: 'timed out' };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: timed out');
  });

  it('falls back to "unknown error" for an errored finding with no message', () => {
    const finding: Finding = { clauseId: 'c1', status: 'error', citations: [] };
    expect(describeFindingOutcome(finding)).toBe('This clause could not be reviewed: unknown error');
  });

  it('reports a cancelled finding distinctly from an error', () => {
    const finding: Finding = { clauseId: 'c1', status: 'cancelled', citations: [] };
    expect(describeFindingOutcome(finding)).toBe(
      'This clause could not be reviewed: the run was cancelled before this clause was reviewed',
    );
  });
});
