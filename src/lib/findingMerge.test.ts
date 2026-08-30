import { describe, it, expect } from 'vitest';
import { carryHumanState } from './findingMerge';
import { unconfirmedPosition, confirmPosition, amendPosition } from '@lexprompt/core';
import type { Finding, ReviewRun, TrailStep } from '../types';

const TRAIL: TrailStep[] = [{ documentId: 'd1', kind: 'original', effect: 'e', citations: [] }];

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

function run(findings: ReviewRun['findings']): ReviewRun {
  return {
    id: 'r',
    templateSnapshot: { clauses: [] } as never,
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings,
    startedAt: 1,
  };
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

  // Task 10 fix round 1: `handleRetryCell` reuses this function for a
  // finding `retryCell` never touches while a retry is in flight — that
  // finding's `incoming` copy is a frozen snapshot from before the retry
  // started, and can be non-empty (it may already have had a note) while
  // still being stale (missing one added mid-retry). A plain
  // "incoming is empty" check would treat that non-empty-but-stale array as
  // authoritative and drop the new note.
  it('keeps a second note added after `incoming` was frozen, even though `incoming` already has one', () => {
    const older = { id: 'n1', findingId: 'd1::c1', text: 'earlier', byUserId: 'u', at: 1 };
    const newer = { id: 'n2', findingId: 'd1::c1', text: 'added while frozen elsewhere', byUserId: 'u', at: 2 };
    const before = run({ d1: { c1: finding({ notes: [older, newer] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ notes: [older] }) } }));
    expect(after.findings.d1.c1.notes).toEqual([older, newer]);
  });

  // Guards the id-check half of the length-based rule above: `before` being
  // longer is not enough on its own — `incoming` must also be a strict
  // subset of it by id. Mirrors "does not resurrect notes the incoming
  // snapshot already has" for the case where the lengths happen to differ
  // too (this app's real callers never actually produce this shape — notes
  // are only ever appended, never replaced — but the length check alone
  // cannot tell it apart from the legitimate "second note" case above
  // without this).
  it('does not resurrect notes when incoming has one not present in before, even if before is longer', () => {
    const a = { id: 'n1', findingId: 'd1::c1', text: 'a', byUserId: 'u', at: 1 };
    const b = { id: 'n2', findingId: 'd1::c1', text: 'b', byUserId: 'u', at: 2 };
    const c = { id: 'n3', findingId: 'd1::c1', text: 'c', byUserId: 'u', at: 3 };
    const before = run({ d1: { c1: finding({ notes: [a, b] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ notes: [c] }) } }));
    expect(after.findings.d1.c1.notes).toEqual([c]);
  });

  // Sub-project C, Task 8: a net position's confirmation is the same kind of
  // human judgement as a verification, made against a specific synthesis
  // `extractCollectionClause` produced. Without this, `handleConfirmNetPosition`
  // (App.tsx) would have its write silently undone the next time an
  // unrelated clause in a live run finished — the exact failure this
  // function exists to prevent for verifications.
  describe('a net position\'s confirmation', () => {
    it('keeps a confirmed net position when the status has not moved', () => {
      const confirmed = confirmPosition(unconfirmedPosition('model text', TRAIL), 'u1', 1);
      const before = run({ d1: { c1: finding({ netPosition: confirmed }) } });
      const after = carryHumanState(before, run({ d1: { c1: finding({ netPosition: unconfirmedPosition('model text', TRAIL) }) } }));
      expect(after.findings.d1.c1.netPosition).toEqual(confirmed);
    });

    it('keeps an amended net position the same way', () => {
      const amended = amendPosition(unconfirmedPosition('model text', TRAIL), 'human text', 'u1', 1);
      const before = run({ d1: { c1: finding({ netPosition: amended }) } });
      const after = carryHumanState(before, run({ d1: { c1: finding({ netPosition: unconfirmedPosition('model text', TRAIL) }) } }));
      expect(after.findings.d1.c1.netPosition).toEqual(amended);
    });

    it('drops it when the status moved — the synthesis it judged is gone', () => {
      const confirmed = confirmPosition(unconfirmedPosition('model text', TRAIL), 'u1', 1);
      const before = run({ d1: { c1: finding({ netPosition: confirmed }) } });
      const incoming = run({ d1: { c1: finding({ status: 'running' }) } });
      const after = carryHumanState(before, incoming);
      expect('netPosition' in after.findings.d1.c1).toBe(false);
    });

    it('does not invent a net position on a finding that never had one', () => {
      const before = run({ d1: { c1: finding() } });
      const after = carryHumanState(before, run({ d1: { c1: finding() } }));
      expect('netPosition' in after.findings.d1.c1).toBe(false);
    });

    it('does not resurrect an unconfirmed net position (nothing human to protect)', () => {
      const before = run({ d1: { c1: finding({ netPosition: unconfirmedPosition('old', TRAIL) }) } });
      const incoming = unconfirmedPosition('new', TRAIL);
      const after = carryHumanState(before, run({ d1: { c1: finding({ netPosition: incoming }) } }));
      expect(after.findings.d1.c1.netPosition).toBe(incoming);
    });
  });
});
