import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click } from '../../test/mount';
import { ClauseIndex, firstUncheckedClauseId } from './ClauseIndex';
import type { Finding, PlaybookClause } from '../../types';

const clauses: PlaybookClause[] = [
  { id: 'c1', title: 'Break right', extractPrompt: '' },
  { id: 'c2', title: 'Rent review', extractPrompt: '' },
  { id: 'c3', title: 'Assignment', extractPrompt: '' },
];
function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

describe('ClauseIndex', () => {
  it('lists every clause in the playbook order', () => {
    const c = mount(<ClauseIndex clauses={clauses} findings={{}} activeClauseId={null} onSelect={() => {}} />);
    expect(Array.from(c.querySelectorAll('li')).map(li => li.textContent)).toHaveLength(3);
    expect(c.textContent?.indexOf('Break right')).toBeLessThan(c.textContent!.indexOf('Rent review'));
  });

  it('selects a clause', () => {
    const onSelect = vi.fn();
    const c = mount(<ClauseIndex clauses={clauses} findings={{}} activeClauseId="c1" onSelect={onSelect} />);
    click(Array.from(c.querySelectorAll('button')).find(b => /Rent review/.test(b.textContent || '')));
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('shows the count chips that make triage possible', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ riskLevel: 'High' }), c2: finding({ verification: { state: 'flagged' } }), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toContain('1 high');
    expect(c.textContent).toContain('1 flagged');
    expect(c.textContent).toContain('2 unchecked');
  });

  // Minor 5 (final honesty review): this chip's count is the active
  // document's only, while the header and the export banner elsewhere on
  // the review screen count the whole run under the same word ("unchecked").
  // The chip has to say which scope it is so the two numbers do not read as
  // a disagreement.
  it('labels its "unchecked" count as document-scoped, not the run-wide count shown elsewhere', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding(), c2: finding(), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toMatch(/3 unchecked here/i);
  });

  // The whole point of a navigation rail over an existing map is that it
  // cannot disagree with the cards reading the same map. A findings object
  // can carry keys the rail's own `clauses` array does not — a stale entry
  // left over from a different document, or (as here) simply a key outside
  // this playbook — and an implementation that tallied `Object.values
  // (findings)` directly, instead of looking each clause up by id, would
  // count it anyway. That is exactly the "index computes its own count"
  // failure CLAUDE.md's sibling-drift rule warns about, so this pins the
  // correct behaviour: counts are keyed off `clauses`, never off however
  // many entries `findings` happens to have.
  it('counts only this playbook\'s clauses, never an orphaned key the findings map happens to carry', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{
        c1: finding({ riskLevel: 'High' }),
        c2: finding(),
        c3: finding(),
        'not-in-this-playbook': finding({ riskLevel: 'High', verification: { state: 'flagged' } }),
      }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toContain('1 high');
    expect(c.textContent).toContain('0 flagged');
    // All three of THIS playbook's clauses are unchecked (`finding()`'s
    // default verification state) regardless of the orphaned key's own
    // 'flagged' state, which must not be counted at all.
    expect(c.textContent).toContain('3 unchecked');
  });

  it('distinguishes a queued clause from a busy one', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ status: 'pending' }), c2: finding({ status: 'running' }) }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.querySelectorAll('[data-busy="true"]')).toHaveLength(1);
  });
});

/** The `<li>` whose row carries this clause title, and the class list of the
 *  status icon inside it. The icons are `aria-hidden` lucide SVGs, so their
 *  ink is the thing to assert on — that is what a reader scanning the rail
 *  actually distinguishes them by. */
function row(c: HTMLElement, title: string) {
  const li = Array.from(c.querySelectorAll('li')).find(el => (el.textContent || '').includes(title));
  if (!li) throw new Error(`no row for "${title}"`);
  return { text: li.textContent || '', icon: li.querySelector('svg')?.getAttribute('class') || '' };
}

// Spec §8.5: "a rejected-by-human finding and an errored-by-model finding
// must not look the same" — and the same holds for the pair that actually
// collapsed here. A clause the model FAILED on and a clause that was
// ANSWERED but nobody has checked both carry `verification.state ===
// 'unchecked'` (nothing derives verification), so a switch that reached the
// verification states first drew them the identical grey circle. Those are
// different facts leading a reviewer to do different things: one needs a
// retry, the other needs reading.
describe('ClauseIndex — a clause that produced no answer is not a clause awaiting a check', () => {
  it('draws an errored clause distinctly from an answered-but-unchecked one', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ status: 'error', error: 'The model returned 500.' }), c2: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    const failed = row(c, 'Break right');
    const unchecked = row(c, 'Rent review');

    expect(failed.icon).toContain('text-risk-high');
    expect(failed.icon).not.toEqual(unchecked.icon);
    // Not icon-only: the icons are aria-hidden, so the row's own words have
    // to carry the fact too.
    expect(failed.text).toContain('Failed');
    expect(unchecked.text).toContain('Clause 2 of 3');
    expect(unchecked.text).not.toContain('Failed');
  });

  it('draws a cancelled clause calmly, and distinctly from both', () => {
    // The user stopped the run; nothing went wrong. `CircleSlash` in ink-4,
    // matching `FindingCard` and the grid's `Cell`.
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ status: 'cancelled' }), c2: finding({ status: 'error' }), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    const cancelled = row(c, 'Break right');
    expect(cancelled.text).toContain('Cancelled');
    expect(cancelled.icon).not.toContain('text-risk-high');
    expect(cancelled.icon).not.toEqual(row(c, 'Rent review').icon);
    expect(cancelled.icon).not.toEqual(row(c, 'Assignment').icon);
  });

  it('keeps failed and cancelled clauses out of the "unchecked" tally, and names them instead', () => {
    // Counting a failure as merely-unchecked overstates how much of the
    // review is real work awaiting a human, and hides that some of it has to
    // be re-run before anybody can read anything.
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ status: 'error' }), c2: finding({ status: 'cancelled' }), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toContain('1 unchecked');
    expect(c.textContent).toContain('1 failed');
    expect(c.textContent).toContain('1 cancelled');
  });

  it('says nothing about failures when there are none', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding(), c2: finding(), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toContain('3 unchecked');
    expect(c.textContent).not.toContain('failed');
    expect(c.textContent).not.toContain('cancelled');
  });
});

describe('firstUncheckedClauseId', () => {
  it('returns the first clause whose finding nobody has checked', () => {
    expect(firstUncheckedClauseId(clauses, {
      c1: finding({ verification: { state: 'verified' } }),
      c2: finding(),
    })).toBe('c2');
  });

  it('returns null when everything has been checked', () => {
    expect(firstUncheckedClauseId(clauses.slice(0, 1), { c1: finding({ verification: { state: 'rejected' } }) })).toBe(null);
  });

  it('treats a clause with no finding at all as unchecked', () => {
    // A clause the run never reached is not a clause a human signed off.
    expect(firstUncheckedClauseId(clauses, {})).toBe('c1');
  });
});
