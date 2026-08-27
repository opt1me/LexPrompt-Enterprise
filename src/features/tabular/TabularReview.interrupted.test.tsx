import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DocumentFile, ReviewRun, Template } from '../../types';
import { TabularReview } from './TabularReview';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function makeDoc(): DocumentFile {
  return { id: 'd1', name: 'nda.txt', text: 'x', file: new File(['x'], 'nda.txt'), kind: 'txt' };
}

function makeRun(status: 'pending' | 'running'): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: makeTemplate(),
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: { clauseId: 'c1', status, citations: [], verification: { state: 'unchecked' }, notes: [] } } },
    startedAt: 1,
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

function mount(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => { root.render(node); });
  cleanup = () => { act(() => { root.unmount(); }); container.remove(); };
  return container;
}

function hasRetryTitle(container: HTMLDivElement): boolean {
  return !!container.querySelector('button[title="Retry"]');
}

describe('TabularReview Cell — interrupted prop (Important 1)', () => {
  it('a pending cell offers no Retry when not interrupted', () => {
    const container = mount(
      <TabularReview run={makeRun('pending')} documents={[makeDoc()]} onRetryCell={() => {}} />,
    );
    expect(hasRetryTitle(container)).toBe(false);
  });

  it('a pending cell offers Retry when interrupted, calling onRetryCell(docId, clauseId)', () => {
    const onRetryCell = vi.fn();
    const container = mount(
      <TabularReview run={makeRun('pending')} documents={[makeDoc()]} onRetryCell={onRetryCell} interrupted />,
    );
    const button = container.querySelector('button[title="Retry"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    act(() => { button.click(); });
    expect(onRetryCell).toHaveBeenCalledWith('d1', 'c1');
  });

  it('a running cell offers Retry when interrupted', () => {
    const container = mount(
      <TabularReview run={makeRun('running')} documents={[makeDoc()]} onRetryCell={() => {}} interrupted />,
    );
    expect(hasRetryTitle(container)).toBe(true);
  });
});
