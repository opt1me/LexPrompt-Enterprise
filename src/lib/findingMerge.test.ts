import { describe, it, expect } from 'vitest';
import { carryHumanState } from './findingMerge';
import type { Finding, ReviewRun } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

function run(findings: ReviewRun['findings']): ReviewRun {
  return { id: 'r', templateSnapshot: { clauses: [] } as never, documentIds: ['d1'], findings, startedAt: 1 };
}

describe('carryHumanState', () => {
  it('keeps a verification when the status has not moved', () => {
    const before = run({ d1: { c1: finding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding() } }));
    expect(after.findings.d1.c1.verification.state).toBe('verified');
  });

  it('drops a verification when the status moved — the output it judged is gone', () => {
    const before = run({ d1: { c1: finding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ status: 'running' }) } }));
    expect(after.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
  });

  it('keeps notes even when the status moved', () => {
    const note = { id: 'n1', findingId: 'd1::c1', text: 'check the side letter', byUserId: 'u', at: 2 };
    const before = run({ d1: { c1: finding({ notes: [note] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ status: 'running' }) } }));
    expect(after.findings.d1.c1.notes).toEqual([note]);
  });

  it('does not resurrect notes the incoming snapshot already has', () => {
    const older = { id: 'n1', findingId: 'd1::c1', text: 'old', byUserId: 'u', at: 1 };
    const newer = { id: 'n2', findingId: 'd1::c1', text: 'new', byUserId: 'u', at: 2 };
    const before = run({ d1: { c1: finding({ notes: [older] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ notes: [newer] }) } }));
    expect(after.findings.d1.c1.notes).toEqual([newer]);
  });

  it('passes a finding through untouched when there is nothing human to carry', () => {
    const incoming = run({ d1: { c1: finding() } });
    expect(carryHumanState(run({ d1: { c1: finding() } }), incoming)).toBe(incoming);
  });

  it('passes the snapshot through when there is no previous run', () => {
    const incoming = run({ d1: { c1: finding() } });
    expect(carryHumanState(null, incoming)).toBe(incoming);
  });

  it('leaves a finding that is new in this snapshot alone', () => {
    const before = run({ d1: { c1: finding() } });
    const after = carryHumanState(before, run({ d1: { c1: finding(), c2: finding({ clauseId: 'c2' }) } }));
    expect(after.findings.d1.c2.verification).toEqual({ state: 'unchecked' });
  });
});
