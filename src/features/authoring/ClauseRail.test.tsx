import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, click } from '../../test/mount';
import { ClauseRail } from './ClauseRail';
import type { ClauseDisposition, DraftClause } from '../../lib/authoringDraft';

function clause(id: string, title: string, disposition: ClauseDisposition): DraftClause {
  return {
    id,
    title,
    extractPrompt: `Extract the ${title.toLowerCase()} terms.`,
    disposition,
    edited: false,
    positionEdited: false,
    suggestions: [],
  };
}

const mixed: DraftClause[] = [
  clause('a', 'Clause a', 'kept'),
  clause('b', 'Clause b', 'cut'),
  clause('c', 'Clause c', 'unreviewed'),
];

describe('ClauseRail', () => {
  it('shows kept / cut / unreviewed counts in the rail', () => {
    const el = mount(<ClauseRail clauses={mixed} activeId="a" onSelect={() => {}} />);
    const out = el.textContent ?? '';
    expect(out).toMatch(/1[^0-9]*kept/i);
    expect(out).toMatch(/1[^0-9]*cut/i);
    expect(out).toMatch(/1[^0-9]*unreviewed/i);
  });

  it('lists every clause by title', () => {
    const el = mount(<ClauseRail clauses={mixed} activeId="a" onSelect={() => {}} />);
    expect(el.textContent).toMatch(/Clause a/);
    expect(el.textContent).toMatch(/Clause b/);
    expect(el.textContent).toMatch(/Clause c/);
  });

  it('calls onSelect with the clicked clause id', () => {
    const onSelect = vi.fn();
    const el = mount(<ClauseRail clauses={mixed} activeId="a" onSelect={onSelect} />);
    const rows = buttons(el);
    const rowB = rows.find((b) => /Clause b/.test(b.textContent ?? ''));
    click(rowB);
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});
