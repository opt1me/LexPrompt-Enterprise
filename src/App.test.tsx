import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DbBlockedError } from './lib/db/open';

const listPlaybooksMock = vi.fn();

// App.tsx talks to the playbook repository only through these named
// exports; mocking the module lets the mount effect's very first await
// reject deterministically, without needing a real (or fake) IndexedDB
// failure mode.
vi.mock('./lib/db/playbooks', () => ({
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

import App from './App';

async function flush() {
  // Two microtask turns: one for listPlaybooks()'s rejection to reach the
  // .catch, one for the resulting setState to flush through React.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App mount — playbook library load failure (Critical fix-round-1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    listPlaybooksMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('surfaces a DbBlockedError with its own explanatory message, never an empty library', async () => {
    listPlaybooksMock.mockRejectedValue(new DbBlockedError());
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('another tab');
    expect(container.textContent).not.toContain('No templates yet');
  });

  it('surfaces a generic load failure with a retry, never an empty library', async () => {
    listPlaybooksMock.mockRejectedValue(new Error('boom'));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('No templates yet');
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
  });

  it('retry re-fetches and clears the error once the library loads successfully', async () => {
    listPlaybooksMock.mockRejectedValueOnce(new Error('boom'));
    listPlaybooksMock.mockResolvedValueOnce([]);
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toContain('could not be loaded');

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { retryButton.click(); });
    await flush();

    expect(container.textContent).not.toContain('could not be loaded');
    expect(container.textContent).toContain('No templates yet');
    expect(listPlaybooksMock).toHaveBeenCalledTimes(2);
  });

  it('renders the library normally when the load succeeds', async () => {
    listPlaybooksMock.mockResolvedValue([]);
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('No templates yet');
    expect(container.textContent).not.toContain('could not be loaded');
  });
});
