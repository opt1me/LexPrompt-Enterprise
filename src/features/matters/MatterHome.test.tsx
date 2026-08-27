import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Finding, Matter, Review } from '../../types';
import { MatterHome } from './MatterHome';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function f(status: Finding['status'], state: Finding['verification']['state']): Finding {
  return { clauseId: 'c', status, citations: [], notes: [], verification: { state } };
}

/** A completed review with 4 findings, 2 of them verified — the mix each
 *  progress test below needs. */
function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: {
      id: 't1',
      name: 'Basic Contract Review',
      contractType: 'NDA',
      mode: 'extraction',
      systemPrompt: '',
      formatPrompt: '',
      clauses: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 2,
    },
    documentIds: ['d1'],
    findings: {
      d1: {
        c1: f('done', 'verified'),
        c2: f('done', 'verified'),
        c3: f('done', 'unchecked'),
        c4: f('done', 'unchecked'),
      },
    },
    modelId: 'm',
    startedAt: 1,
    createdByUserId: 'u1',
    ...overrides,
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

const baseProps = {
  matter: makeMatter(),
  documents: [],
  documentsError: null,
  onRetryDocuments: () => {},
  onAddDocuments: async () => {},
  onRemoveDocument: async () => {},
  reviews: [],
  reviewsError: null,
  onRetryReviews: () => {},
  onOpenReview: () => {},
  playbooks: [],
  playbooksError: null,
  onRetryPlaybooks: () => {},
  onRunReview: async () => {},
  onDeleteMatter: async () => {},
};

describe('MatterHome — converged load-error panels (Important 4)', () => {
  it('a documents load failure renders the shared panel with a working retry', () => {
    const onRetryDocuments = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} documentsError="The documents in this matter could not be loaded. Try again." onRetryDocuments={onRetryDocuments} />,
    );
    expect(container.textContent).toContain('could not be loaded');
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetryDocuments).toHaveBeenCalled();
  });

  it('a reviews load failure renders the shared panel with a working retry', () => {
    const onRetryReviews = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} reviewsError="The reviews in this matter could not be loaded. Try again." onRetryReviews={onRetryReviews} />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetryReviews).toHaveBeenCalled();
  });

  it('the "run a review" playbook picker now offers a working Retry on a load failure, not just a redirect message', () => {
    const onRetryPlaybooks = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} playbooksError="The playbook library could not be loaded. Try again." onRetryPlaybooks={onRetryPlaybooks} />,
    );
    const runButton = Array.from(container.querySelectorAll('button')).find(b => /run a review/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { runButton.click(); });

    expect(container.textContent).toContain('could not be loaded');
    const retryButton = Array.from(container.querySelectorAll('button')).find(b => /^retry$/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
    act(() => { (retryButton as HTMLButtonElement).click(); });
    expect(onRetryPlaybooks).toHaveBeenCalled();
  });
});

describe('MatterHome — verification progress (Task 12)', () => {
  it('shows how many findings in a review a human has verified', () => {
    const container = mount(
      <MatterHome {...baseProps} reviews={[makeReview()]} />,
    );
    expect(container.textContent).toContain('2 of 4 verified');
  });

  it('shows verification progress separately from run progress', () => {
    const container = mount(
      <MatterHome {...baseProps} reviews={[makeReview()]} />,
    );
    // All 4 findings are `status: 'done'`, so reviewStatusLabel (untouched
    // by this task) reports 4/4 clauses reviewed — a different question
    // from how many a human has verified, and a reader needs both.
    expect(container.textContent).toContain('4/4 clauses reviewed');
    expect(container.textContent).toContain('2 of 4 verified');
  });
});
