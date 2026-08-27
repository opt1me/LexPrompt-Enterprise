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

function makeTemplate(): Template {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', prompt: '' }],
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

  it('renders a collection review\'s cell, keyed by the collection id — not an empty/pending cell', () => {
    const container = mount(
      <TabularReview
        run={makeCollectionRun()}
        documents={[makeDoc('d1'), makeDoc('d2')]}
        onRetryCell={() => {}}
      />,
    );
    expect(container.textContent).toContain('The notice period is now 6 months.');
    expect(container.textContent).not.toContain('Pending');
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
