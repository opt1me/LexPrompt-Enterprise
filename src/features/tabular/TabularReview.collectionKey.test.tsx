import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { TabularReview } from './TabularReview';
import type { DocumentFile, ReviewRun, Template } from '../../types';

// Task 8A: `TabularReview` is a pure renderer over `run.findings` — same map
// `ResultsView` reads. It still looked cells up by `run.findings[docId]`,
// which for a collection review (findings keyed by the collection id, since
// Task 6A) meant every cell rendered as if pending forever, no matter what
// the run actually produced.
//
// Task 10 supersedes the first test below: a collection produces one
// position per clause, not one per document, so rendering its (correctly
// keyed, post-8A) finding as if it were a per-document comparison would
// have been misleading in a different way — implying a row-by-row
// disagreement across documents that the review never assessed. The grid
// now refuses a collection target outright rather than rendering it, so
// this test asserts the refusal instead of cell content. The regression
// pin below (a standalone review) is untouched by Task 10 and still
// exercises the original `findingsKeyFor` fix.

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

describe('TabularReview — reading a collection review\'s findings (Task 8A)', () => {
  function makeCollectionRun(): ReviewRun {
    return {
      id: 'r1',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {
        'coll-1': {
          c1: {
            clauseId: 'c1', status: 'done', summary: 'The notice period is now 6 months.',
            citations: [], verification: { state: 'unchecked' }, notes: [],
          },
        },
      },
      startedAt: 1,
    };
  }

  it('a collection review is refused a grid (Task 10) rather than rendering its collection-keyed cell as a comparison', () => {
    const container = mount(
      <TabularReview
        run={makeCollectionRun()}
        documents={[makeDoc('d1'), makeDoc('d2')]}
        onRetryCell={() => {}}
      />,
    );
    expect(container.querySelector('table')).toBeFalsy();
    expect(container.textContent).toMatch(/one position per clause/i);
  });

  it('a standalone (document-keyed) review still renders exactly as before (regression pin)', () => {
    const run: ReviewRun = {
      id: 'r2',
      templateSnapshot: makeTemplate(),
      documentIds: ['d1'],
      target: { kind: 'documents', documentIds: ['d1'] },
      findings: {
        d1: {
          c1: {
            clauseId: 'c1', status: 'done', summary: 'Governed by NY law.',
            citations: [], verification: { state: 'unchecked' }, notes: [],
          },
        },
      },
      startedAt: 1,
    };
    const container = mount(
      <TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />,
    );
    expect(container.textContent).toContain('Governed by NY law.');
  });
});
