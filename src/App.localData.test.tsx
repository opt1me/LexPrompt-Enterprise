import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { closeDb } from './lib/db/open';
import { seedLocal } from './test/seedLocalData';
import { markUploadComplete, forgetUploadComplete } from './lib/upload/uploaded';

/**
 * A browser that still holds a firm's data, opened against a server that
 * knows nothing about it.
 *
 * This is `CLAUDE.md`'s founding defect at its most likely moment. The
 * matters list comes back empty because the server has never seen these
 * matters, and every one of them is sitting in IndexedDB two feet away.
 * "No matters yet" over that is the failed migration rendering an empty
 * library, indistinguishable from a fresh install — and the person reading
 * it has no reason to look further.
 *
 * So the requirement is not "the uploader exists". It is that the app SAYS
 * SO, unprompted, on the first screen, without anybody having to find a
 * settings page.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: vi.fn().mockResolvedValue([]),
  getPlaybook: vi.fn(),
  getPlaybookContent: vi.fn().mockResolvedValue(null),
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

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

import App from './App';

/**
 * Yields to the MACROTASK queue, not just the microtask queue.
 *
 * `fake-indexeddb` settles its requests on real event-loop turns, so a flush
 * built out of `await Promise.resolve()` alone never lets a `getDb()` open —
 * let alone the seven counts behind it — finish. A test written that way
 * fails as "no banner", which reads as a defect in the banner.
 */
async function flush() {
  for (let i = 0; i < 12; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

describe('App — data still in this browser', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    closeDb();
    indexedDB.deleteDatabase('lexprompt');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
    forgetUploadComplete();
  });

  it('TELLS the reader their data is here, rather than showing them an empty library', async () => {
    await seedLocal({
      matters: [
        { id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 },
        { id: 'm2', name: 'Ashfield Mill', ownerId: 'local-abc', createdAt: 2, updatedAt: 2 },
      ],
    });
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('still stored in this browser');
    expect(container.textContent).toContain('have not been moved');
    // The empty state is still rendered underneath, and that is correct —
    // the server really does have no matters. What must never happen is that
    // being the ONLY thing on the screen.
    expect(container.textContent).toContain('No matters yet');
  });

  it('offers the way to move it, and going there lists the matters BY NAME', async () => {
    await seedLocal({
      matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 }],
    });
    act(() => { root.render(<App />); });
    await flush();

    const move = Array.from(container.querySelectorAll('button'))
      .find(b => /move it to the server/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(move).toBeTruthy();
    act(() => { move.click(); });
    await flush();

    expect(container.textContent).toContain('Brookvale Retail Park');
    expect(window.location.pathname).toBe('/upload-local-data');
  });

  it('says the copy is STILL HERE after a complete upload, rather than going quiet', async () => {
    // A banner that vanishes is a person who never learns the copy is still
    // in their browser.
    await seedLocal({
      matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 }],
    });
    markUploadComplete();
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('A copy is still in this browser');
    expect(container.textContent).not.toContain('have not been moved');
  });

  it('says so LOUDLY when the local database cannot be read at all', async () => {
    // The worst case: this browser may be holding every matter a firm has,
    // and the app cannot tell. Silence here is the app deciding, on no
    // evidence, that there is nothing to move.
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('site data is blocked in this browser');
    });
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('could not read the data stored in this browser');
    spy.mockRestore();
  });

  it('shows nothing at all when the browser is genuinely empty', async () => {
    // The paired positive. Without it, a banner that never rendered would
    // satisfy every "not.toContain" above.
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).not.toContain('still stored in this browser');
    expect(container.textContent).not.toContain('could not read the data stored in this browser');
    expect(container.textContent).toContain('No matters yet');
  });
});
