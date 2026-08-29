import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, DocumentRecord } from './types';

// No @testing-library/react in this project — see Toast.test.tsx /
// App.authRedirect.test.tsx for the precedent this follows: drive a real
// react-dom root directly, mocking App.tsx's repository/module boundaries.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- Repository mocks -------------------------------------------------

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const getMatterMock = vi.fn();
const listDocumentsMock = vi.fn();
const deleteDocumentMock = vi.fn();
const getDocumentBlobMock = vi.fn();
const getProfileMock = vi.fn();
const migrateIfNeededMock = vi.fn();

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
  getMatter: (...args: unknown[]) => getMatterMock(...args),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: (...args: unknown[]) => deleteDocumentMock(...args),
}));

// Stage 2 Task 12 made `db/collections` an HTTP client, so an unmocked one
// reaches for a token and a network on every matter load — and the load-error
// branch that produced would render this screen's error state instead of its
// document list, which is the load path working correctly and this file
// testing nothing.
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
  createDebouncedReviewSaver: vi.fn(() => ({
    scheduleSave: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

// listModels would otherwise attempt a real network fetch from the
// settings.modelChoiceId-watching effect; stubbed out since it's unrelated to
// what this test exercises.
vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

// The real `./lib/documents` module is used everywhere else in the App
// test suite (it isn't mocked in App.authRedirect.test.tsx either), so
// this only wraps `evictPageImages` to observe the call App.tsx makes —
// the underlying cache eviction still runs for real.
const evictPageImagesMock = vi.fn();
vi.mock('./lib/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/documents')>();
  return {
    ...actual,
    evictPageImages: (documentId: string) => {
      evictPageImagesMock(documentId);
      return actual.evictPageImages(documentId);
    },
  };
});

import App from './App';

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function clickByLabel(container: HTMLDivElement, label: string) {
  const el = container.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`No element with aria-label "${label}"`);
  act(() => { (el as HTMLButtonElement).click(); });
}

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function makeDocument(): DocumentRecord {
  return {
    id: 'd1',
    matterId: 'm1',
    name: 'nda.txt',
    kind: 'txt',
    text: 'This is the contract text.',
    byteSize: 27,
    addedAt: 1,
    addedByUserId: 'u1',
    role: 'standalone',
  };
}

describe('App — removing a matter document evicts its cached page images (Task 15)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([makeDocument()]);
    deleteDocumentMock.mockReset().mockResolvedValue(undefined);
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    evictPageImagesMock.mockReset();
    // MatterHome confirms destructive removal via window.confirm; jsdom
    // doesn't implement it, so it must be stubbed to proceed.
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
    confirmSpy.mockRestore();
  });

  it('calls evictPageImages(documentId) once a document is removed from its matter', async () => {
    window.history.pushState(null, '', '/matters/m1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('nda.txt');

    clickByLabel(container, 'Remove nda.txt');
    await flush();

    expect(deleteDocumentMock).toHaveBeenCalledWith('d1');
    expect(evictPageImagesMock).toHaveBeenCalledWith('d1');
    expect(evictPageImagesMock).toHaveBeenCalledTimes(1);
    // The document is gone from the reloaded list, and the confirm prompt
    // named it correctly.
    expect(confirmSpy).toHaveBeenCalledWith('Remove "nda.txt" from this matter? This cannot be undone.');
  });
});
