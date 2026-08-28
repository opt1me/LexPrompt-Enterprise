import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, buttonNamed, click } from '../../test/mount';
import { TabularReview } from './TabularReview';
import type { DocumentFile, Finding, ReviewRun, PlaybookVersion } from '../../types';

// Task 10: sub-project B's final review found the grid's cells show no
// verification state at all — a rejected and a verified cell looked
// identical. This file locks in the fix: a cell shows StateChip and
// RiskChip separately, a column header carries a risk mini-bar, `Open in
// review` hands off the clicked cell, and a collection review — which
// produces one position per clause, not one per document — is refused a
// grid rather than shown one that has nothing genuine to compare.

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: '' }],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
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
    // The claim is about the cell's CONTENT, not its class: the whole
    // sentence is in the DOM, in the cell, in one element — a grid that
    // cuts a finding off mid-word is a grid that hides the finding.
    const summaryEl = cell?.querySelector('[data-testid="cell-summary"]');
    expect(summaryEl).toBeTruthy();
    expect(summaryEl?.textContent).toBe(summary);
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

// m7 (final honesty review): the clause-index chip counts finding-INSTANCES
// across documents, which can exceed the clause count shown right beside
// it. The fix names the unit explicitly rather than counting differently.
describe('TabularReview — the deviating count names its own unit (m7)', () => {
  it('says "deviating findings", plural, when the count exceeds the clause count', () => {
    // One clause, deviating in all three documents: 3 deviating findings,
    // but only 1 clause — a bare "3 deviating" beside "3 docs · 1 clauses"
    // would misread as a clause tally.
    const run = makeRun({
      d1: { c1: doneFinding({ positionOutcome: 'deviates' }) },
      d2: { c1: doneFinding({ positionOutcome: 'deviates' }) },
      d3: { c1: doneFinding({ positionOutcome: 'deviates' }) },
    }, ['d1', 'd2', 'd3']);
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1'), makeDoc('d2'), makeDoc('d3')]} onRetryCell={() => {}} />,
    );
    expect(container.textContent).toContain('3 deviating findings');
    expect(container.textContent).not.toMatch(/3 deviating(?! finding)/);
  });

  it('uses the singular for exactly one deviating finding', () => {
    const run = makeRun({ d1: { c1: doneFinding({ positionOutcome: 'deviates' }) } });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />);
    expect(container.textContent).toContain('1 deviating finding');
    expect(container.textContent).not.toContain('1 deviating findings');
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

describe('TabularReview — the clause index counts deviations (Task 12)', () => {
  it('counts the deviations across the run', () => {
    const run = makeRun({ d1: {
      c1: doneFinding({ positionOutcome: 'deviates', positionRationale: 'Nine months.' }),
      c2: doneFinding({ positionOutcome: 'deviates', positionRationale: 'Uncapped.' }),
      c3: doneFinding({ positionOutcome: 'meets' }),
    } });
    expect(mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />).textContent)
      .toMatch(/2[^0-9]{0,3}deviat/i);
  });

  it('shows no deviation count when no clause carries a position', () => {
    // Absent is not zero. A run where nobody set a house rule has not
    // "0 deviations" — it has no comparison at all, and a 0 chip would
    // report a clean result against a standard that was never applied.
    const run = makeRun({ d1: { c1: doneFinding({ summary: 'x' }) } });
    expect(mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />).textContent)
      .not.toMatch(/deviat/i);
  });

  it('does not count an unclear outcome as a deviation', () => {
    // `unclear` means the model could not tell. Counting it as a deviation
    // would report a conflict with the house position that nobody found.
    const run = makeRun({ d1: {
      c1: doneFinding({ positionOutcome: 'deviates', positionRationale: 'x' }),
      c2: doneFinding({ positionOutcome: 'unclear' }),
    } });
    expect(mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />).textContent)
      .toMatch(/1[^0-9]{0,3}deviat/i);
  });

  it('does not count a positionOutcome carried onto a non-done finding', () => {
    // `failRetryCell` can carry a previous attempt's `positionOutcome` onto
    // an `error` finding when a retry cannot even reach the extractor
    // (`findingOutcome.ts`'s `hasStandingPosition`). That comparison no
    // longer describes settled output, and the exporters already refuse to
    // report on it — the clause index must apply the same gate rather than
    // reading `finding.positionOutcome` directly, or it will disagree with
    // the exports about whether a stale comparison still counts.
    const run = makeRun({ d1: {
      c1: {
        clauseId: 'c1',
        status: 'error',
        error: 'retry failed before reaching the model',
        citations: [],
        verification: { state: 'unchecked' },
        notes: [],
        positionOutcome: 'deviates',
      },
    } });
    const text = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />).textContent;
    expect(text).not.toMatch(/deviat/i);
  });
});
