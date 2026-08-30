import { ModelError } from '@lexprompt/core';
import React from 'react';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, DocumentRecord, PlaybookVersion } from './types';

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
const addDocumentMock = vi.fn();
const deleteMatterMock = vi.fn();
const getDocumentBlobMock = vi.fn();
const saveReviewMock = vi.fn();
const getProfileMock = vi.fn();

// TASK 18: A RUN IS THE SERVER'S, SO DELETING ITS MATTER IS A REQUEST.
//
// The debounced saver this file used to capture — and whose `dispose` it
// asserted on, because an armed timer would otherwise send a write it
// captured before the matter went — is gone. What has to be true now is the
// same thing in the new machinery: the POLL stops, the run is asked to
// stop, and nothing writes to the purged matter afterwards.
const startRunMock = vi.fn();
const cancelRunMock = vi.fn();
const getFindingsMock = vi.fn();
const stopWatchMock = vi.fn();
let emitRunEvent: ((event: unknown) => void) | null = null;

vi.mock('./lib/api/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/runs')>()),
  startRun: (...args: unknown[]) => startRunMock(...args),
  getRun: vi.fn(async () => ({ ...RUNNING_RUN, state: 'succeeded' as const, finishedAt: 9 })),
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  liveRunFor: vi.fn().mockResolvedValue(null),
  watchRun: (_runId: string, onEvent: (event: unknown) => void) => {
    emitRunEvent = onEvent;
    return stopWatchMock;
  },
}));

vi.mock('./lib/api/findings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/findings')>()),
  getFindings: (...args: unknown[]) => getFindingsMock(...args),
}));

const RUNNING_RUN = {
  id: 'run-1', reviewId: 'r-live', state: 'running' as const, requestedByUserId: 'u1',
  concurrency: 5, createdAt: 1,
  cells: { total: 1, queued: 0, leased: 1, done: 0, error: 0, cancelled: 0 },
  version: 1,
};


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
  deleteMatter: (...args: unknown[]) => deleteMatterMock(...args),
}));

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
  addDocument: (...args: unknown[]) => addDocumentMock(...args),
  deleteDocument: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({
  getDocumentBlob: (...args: unknown[]) => getDocumentBlobMock(...args),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: vi.fn(),
  saveReview: (...args: unknown[]) => saveReviewMock(...args),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  // See App.authoring.test.tsx's copy of this comment: keeps `useRole()`'s
  // App-level gate in its harmless `unknown` state for this file's purposes.
  getCachedRole: () => undefined,
}));

// Task 18: see App.authoring.test.tsx's copy of this comment — the model
// choice is fetched from the server now, not read from `localStorage`.
const getWorkspaceSettingsMock = vi.fn().mockResolvedValue({ modelChoiceId: '', concurrency: 5, version: 1, updatedAt: 1 });
vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: (...args: unknown[]) => getWorkspaceSettingsMock(...args),
  saveWorkspaceSettings: vi.fn(),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([TEST_ALLOWED_MODEL]),
  },
}));

// extractClause never resolves on its own in these tests — a run is
// started and left deliberately in flight so the matter can be deleted
// WHILE its debounced saver has real, unsent work — but it DOES reject with
// the same AbortError a real cancelled fetch would once the run's
// AbortController fires, so `runReview`'s own `.catch` path (and, from
// there, `persistFinal` — the exact call site Important 2's guard sits in
// front of) is actually reachable, the same as it would be for a genuine
// live run.
const extractClauseMock = vi.fn((..._args: unknown[]) => {
  // Index 5, not 4: `extractClause` takes its `ModelClient` first now
  // (Stage 3 Task 3), so every positional argument shifted by one. A mock
  // still reading index 4 would silently hold the SETTINGS object, whose
  // `addEventListener` is undefined — no type error, just a run that never
  // notices it was aborted.
  const signal = _args[5] as AbortSignal | undefined;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
});
// The extractors live in `@lexprompt/core` now (Stage 3 Task 3), so the
// mock target is the barrel — spread over `importOriginal` so every other
// core export stays REAL. Stubbing the whole package would silently
// replace `unchecked`, `findingsKeyFor` and the rest with undefined.
vi.mock('@lexprompt/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@lexprompt/core')>(),
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
}));

vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: PlaybookVersion[]; onRun: (t: PlaybookVersion) => void }) => (
    <div>
      {templates.map(t => (
        <button key={t.id} onClick={() => onRun(t)}>{`Run ${t.name}`}</button>
      ))}
    </div>
  ),
}));

