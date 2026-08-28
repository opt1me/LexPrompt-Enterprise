import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from './mount';
import { TabularReview } from '../features/tabular/TabularReview';
import { Modal } from '../components/Modal';
import type { Finding, ReviewRun, DocumentFile } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', summary: 'A sentence.', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function run(): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'me', schemaVersion: 6 },
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding() } },
    startedAt: 1,
  } as ReviewRun;
}
const doc = { id: 'd1', name: 'Lease.pdf', kind: 'pdf', text: '[Page 1]\nx' } as DocumentFile;

describe('responsive structure (≥768px pass)', () => {
  it('the grid owns its horizontal scroll in a dedicated container', () => {
    // A dense table that pushes the PAGE horizontally is the defect this
    // asserts against: every other screen then scrolls sideways too.
    const c = mount(<TabularReview run={run()} documents={[doc]} onRetryCell={() => {}} />);
    const table = c.querySelector('table');
    expect(table).toBeTruthy();
    const scroller = table!.closest('[data-scroll-x]');
    expect(scroller, 'the grid table must sit inside a data-scroll-x container').toBeTruthy();
    // …and that container must not be the page body itself.
    expect(scroller!.contains(table!)).toBe(true);
    expect(scroller!.tagName).not.toBe('BODY');
  });

  it('a modal panel declares itself a sheet below the sm breakpoint', () => {
    const c = mount(<Modal isOpen title="T" onClose={() => {}}><p>x</p></Modal>);
    const dialog = c.querySelector('[role="dialog"]');
    // A semantic hook, not a class-string assertion. §13.1 records that this
    // suite has ZERO class-as-style assertions and G is not the sub-project
    // that introduces the first one; the scroll container in the case above
    // already demonstrates the better idiom (F18).
    expect(dialog!.getAttribute('data-sheet-below')).toBe('sm');
    expect(dialog!.getAttribute('role')).toBe('dialog');
  });
});
