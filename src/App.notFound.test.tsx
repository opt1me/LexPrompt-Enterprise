import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', () => ({
  listPlaybooks: vi.fn().mockResolvedValue([]),
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: vi.fn().mockResolvedValue([]),
  getMatter: vi.fn(),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: vi.fn().mockResolvedValue([]),
  getReview: vi.fn(),
  saveReview: vi.fn(),
  createDebouncedReviewSaver: vi.fn(),
}));

vi.mock('./lib/openrouter', () => ({
  listModels: vi.fn().mockResolvedValue([]),
  isAuthError: () => false,
}));

import App from './App';

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App — an unrecognised route (Minor fix)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  it('shows an honest not-found state for /garbage, rather than silently rendering the Matters list', async () => {
    window.history.pushState(null, '', '/garbage');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('could not be found');
    expect(container.textContent).not.toContain('No matters yet');
    expect(container.textContent).not.toContain("Every matter's documents and reviews");
  });

  it('"Back to Matters" from the not-found state navigates to the real Matters list', async () => {
    window.history.pushState(null, '', '/garbage');
    act(() => { root.render(<App />); });
    await flush();

    const backButton = Array.from(container.querySelectorAll('button'))
      .find(b => /back to matters/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(backButton).toBeTruthy();
    act(() => { backButton.click(); });
    await flush();

    expect(container.textContent).toContain('No matters yet');
    expect(window.location.pathname).toBe('/');
  });
});
