import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Template, Review, DocumentRecord } from './types';

// No @testing-library/react in this project — see Toast.test.tsx /
// App.test.tsx for the precedent this follows: drive a real react-dom root
// directly, mocking App.tsx's repository/module boundaries.
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
const getProfileMock = vi.fn();
const migrateIfNeededMock = vi.fn();

// App's startup migration gate (Task 14) runs before any of the mocks
// below are ever reached; mocking it keeps this file's mount sequence
// deterministic instead of depending on a real (fake-indexeddb) round
// trip. The migration's own three outcomes are covered separately in
// App.migration.test.tsx.
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
// settings.modelId-watching effect; stubbed out since it's unrelated to
// what these tests exercise.
vi.mock('./lib/openrouter', () => ({
  listModels: vi.fn().mockResolvedValue([]),
  isAuthError: () => false,
}));

// extractClause is runReview.ts's only external dependency (both are v1
// code this sub-project does not touch) — mocking it lets a "live" run be
// driven deterministically to an auth-rejected finding without a real
// network call or a real API key.
const extractClauseMock = vi.fn();
vi.mock('./features/review/extractClause', () => ({
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
}));

// Stubs for the two screens whose OWN rendering/upload mechanics are
// covered elsewhere (RunPanel.test.tsx; TemplateLibrary has no dedicated
// test file but its rendering is not what's under test here). This test
// file is about App.tsx's auth-error wiring specifically: does a live
// auth error redirect to Settings, and does a reopened review's stale one
// NOT. Fighting jsdom's file-input upload just to reach that assertion
// would test RunPanel's upload plumbing a second time, not this.
vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: Template[]; onRun: (t: Template) => void }) => (
    <div>
      {templates.map(t => (
        <button key={t.id} onClick={() => onRun(t)}>{`Run ${t.name}`}</button>
      ))}
    </div>
  ),
}));

vi.mock('./features/review/RunPanel', () => ({
  // Auto-runs with one fake document the instant it mounts — this is what
  // "a run is now live" means for this test file's purposes.
  RunPanel: ({ onRun }: { onRun: (docs: unknown[]) => void }) => {
    React.useEffect(() => {
      onRun([{ id: 'live-doc', name: 'live.txt', text: 'hello', file: new File(['hello'], 'live.txt'), kind: 'txt' }]);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>run-panel-stub</div>;
  },
  RunProgressBar: () => null,
  RunCancelledBanner: () => null,
  RunEmptyFindingsBanner: () => null,
  RunInterruptedBanner: () => null,
}));

// Important 3 (fix wave): running a playbook from the Library now opens a
// matter picker before it ever reaches RunPanel. That flow's own mechanics
// have dedicated coverage elsewhere; here it would only add steps to a file
// about auth-error wiring specifically, so it's stubbed to auto-pick a
// fixed matter id the instant it opens — mirroring how RunPanel above is
// stubbed to auto-run the instant IT mounts.
vi.mock('./features/matters/MatterPickerModal', () => ({
  MatterPickerModal: ({ isOpen, onPick }: { isOpen: boolean; onPick: (matterId: string) => void }) => {
    React.useEffect(() => {
      if (isOpen) onPick('m-picked');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);
    return null;
  },
}));

import App from './App';

async function flush(times = 6) {
  // Several microtask turns: extractClause's mocked promise, runReview's
  // internal await chain (mapWithConcurrency), the resulting onUpdate ->
  // setRun, and the auth-error effect it triggers, each need at least one.
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function clickNav(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find(b => new RegExp(`^${label}$`, 'i').test((b.textContent || '').trim()));
  if (!button) throw new Error(`No nav button found for "${label}"`);
  act(() => { (button as HTMLButtonElement).click(); });
}

function clickByText(container: HTMLDivElement, text: string | RegExp) {
  const re = typeof text === 'string' ? new RegExp(text) : text;
  const button = Array.from(container.querySelectorAll('button')).find(b => re.test(b.textContent || ''));
  if (!button) throw new Error(`No button found matching ${text}`);
  act(() => { (button as HTMLButtonElement).click(); });
}

const AUTH_TOAST = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';
const STALE_FINDING_ERROR = 'Your OpenRouter API key was rejected: User not found.';

function makePlaybook(): Template {
  return {
    id: 'p1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' }],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 2,
  };
}

function makeStaleReview(): Review {
  return {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: makePlaybook(),
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: {
      d1: {
        c1: { clauseId: 'c1', status: 'error', citations: [], error: STALE_FINDING_ERROR, authError: true, verification: { state: 'unchecked' }, notes: [] },
      },
    },
    modelId: 'test/model',
    startedAt: 1,
    completedAt: 2,
    createdByUserId: 'u1',
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

describe('App — auth-error redirect vs. a reopened review\'s stale authError finding (Task 11 fix round 1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset();
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset();
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset();
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

  it('opening a review whose only finding already has authError (from its original run) does NOT redirect to Settings, and its findings still render', async () => {
    getMatterMock.mockResolvedValue({ id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 });
    getReviewMock.mockResolvedValue(makeStaleReview());
    getDocumentMock.mockResolvedValue(makeDocumentRecord());

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    // The historical finding's own error text is real work and must still
    // be visible...
    expect(container.textContent).toContain(STALE_FINDING_ERROR);
    // ...but it must NOT have been (mis)treated as a fresh rejection: no
    // redirect to Settings, no "your key was rejected" toast.
    expect(container.textContent).not.toContain('Connect an OpenRouter account');
    expect(container.textContent).not.toContain(AUTH_TOAST);
  });

  it('a genuine live 401 while a run is in flight still redirects to Settings', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockResolvedValue({
      clauseId: 'c1', status: 'error', citations: [], error: STALE_FINDING_ERROR, authError: true,
    });

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain('Connect an OpenRouter account');
    expect(container.textContent).toContain(AUTH_TOAST);
  });

  it('does not let a reopened review\'s already-handled authError silence a genuinely new one from a later run', async () => {
    // First: open the stale review (as in the first test) — this is what
    // sets the "already handled" guard.
    getMatterMock.mockResolvedValue({ id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 });
    getReviewMock.mockResolvedValue(makeStaleReview());
    getDocumentMock.mockResolvedValue(makeDocumentRecord());
    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).not.toContain('Connect an OpenRouter account'); // sanity: guard is armed

    // Then: start a brand new run (Library flow) whose own live call also
    // gets rejected. Despite the earlier suppression, THIS rejection must
    // still redirect — proving the guard resets between runs rather than
    // permanently silencing every future auth error for the rest of the
    // session.
    extractClauseMock.mockResolvedValue({
      clauseId: 'c1', status: 'error', citations: [], error: STALE_FINDING_ERROR, authError: true,
    });
    clickNav(container, 'Library');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain('Connect an OpenRouter account');
    expect(container.textContent).toContain(AUTH_TOAST);
  });
});
