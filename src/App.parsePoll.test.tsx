import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, DocumentRecord } from './types';

/**
 * "READING…" — THE THIRD LOAD STATE, AT INGEST (§11, Stage 3 Task 24).
 *
 * An upload returns before the text exists: the bytes are stored, the row is
 * `parse_state = 'pending'` with an empty `text`, and a parse worker reads
 * them a moment later. Two things follow, and this file is about the first:
 *
 *  1. **The screen has to notice when it finishes.** Without a poll the
 *     matter says "Still being read" until somebody reloads the page, and a
 *     document that has been ready for ten minutes stays un-reviewable on
 *     screen. That is a screen which has quietly stopped updating — the same
 *     failure as a run that stops reporting, one screen earlier.
 *  2. **It must not poll forever.** A tab left open on a matter overnight
 *     must not talk to the server all night, so the poll is armed by a
 *     `pending` document being on screen and disarms the moment none is.
 *
 * Driven with fake timers rather than by waiting, so "it stopped" is an
 * assertion rather than a hope: the clock is advanced well past several
 * intervals and the call count is asserted to be unchanged.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const getMatterMock = vi.fn();
const listDocumentsMock = vi.fn();
const reparseDocumentMock = vi.fn();
const getDocumentBlobMock = vi.fn();
const getProfileMock = vi.fn();

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: vi.fn(),
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
  getMatter: (...args: unknown[]) => getMatterMock(...args),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  setDocumentRole: vi.fn(),
  reparseDocument: (...args: unknown[]) => reparseDocumentMock(...args),
}));

// See `App.documentRemoval.test.tsx`'s copy of this note: an unmocked
// collections client reaches for a token on every matter load, and the
// load-error branch that produces would render this screen's error state
// instead of its document list.
vi.mock('./lib/db/collections', () => ({
  listCollections: async () => [],
  getCollection: async () => null,
  saveCollection: vi.fn(),
  deleteCollection: vi.fn(),
  newCollection: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({
  getDocumentBlob: (...args: unknown[]) => getDocumentBlobMock(...args),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: vi.fn(),
  saveReview: vi.fn().mockResolvedValue(undefined),
  importReview: vi.fn(),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  getCachedRole: () => undefined,
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

import App from './App';

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

/** Advances the fake clock and lets everything it started settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await flush();
}

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function doc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'd1',
    matterId: 'm1',
    name: 'lease.pdf',
    kind: 'pdf',
    text: '[Page 1]\nThe term is ten years from 1 January 2020.',
    byteSize: 27,
    addedAt: 1,
    addedByUserId: 'u1',
    role: 'standalone',
    ...over,
  };
}

const reading = () => doc({ parseState: 'pending', text: '' });
const read = () => doc({ parseState: 'parsed' });
const failed = () => doc({
  parseState: 'failed', text: '', parseError: 'lease.pdf took longer than 180000ms to read.',
});

describe('App — a document being read is followed until it is', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset();
    reparseDocumentMock.mockReset();
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
    vi.useRealTimers();
  });

  async function openMatter(): Promise<void> {
    window.history.pushState(null, '', '/matters/m1');
    act(() => { root.render(<App />); });
    await flush();
  }

  it('re-reads the list while a document is pending, and STOPS once none is', async () => {
    listDocumentsMock
      .mockResolvedValueOnce([reading()])
      .mockResolvedValueOnce([reading()])
      .mockResolvedValue([read()]);

    await openMatter();
    expect(container.textContent).toContain('Still being read');
    const afterOpen = listDocumentsMock.mock.calls.length;
    expect(afterOpen).toBeGreaterThan(0);

    // Two more polls: still pending after the first, parsed after the second.
    await tick(1_100);
    await tick(1_100);
    expect(listDocumentsMock.mock.calls.length).toBeGreaterThan(afterOpen);
    expect(container.textContent).not.toContain('Still being read');

    // AND THEN IT STOPS. Ten seconds is ten intervals; a poll that kept
    // running would show it here rather than in somebody's network tab
    // tomorrow morning.
    const settled = listDocumentsMock.mock.calls.length;
    await tick(10_000);
    expect(listDocumentsMock.mock.calls.length, 'the poll never stopped').toBe(settled);
  });

  it('does not poll at all for a matter whose documents are all read', async () => {
    // The other half: the poll is armed by a `pending` document, not by the
    // screen being open. Without this, "it stops" above could be passing
    // because it never started.
    listDocumentsMock.mockResolvedValue([read()]);
    await openMatter();
    const afterOpen = listDocumentsMock.mock.calls.length;
    await tick(10_000);
    expect(listDocumentsMock.mock.calls.length).toBe(afterOpen);
  });

  it('follows a FAILED read too — it stops, and the failure stays on screen', async () => {
    // A parse that fails is terminal until somebody asks for it again, so
    // the poll must disarm on `failed` exactly as it does on `parsed`. A
    // poll that only recognised `parsed` would spin forever over an
    // unreadable document, which is the failure this whole file is about
    // wearing the opposite clothes.
    listDocumentsMock
      .mockResolvedValueOnce([reading()])
      .mockResolvedValue([failed()]);

    await openMatter();
    await tick(1_100);
    expect(container.textContent).toContain('Unreadable');
    const settled = listDocumentsMock.mock.calls.length;
    await tick(10_000);
    expect(listDocumentsMock.mock.calls.length, 'the poll never stopped').toBe(settled);
  });

  it('asks for a failed document to be read again, and follows it back to pending', async () => {
    listDocumentsMock.mockResolvedValue([failed()]);
    reparseDocumentMock.mockResolvedValue(reading());
    await openMatter();

    // The re-read is requested, the list is re-read only AFTER the store
    // confirms (`await-then-apply`), and the poll picks the document up
    // again from `pending`.
    listDocumentsMock.mockResolvedValue([reading()]);
    const button = Array.from(container.querySelectorAll('button'))
      .find(b => /read it again/i.test(b.textContent || ''));
    expect(button, 'a failed document offered no way to recover').toBeTruthy();
    await act(async () => { button!.click(); });
    await flush();

    expect(reparseDocumentMock).toHaveBeenCalledWith('d1');
    expect(container.textContent).toContain('Still being read');
    const afterClick = listDocumentsMock.mock.calls.length;
    await tick(1_100);
    expect(listDocumentsMock.mock.calls.length).toBeGreaterThan(afterClick);
  });
});