vi.mock('./features/matters/MatterPickerModal', () => ({
  MatterPickerModal: ({ isOpen, onPick }: { isOpen: boolean; onPick: (matterId: string) => void }) => {
    React.useEffect(() => {
      if (isOpen) onPick('m1');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);
    return null;
  },
}));

vi.mock('./features/review/RunPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./features/review/RunPanel')>();
  return {
    ...actual,
    // Auto-runs with one fake document the instant it mounts, exactly like
    // App.authRedirect.test.tsx's stub — this is what "a run is now live"
    // means for this test file.
    RunPanel: ({ onRun }: { onRun: (docs: unknown[]) => void }) => {
      React.useEffect(() => {
        onRun([{ id: 'live-doc', name: 'live.txt', text: 'hello', file: new File(['hello'], 'live.txt'), kind: 'txt' }]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div>run-panel-stub</div>;
    },
  };
});

import App from './App';

async function flush(times = 8) {
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

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' }],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
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

describe('App — deleting a matter with a run in flight for it (Important 2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    getWorkspaceSettingsMock.mockReset().mockResolvedValue({
      modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1,
    });
    listPlaybooksMock.mockReset().mockResolvedValue([makeTemplate()]);
    listMattersMock.mockReset().mockResolvedValue([makeMatter()]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([makeDocumentRecord()]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    addDocumentMock.mockReset().mockResolvedValue(undefined);
    deleteMatterMock.mockReset().mockResolvedValue(undefined);
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockClear();
    emitRunEvent = null;
    stopWatchMock.mockClear();
    startRunMock.mockReset().mockImplementation(async (reviewId: string) =>
      ({ ...RUNNING_RUN, reviewId }));
    cancelRunMock.mockReset().mockResolvedValue({ ...RUNNING_RUN, state: 'cancelling' });
    getFindingsMock.mockReset().mockResolvedValue(
      { findings: {}, dispositionVersions: {}, version: 1 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  /** Drives the app to a live, matter-scoped run in flight for `m1`, via the
   *  Library + matter-picker path (proving I2's fix also covers a run
   *  started that way, not just Matter Home's). Returns once `run` is set
   *  and the debounced saver has already scheduled at least one save. */
  async function startLiveRunForM1() {
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(startRunMock).toHaveBeenCalled();
    expect(emitRunEvent, 'the run was never watched').not.toBeNull();
    expect(container.textContent).toContain('live.txt');
  }

  it('stops watching the run and asks the server to stop it, the moment its matter is deleted', async () => {
    await startLiveRunForM1();

    // Delete the matter the live run belongs to.
    clickNav(container, 'Matters');
    await flush();
    const deleteButton = container.querySelector('[title="Delete Matter"]') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();
    act(() => { deleteButton.click(); });
    await flush();
    clickByText(container, /^Confirm$/);
    await flush();

    expect(deleteMatterMock).toHaveBeenCalledWith('m1');
    // The poll for this exact run must be killed outright — not merely
    // prevented from applying what it reads. It would otherwise keep asking
    // about a review that has been deleted and answer 404 into a toast about
    // a matter the person has already been told is gone.
    expect(stopWatchMock, 'the poll kept running against a deleted matter s run')
      .toHaveBeenCalled();
    // …and the run itself is asked to stop, because the work is the
    // server's and nobody is coming back for it.
    expect(cancelRunMock).toHaveBeenCalledWith('run-1');
    // No live run left to point back to.
    expect(container.textContent).not.toContain('Current run');
  });

  it('never lets a late run event write to the purged matter (mutation target)', async () => {
    await startLiveRunForM1();
    const emit = emitRunEvent!;

    clickNav(container, 'Matters');
    await flush();
    const deleteButton = container.querySelector('[title="Delete Matter"]') as HTMLButtonElement;
    act(() => { deleteButton.click(); });
    await flush();
    clickByText(container, /^Confirm$/);
    await flush();

    // An event delivered after the delete — the poll's last read landing
    // late. Unsubscribing cannot make that impossible on its own, which is
    // why the write guards this test is really about still exist.
    saveReviewMock.mockClear();
    act(() => {
      emit({
        id: 9, type: 'run.finished', reviewId: 'r-live', runId: 'run-1', at: 9,
        payload: { runId: 'run-1', reviewId: 'r-live', state: 'succeeded', cells: 1, done: 1,
          errored: 0, cancelled: 0, version: 3 },
      });
    });
    await flush();

    // Nothing was written back to the matter that is gone.
    expect(saveReviewMock).not.toHaveBeenCalled();
  });
});
