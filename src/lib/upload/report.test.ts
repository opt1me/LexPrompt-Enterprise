import { describe, it, expect } from 'vitest';
import { isComplete, movedLine, seal, type RecordOutcome, type StoreName } from './report';

/**
 * `isComplete` is the whole of §13.1's *"a partial migration says so; it
 * never reports success over a gap"*, so every one of its near-misses gets
 * its own named case. Each of the three below is a report where nothing
 * "failed" in the ordinary sense and the run finished, and each must still
 * answer `false`.
 */

const moved = (store: StoreName, id: string, label: string): RecordOutcome =>
  ({ store, id, label, status: 'moved' });

describe('isComplete', () => {
  it('is true when every expected record moved and nothing was unreadable', () => {
    expect(isComplete({ matters: 2 }, [moved('matters', 'm1', 'A'), moved('matters', 'm2', 'B')], []))
      .toBe(true);
  });

  it('counts a record already on the server as accounted for, not as a gap', () => {
    // The second run of an interrupted first one. A record confirmed present
    // is not a hole in the migration; reporting it as one would make a
    // successful retry unable to ever say so.
    expect(isComplete({ matters: 1 }, [
      { store: 'matters', id: 'm1', label: 'A', status: 'skipped-already-there' },
    ], [])).toBe(true);
  });

  it('is FALSE when one record failed', () => {
    expect(isComplete({ matters: 2 }, [
      moved('matters', 'm1', 'A'),
      { store: 'matters', id: 'm2', label: 'B', status: 'failed', reason: 'boom' },
    ], [])).toBe(false);
  });

  it('is FALSE when a store was unreadable, even though nothing failed', () => {
    // Nothing was attempted, so nothing failed — and that is worse, not
    // better. An unknown number of reviews is not zero reviews, and this is
    // the exact confusion behind "an empty library, indistinguishable from a
    // fresh install".
    expect(isComplete({ matters: 1 }, [moved('matters', 'm1', 'A')], ['reviews'])).toBe(false);
  });

  it('is FALSE when a document moved WITHOUT its bytes', () => {
    // Every count reconciles and the status begins with the word "moved".
    // Calling this complete is the blank-CSV-cell defect: technically true,
    // read as finished.
    expect(isComplete({ documents: 1 }, [
      { store: 'documents', id: 'd1', label: 'a.pdf', status: 'moved-without-bytes', reason: 'no bytes' },
    ], [])).toBe(false);
  });

  it('is FALSE when the run produced fewer outcomes than the scan expected', () => {
    // A record the run never reached at all leaves no outcome of any kind,
    // so a check that only looked for failures would report a run that
    // stopped half way as complete.
    expect(isComplete({ matters: 3 }, [moved('matters', 'm1', 'A')], [])).toBe(false);
  });

  it('is true for a browser that had nothing in it', () => {
    expect(isComplete({}, [], [])).toBe(true);
  });
});

describe('seal', () => {
  it('derives complete rather than carrying one in', () => {
    const report = seal({
      startedAt: 1, expected: { matters: 1 }, unmapped: 0, unreadable: [],
      outcomes: [{ store: 'matters', id: 'm1', label: 'A', status: 'failed', reason: 'boom' }],
    }, 99);
    expect(report.complete).toBe(false);
    expect(report.finishedAt).toBe(99);
  });
});

describe('movedLine', () => {
  it('says how many of how many, by store', () => {
    const report = seal({
      startedAt: 1, expected: { matters: 3 }, unmapped: 0, unreadable: [],
      outcomes: [moved('matters', 'm1', 'A'), moved('matters', 'm2', 'B'),
        { store: 'matters', id: 'm3', label: 'C', status: 'failed', reason: 'boom' }],
    });
    expect(movedLine('matters', report)).toBe('2 of 3 matters');
  });

  it('says a store could not be read rather than inventing a denominator', () => {
    const report = seal({
      startedAt: 1, expected: {}, unmapped: 0, unreadable: ['reviews'], outcomes: [],
    });
    expect(movedLine('reviews', report)).toMatch(/could not be read/);
  });
});
