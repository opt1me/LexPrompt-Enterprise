import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, buttonNamed, click } from '../../test/mount';
import { TabularReview } from './TabularReview';
import type { DocumentFile, Finding, ReviewRun, Template } from '../../types';

// Task 10: sub-project B's final review found the grid's cells show no
// verification state at all — a rejected and a verified cell looked
// identical. This file locks in the fix: a cell shows StateChip and
// RiskChip separately, a column header carries a risk mini-bar, `Open in
// review` hands off the clicked cell, and a collection review — which
// produces one position per clause, not one per document — is refused a
// grid rather than shown one that has nothing genuine to compare.

function makeTemplate(): Template {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: '' }],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 2,
  };
}

function makeDoc(id: string): DocumentFile {
  return { id, name: `${id}.txt`, text: 'x', file: new File(['x'], `${id}.txt`), kind: 'txt' };
}

function doneFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'c1',
    status: 'done',
    summary: 'The notice period is six months from the date of service.',
    citations: [],
    verification: { state: 'unchecked' },
    notes: [],
    ...overrides,
  };
}

function makeRun(findings: ReviewRun['findings'], documentIds: string[] = ['d1']): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: makeTemplate(),
    documentIds,
    target: { kind: 'documents', documentIds },
    findings,
    startedAt: 1,
  };
}

describe('TabularReview — a cell shows verification and risk separately (Task 10)', () => {
  it('a verified High-risk finding shows both "Verified" and "High" as two separate chips', () => {
    const run = makeRun({
      d1: { c1: doneFinding({ riskLevel: 'High', verification: { state: 'verified' } }) },
    });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />);
    const verificationChip = container.querySelector('[role="status"]');
    expect(verificationChip?.textContent).toContain('Verified');
    // Two distinct elements, not one merged badge.
    expect(container.textContent).toContain('High');
    expect(verificationChip?.textContent).not.toContain('High');
  });

  it('a rejected cell and a verified cell read differently, cell-for-cell', () => {
    const run = makeRun({
      d1: { c1: doneFinding({ riskLevel: 'Low', verification: { state: 'verified' } }) },
      d2: { c1: doneFinding({ riskLevel: 'Low', verification: { state: 'rejected', reason: 'Wrong clause' } }) },
    }, ['d1', 'd2']);
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1'), makeDoc('d2')]} onRetryCell={() => {}} />,
    );
    const chips = Array.from(container.querySelectorAll('[role="status"]')).map(el => el.textContent);
    expect(chips).toContain('Verified');
    expect(chips).toContain('Rejected');
    // This is the defect sub-project B found: before the fix, neither state
    // rendered anywhere, so the two cells were textually indistinguishable
    // on the verification axis.
    expect(chips.filter(c => c === 'Verified' || c === 'Rejected')).toHaveLength(2);
  });
});

describe('TabularReview — a cell renders a readable sentence, not a truncated blob (Task 10)', () => {
  it('the full summary text is present, and the cell does not use single-line truncation', () => {
    const summary = 'The notice period is six months from the date of service, running from delivery.';
    const run = makeRun({ d1: { c1: doneFinding({ summary }) } });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />);
    expect(container.textContent).toContain(summary);
    const cell = Array.from(container.querySelectorAll('td')).find(td => td.textContent?.includes(summary));
    const summaryEl = cell?.querySelector('.truncate');
    expect(summaryEl).toBeFalsy();
  });
});

describe('TabularReview — column header risk mini-bar (Task 10)', () => {
  it('summarises the risk distribution for that clause across all rows', () => {
    const run = makeRun({
      d1: { c1: doneFinding({ riskLevel: 'High' }) },
      d2: { c1: doneFinding({ riskLevel: 'Low' }) },
    }, ['d1', 'd2']);
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1'), makeDoc('d2')]} onRetryCell={() => {}} />,
    );
    const bar = container.querySelector('th [role="img"]');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute('aria-label')).toContain('1 High');
    expect(bar?.getAttribute('aria-label')).toContain('1 Low');
  });

  it('reuses verificationCounts for the column summary rather than counting inline', () => {
    const run = makeRun({
      d1: { c1: doneFinding({ verification: { state: 'verified' } }) },
      d2: { c1: doneFinding({ verification: { state: 'unchecked' } }) },
    }, ['d1', 'd2']);
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1'), makeDoc('d2')]} onRetryCell={() => {}} />,
    );
    const header = container.querySelector('th:nth-child(2)');
    expect(header?.textContent).toContain('1/2 verified');
  });
});

describe('TabularReview — "Open in review" hands off the clicked cell (Task 10)', () => {
  it('calls onOpenInReview with the clicked cell\'s docId and clauseId', () => {
    const onOpenInReview = vi.fn();
    const run = makeRun({ d1: { c1: doneFinding() } });
    const container = mount(
      <TabularReview
        run={run}
        documents={[makeDoc('d1')]}
        onRetryCell={() => {}}
        onOpenInReview={onOpenInReview}
      />,
    );
    const cell = container.querySelector('td:nth-child(2)') as HTMLElement;
    click(cell);
    const button = buttonNamed(container, /open in review/i);
    expect(button).toBeTruthy();
    click(button);
    expect(onOpenInReview).toHaveBeenCalledWith('d1', 'c1');
  });

  it('renders no "Open in review" affordance when the handler is not supplied', () => {
    const run = makeRun({ d1: { c1: doneFinding() } });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />);
    const cell = container.querySelector('td:nth-child(2)') as HTMLElement;
    click(cell);
    expect(buttonNamed(container, /open in review/i)).toBeFalsy();
  });
});

describe('TabularReview — a collection review is refused a grid (Task 10)', () => {
  it('renders an explanation instead of a table, naming why', () => {
    const run: ReviewRun = {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {
        'coll-1': { c1: doneFinding({ summary: undefined }) },
      },
      startedAt: 1,
    };
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1'), makeDoc('d2')]} onRetryCell={() => {}} />,
    );
    expect(container.querySelector('table')).toBeFalsy();
    expect(container.textContent).toMatch(/one position per clause/i);
  });

  it('still offers a way back to the review when onOpenCards is supplied', () => {
    const onOpenCards = vi.fn();
    const run: ReviewRun = {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {},
      startedAt: 1,
    };
    const container = mount(
      <TabularReview
        run={run}
        documents={[makeDoc('d1'), makeDoc('d2')]}
        onRetryCell={() => {}}
        onOpenCards={onOpenCards}
      />,
    );
    const button = buttons(container).find(b => /review/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    click(button);
    expect(onOpenCards).toHaveBeenCalled();
  });
});

describe('TabularReview — an errored cell still shows its error and its retry (Task 10 regression)', () => {
  it('shows the error text and a working Retry button', () => {
    const onRetryCell = vi.fn();
    const run = makeRun({
      d1: { c1: { clauseId: 'c1', status: 'error', error: 'Model returned malformed JSON', citations: [], verification: { state: 'unchecked' }, notes: [] } },
    });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={onRetryCell} />);
    expect(container.textContent).toContain('Model returned malformed JSON');
    const retryButton = container.querySelector('button[title="Retry"]') as HTMLButtonElement;
    expect(retryButton).toBeTruthy();
    click(retryButton);
    expect(onRetryCell).toHaveBeenCalledWith('d1', 'c1');
  });
});
