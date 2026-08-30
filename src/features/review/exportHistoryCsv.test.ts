import { describe, it, expect } from 'vitest';
import type { ReviewHistoryEvent } from '@lexprompt/core';
import { buildHistoryCsv, type HistoryExportContext } from './exportHistoryCsv';
import { dispositionHistoryLine } from '../../lib/findingOutcome';
import { TEST_AUDIENCE } from '../../test/dispositionShapes';
import { escapeCsvField } from '../tabular/csv';

/**
 * §6.3.1's fourth requirement, as bytes.
 *
 * The history export exists so a firm can answer *"what would this report
 * have said on the day it was signed"* about a matter nobody is looking at
 * any more. What it must never do is look complete while being partial, or
 * describe an event differently from the panel on screen.
 */

const OKAFOR = 'u2';
const AT = Date.UTC(2026, 7, 28, 15, 41);

const context: HistoryExportContext = {
  readAt: AT,
  timeZone: 'Europe/London',
  audience: TEST_AUDIENCE,
  reviewName: 'Brookvale lease',
};

const event = (over: Partial<ReviewHistoryEvent> = {}): ReviewHistoryEvent => ({
  id: 1,
  fromState: 'unchecked',
  toState: 'verified',
  cause: 'human',
  byUserId: OKAFOR,
  at: Date.UTC(2026, 7, 30, 15, 4),
  findingsKey: 'd1',
  clauseId: 'c1',
  clauseTitle: 'Liability cap',
  ...over,
});

describe('a review s history, exported', () => {
  it('carries the same point-in-time stamp the other two exports carry', () => {
    // A history export is ALSO a point-in-time claim, for a reason that is
    // easy to miss: the record is insert-only, so nothing here can become
    // false — but it can become INCOMPLETE, and a reader holding the file
    // has no way to know.
    const csv = buildHistoryCsv([event()], context);
    expect(csv).toContain('Dispositions as at 2026-08-28 16:41 (Europe/London)');
    expect(csv).toContain('A disposition can be changed by any reviewer at any time');
    expect(csv).toContain("LexPrompt's history is authoritative over any printed copy");
  });

  it('describes each event in the SAME words the panel shows', () => {
    // The mutation: compose the sentence here instead of calling
    // `dispositionHistoryLine`, and a printed history and the screen begin
    // to describe one event two ways.
    const e = event({ toState: 'rejected', fromState: 'verified', reason: 'Cap is uncapped' });
    const csv = buildHistoryCsv([e], context);
    // Through `escapeCsvField`, because the sentence a rejection produces
    // carries the reason in straight quotes and a CSV doubles them — the
    // assertion has to be about the string this exporter emits, not about
    // the string before it was escaped.
    expect(csv).toContain(escapeCsvField(dispositionHistoryLine(e, TEST_AUDIENCE)));
    expect(csv).toContain('Rejected by R. Okafor');
  });

  it('names people, never ids', () => {
    const csv = buildHistoryCsv([event(), event({ id: 2, byUserId: 'u-nobody-knows' })], context);
    expect(csv).toContain('R. Okafor');
    // A raw uuid says nothing to a reader while looking like it should.
    expect(csv).not.toContain('u-nobody-knows');
    expect(csv).toContain('someone this workspace does not name');
  });

  it('keeps a row for a clause the playbook no longer names', () => {
    const { clauseTitle: _t, ...withoutTitle } = event({ clauseId: 'c-removed' });
    const csv = buildHistoryCsv([withoutTitle as ReviewHistoryEvent], context);
    // Dropping it would make the history quietly shorter than what
    // happened; a blank cell would read as a clause with no name at all.
    expect(csv).toContain('c-removed');
    expect(csv).toContain('A clause this review s playbook no longer names');
  });

  it('says that nothing was recorded, rather than shipping an empty file', () => {
    // A bare header reads as "nobody ever changed anything", which is a
    // claim. "No changes were recorded" is the fact.
    const csv = buildHistoryCsv([], context);
    expect(csv).toContain('no disposition changes have been recorded for this review');
    expect(csv).toContain('Dispositions as at 2026-08-28 16:41 (Europe/London)');
    expect(csv.split('\r\n')).toHaveLength(4);
  });

  it('counts what it holds, in the title', () => {
    expect(buildHistoryCsv([event()], context)).toContain('Brookvale lease: 1 disposition change.');
    expect(buildHistoryCsv([event(), event({ id: 2 })], context))
      .toContain('Brookvale lease: 2 disposition changes.');
  });

  it('escapes a reason that would otherwise split a row or start a formula', () => {
    const csv = buildHistoryCsv([event({
      toState: 'rejected', fromState: 'verified', reason: '=cmd(), "quoted", multi\nline',
    })], context);
    expect(csv).toContain('"\'=cmd(), ""quoted"", multi\nline"');
  });

  it('says it cannot date the export rather than dating it now', () => {
    const csv = buildHistoryCsv([event()], { ...context, readAt: undefined });
    expect(csv).toContain('Dispositions as at: not recorded');
    expect(csv).not.toContain('Dispositions as at 20');
  });
});
