import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, Template } from './types';

// No @testing-library/react in this project — see Toast.test.tsx /
// App.documentRemoval.test.tsx for the precedent this follows: drive a real
// react-dom root directly, mocking App.tsx's repository/module boundaries.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- Repository mocks -------------------------------------------------

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

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', () => ({
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
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

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

vi.mock('./lib/openrouter', () => ({
  listModels: vi.fn().mockResolvedValue([]),
  isAuthError: () => false,
}));

// retryCell (the fix's finishing mechanism) calls extractClause under the
// hood — mocking it lets a retry be driven deterministically without a real
// network call, mirroring App.authRedirect.test.tsx's precedent.
const extractClauseMock = vi.fn();
vi.mock('./features/review/extractClause', () => ({
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
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

function makeTemplate(): Template {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [
      { id: 'c1', title: 'Governing Law', prompt: 'Extract the governing law clause.' },
      { id: 'c2', title: 'Term', prompt: 'Extract the term.' },
    ],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 2,
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

/** A review abandoned mid-run: neither `completedAt` nor `cancelledAt` is
 *  set, and its findings are a mix of `done`, `pending` and `running` —
 *  exactly what a 2-second debounced mid-run save leaves behind when the
 *  tab is closed before the run finishes (Important 1's whole scenario). */
function makeAbandonedReview(): Review {
  return {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: makeTemplate(),
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
        c2: { clauseId: 'c2', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] },
      },
    },
    modelId: 'test/model',
    startedAt: 1,
    createdByUserId: 'u1',
  };
}

describe('App — reopening an abandoned review (Important 1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeAbandonedReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  it('says plainly that the review was interrupted, rather than rendering no banner at all', async () => {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('interrupted');
    // The finished cell's real content is still there — this isn't a
    // screen-replacing error state, just an honest banner alongside it.
    expect(container.textContent).toContain('Governed by NY law.');
  });

  it('offers Retry on the stalled pending cell, and retrying it persists the result to the same matter', async () => {
    extractClauseMock.mockResolvedValue({
      clauseId: 'c2',
      status: 'done',
      citations: [{ quote: 'y', documentId: 'd1' }],
      summary: 'Term is 12 months.',
      verification: { state: 'unchecked' },
      notes: [],
    });

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    const retryButtons = Array.from(container.querySelectorAll('button'))
      .filter(b => /retry/i.test(b.textContent || ''));
    expect(retryButtons.length).toBeGreaterThan(0);

    act(() => { (retryButtons[0] as HTMLButtonElement).click(); });
    await flush();

    expect(extractClauseMock).toHaveBeenCalled();
    // Task 6A: `openReview` carries the stored review's `target` onto the
    // in-session `ReviewRun`, and `reviewFromRun` carries it back onto the
    // `Review` this retry persists — a review reopened without either leg
    // of that round trip would silently forget which kind of review it is.
    expect(saveReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', matterId: 'm1', target: { kind: 'documents', documentIds: ['d1'] } }),
    );
    expect(container.textContent).toContain('Term is 12 months.');
  });

  it('does NOT show the interrupted banner for a completed review', async () => {
    getReviewMock.mockResolvedValue({ ...makeAbandonedReview(), completedAt: 2 });
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).not.toContain('interrupted');
  });

  it('does NOT show the interrupted banner for a cancelled review', async () => {
    getReviewMock.mockResolvedValue({ ...makeAbandonedReview(), cancelledAt: 2 });
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).not.toContain('interrupted');
  });
});
