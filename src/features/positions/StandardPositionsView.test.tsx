import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { StandardPositionsView } from './StandardPositionsView';
import type { PositionRow } from '../../lib/standardPositions';

const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  playbookId: 'p1', playbookName: 'Lease', clauseId: 'c1', clauseTitle: 'Break right',
  positionText: 'Six months.', health: { kind: 'untested' }, ...over,
});

describe('StandardPositionsView', () => {
  it('lists a row per position with its playbook, clause and health', () => {
    const c = mount(<StandardPositionsView rows={[row({ health: { kind: 'conceded', count: 2 } })]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('Six months.');
    expect(c.textContent).toContain('Lease');
    expect(c.textContent).toContain('Break right');
    // The four health strings are frozen copy — positionHealthLabel is the
    // only place they live.
    expect(c.textContent).toContain('CONCEDED 2 times');
  });

  it('says a firm has no standard positions rather than showing an empty table', () => {
    const c = mount(<StandardPositionsView rows={[]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('No standard positions yet');
    expect(c.querySelectorAll('li')).toHaveLength(0);
  });

  it('renders the load-error panel instead of the index when the read failed', () => {
    const c = mount(<StandardPositionsView rows={[]} error="Your playbooks could not be loaded." onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('Your playbooks could not be loaded.');
    expect(c.textContent).not.toContain('No standard positions yet');
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });

  it('filters by health', () => {
    const c = mount(<StandardPositionsView
      rows={[row({ clauseId: 'c1', clauseTitle: 'Break', health: { kind: 'conceded', count: 1 } }), row({ clauseId: 'c2', clauseTitle: 'Rent', health: { kind: 'held', supporting: 2, total: 2 } })]}
      error={null} onRetry={() => {}} onOpenPlaybook={() => {}}
    />);
    click(buttonNamed(c, /^Conceded$/));
    expect(c.textContent).toContain('Break');
    expect(c.textContent).not.toContain('Rent');
  });

  it('links each row to its clause in the playbook editor', () => {
    const onOpenPlaybook = vi.fn();
    const c = mount(<StandardPositionsView rows={[row()]} error={null} onRetry={() => {}} onOpenPlaybook={onOpenPlaybook} />);
    click(buttonNamed(c, /Open in playbook/));
    expect(onOpenPlaybook).toHaveBeenCalledWith('p1', 'c1');
  });

  it('is read-only: every control it renders only navigates or filters', () => {
    // Read-only by design: no new writes and no model call (R-G18).
    //
    // An earlier draft asserted there was no input/textarea/select on a
    // component whose only controls are <button>s — true however the
    // component behaved (F17b, the vacuous read-only test; R-GP10). The
    // real claim is about what this view can DO: it renders exactly two
    // kinds of control, a health filter and a navigation link, and nothing
    // that could write.
    const c = mount(<StandardPositionsView rows={[row(), row({ clauseId: 'c2', clauseTitle: 'Rent' })]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    const labels = Array.from(c.querySelectorAll('button')).map(b => (b.textContent || '').trim());
    // Four filters, plus exactly one "Open in playbook" per row. Nothing
    // else: no edit, no save, no re-derive, no "recalculate health".
    expect(labels).toEqual([
      'All', 'Conceded', 'Untested', 'Held',
      'Open in playbook →', 'Open in playbook →',
    ]);
  });
});
