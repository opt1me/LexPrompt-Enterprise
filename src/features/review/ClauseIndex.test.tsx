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
