import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, DocumentRecord, PlaybookVersion } from './types';

// No @testing-library/react in this project — see App.interrupted.test.tsx,
// which this file's mock setup mirrors closely (same module boundaries,
// same repository shape), for a reopened review that also needs a
// `playbookVersions.getVersion` mock this task adds.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const getMatterMock = vi.fn();
const listDocumentsMock = vi.fn();
const getDocumentMock = vi.fn();
const getDocumentBlobMock = vi.fn();
const getReviewMock = vi.fn();
const saveReviewMock = vi.fn();
const getProfileMock = vi.fn();
const migrateIfNeededMock = vi.fn();
const getVersionMock = vi.fn();
const listVersionsMock = vi.fn();

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
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
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({
  getDocumentBlob: (...args: unknown[]) => getDocumentBlobMock(...args),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: (...args: unknown[]) => getReviewMock(...args),
  saveReview: (...args: unknown[]) => saveReviewMock(...args),
  createDebouncedReviewSaver: vi.fn(() => ({
    scheduleSave: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

// Task 10: the results header resolves `Review.playbookVersionId` against
// the LIVE playbookVersions store (R-D15) — `getVersion` is new here.
vi.mock('./lib/db/playbookVersions', () => ({
  getVersion: (...args: unknown[]) => getVersionMock(...args),
  listVersions: (...args: unknown[]) => listVersionsMock(...args),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  // See App.authoring.test.tsx's copy of this comment: keeps `useRole()`'s
  // App-level gate in its harmless `unknown` state for this file's purposes.
  getCachedRole: () => undefined,
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

import App from './App';

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function makeVersion(): PlaybookVersion {
  return {
    id: 'v1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [
      { id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' },
    ],
    playbookId: 'pb1',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: 'u1',
    schemaVersion: 6,
  };
}

function makeDocumentRecord(): DocumentRecord {
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

function makeReview(playbookVersionId: string | undefined): Record<string, unknown> {
  const r: Record<string, unknown> = {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: makeVersion(),
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: {
      d1: {
        c1: {
          clauseId: 'c1',
          status: 'done',
          citations: [{ quote: 'x', documentId: 'd1' }],
          summary: 'Governed by NY law.',
          verification: { state: 'unchecked' },
          notes: [],
        },
      },
    },
    modelId: 'test/model',
    startedAt: 1,
    completedAt: 2,
    createdByUserId: 'u1',
  };
  if (playbookVersionId !== undefined) r.playbookVersionId = playbookVersionId;
  return r;
}

describe('App — the review header names the version this run ran against (Task 10 / R-D15)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listVersionsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(new Blob(['This is the contract text.'], { type: 'text/plain' }));
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    getVersionMock.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  it('says which version once the id resolves against the live store', async () => {
    getReviewMock.mockResolvedValue(makeReview('v1'));
    getVersionMock.mockResolvedValue(makeVersion());
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(getVersionMock).toHaveBeenCalledWith('v1');
    expect(container.textContent).toMatch(/ran against v1/i);
  });

  // R-D15's dangling case: the id is present but Task 3's playbook-delete
  // cascade already removed the version it names. "deleted" is a different
  // fact from "never recorded" (below), and only it explains why Version
  // History has nowhere to send the reader.
  it('says the version was deleted, never a raw claim, when the id no longer resolves', async () => {
    getReviewMock.mockResolvedValue(makeReview('v-gone'));
    getVersionMock.mockResolvedValue(null);
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toMatch(/deleted|no longer exists/i);
    expect(container.textContent).not.toMatch(/ran against v/i);
  });

  it('says the version is not recorded when the review never had one', async () => {
    getReviewMock.mockResolvedValue(makeReview(undefined));
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(getVersionMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/predates playbook versioning|does not record which version/i);
  });

  // The fix this batch adds: a `getVersion` that THROWS (a DB read failure,
  // not a successful lookup finding nothing) used to leave `resolvedVersion`
  // as `undefined` — the same value the "not resolved yet" loading state
  // uses — so `ResultsView` rendered the header line as if it had nothing to
  // report. That is indistinguishable from "no version recorded" to the
  // reader, and worse than the "deleted" case: it says nothing went wrong at
  // all. This must now render its own loud line, distinct from both silence
  // and "deleted".
  it('says the lookup itself failed, not nothing at all, when getVersion throws', async () => {
    getReviewMock.mockResolvedValue(makeReview('v1'));
    getVersionMock.mockRejectedValue(new Error('indexeddb read failed'));
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(getVersionMock).toHaveBeenCalledWith('v1');
    expect(container.textContent).toMatch(/could not check|could not be (checked|loaded|read)/i);
    expect(container.textContent).not.toMatch(/ran against v/i);
    expect(container.textContent).not.toMatch(/deleted|no longer exists/i);
  });
});
