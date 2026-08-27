import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// No @testing-library/react in this project — see App.test.tsx for the
// precedent this follows: drive a real react-dom root directly, mocking
// App.tsx's repository/module boundaries.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();
const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();

// This file exists specifically to exercise App's startup migration gate
// (Task 14), so `migrateIfNeeded` is the one thing under test here — every
// other repository call is mocked out exactly as in App.test.tsx, purely
// so AppShell (once the gate lets it mount) has something deterministic to
// render behind it.
vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  // The pure helpers (`newPlaybookDraft`, `draftFromVersion`) come from
  // the real module: re-implementing them here would be a second copy of
  // logic this task just extracted. Only the store-touching functions
  // below are replaced.
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: vi.fn(),
  getPlaybookContent: async (id: string) => (await listPlaybooksMock()).find((p: { id: string }) => p.id === id) ?? null,
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
}));

import App from './App';

async function flush() {
  // Mirrors App.test.tsx's flush: one microtask turn for the startup
  // migration gate's mocked `migrateIfNeeded` to settle and AppShell to
  // mount, one or two more for AppShell's own mocked repository calls
  // (when it gets that far) to resolve and the resulting setState to land.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App — startup playbook migration gate (Task 14)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('not-needed: proceeds silently — the app renders normally with no toast', async () => {
    migrateIfNeededMock.mockResolvedValue({ status: 'not-needed', count: 0 });
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('No matters yet');
    expect(container.textContent).not.toContain('Migrated');
    expect(container.textContent).not.toContain('safe');
  });

  it('migrated: proceeds, with a toast naming the count', async () => {
    migrateIfNeededMock.mockResolvedValue({ status: 'migrated', count: 4 });
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('No matters yet');
    expect(container.textContent).toContain('Migrated 4 playbooks');
  });

  it('migrated with a single playbook: singular wording in the toast', async () => {
    migrateIfNeededMock.mockResolvedValue({ status: 'migrated', count: 1 });
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('Migrated 1 playbook.');
    expect(container.textContent).not.toContain('Migrated 1 playbooks');
  });

  it('failed: blocks with an explanatory screen instead of rendering the library', async () => {
    migrateIfNeededMock.mockResolvedValue({ status: 'failed', count: 0, error: 'v1 template storage could not be parsed: boom' });
    act(() => { root.render(<App />); });
    await flush();

    // Plain-language reassurance that nothing was lost.
    expect(container.textContent).toMatch(/safe/i);
    expect(container.textContent).toMatch(/older storage/i);
    expect(container.textContent).toMatch(/not.*deleted/i);
    // The actual error, surfaced rather than swallowed.
    expect(container.textContent).toContain('v1 template storage could not be parsed: boom');
    // A working retry affordance.
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();

    // The specific regression this task exists to prevent: an empty
    // library rendered in place of (or instead of noticing) the failure.
    // Nothing from AppShell — its header, its nav, its "No matters yet"
    // empty state — may be present while this screen is up.
    expect(container.textContent).not.toContain('No matters yet');
    expect(container.textContent).not.toContain('Matters');
    expect(container.textContent).not.toContain('Library');
    expect(listMattersMock).not.toHaveBeenCalled();
    expect(listPlaybooksMock).not.toHaveBeenCalled();
  });

  it('failed: retry re-invokes the migration and, on success, mounts the app', async () => {
    migrateIfNeededMock
      .mockResolvedValueOnce({ status: 'failed', count: 0, error: 'quota exceeded' })
      .mockResolvedValueOnce({ status: 'not-needed', count: 0 });
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toContain('quota exceeded');

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { retryButton.click(); });
    await flush();

    expect(migrateIfNeededMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('quota exceeded');
    expect(container.textContent).toContain('No matters yet');
  });

  it('a rejecting migrateIfNeeded is caught defensively and shows the same blocking screen, never a white screen', async () => {
    // migrateIfNeeded is contractually documented to never reject, but the
    // wiring must not trust that blindly — a future regression there must
    // not be able to produce an unhandled rejection at startup.
    migrateIfNeededMock.mockRejectedValue(new Error('unexpected rejection'));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toMatch(/safe/i);
    expect(container.textContent).toContain('unexpected rejection');
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
    expect(container.textContent).not.toContain('No matters yet');
    expect(container.innerHTML.trim()).not.toBe('');
  });
});
