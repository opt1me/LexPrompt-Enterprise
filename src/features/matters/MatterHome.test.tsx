import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter } from '../../types';
import { MatterHome } from './MatterHome';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
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
