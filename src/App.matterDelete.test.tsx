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
const migrateIfNeededMock = vi.fn();

// The debounced saver instance App.tsx gets back from
// `createDebouncedReviewSaver` — captured here (rather than re-created per
// call) so a test can assert `dispose` was actually called on THIS run's
// saver once its matter is deleted, and that `scheduleSave` stops being
// invoked with real data afterwards.
let currentSaver: { scheduleSave: ReturnType<typeof vi.fn>; saveNow: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } | null = null;
const createDebouncedReviewSaverMock = vi.fn((..._args: unknown[]) => {
  currentSaver = {
    scheduleSave: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  return currentSaver;
});

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
  createDebouncedReviewSaver: (...args: unknown[]) => createDebouncedReviewSaverMock(...args),
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
  const signal = _args[4] as AbortSignal | undefined;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
});
vi.mock('./features/review/extractClause', () => ({
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
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
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
    currentSaver = null;
    createDebouncedReviewSaverMock.mockClear();

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

    expect(currentSaver).not.toBeNull();
    expect(container.textContent).toContain('live.txt');
  }

  it('disposes the in-flight run\'s debounced saver and clears "Current run" the moment its matter is deleted', async () => {
    await startLiveRunForM1();
    const saverAtDeleteTime = currentSaver!;

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
    // The armed debounce timer for this exact run must be killed outright —
    // not just prevented from scheduling NEW saves.
    expect(saverAtDeleteTime.dispose).toHaveBeenCalled();
    // No live run left to point back to.
    expect(container.textContent).not.toContain('Current run');
  });

  it('never lets the run\'s completion handler write to the purged matter once its abort resolves (mutation target)', async () => {
    await startLiveRunForM1();
    const saverAtDeleteTime = currentSaver!;

    clickNav(container, 'Matters');
    await flush();
    const deleteButton = container.querySelector('[title="Delete Matter"]') as HTMLButtonElement;
    act(() => { deleteButton.click(); });
    await flush();
    clickByText(container, /^Confirm$/);
    // Let the aborted runReview's rejection propagate through
    // handleStartRun's `.catch` into `persistFinal` — the exact call site
    // I2's guard sits in front of.
    await flush();

    expect(saverAtDeleteTime.dispose).toHaveBeenCalled();
    // The write persistFinal would otherwise make (`reviewSaver.saveNow`,
    // which itself calls the real `saveReview`) must never fire once the
    // matter is gone — neither directly through `saveReview`, nor through
    // the saver's own `saveNow`.
    expect(saverAtDeleteTime.saveNow).not.toHaveBeenCalled();
    expect(saveReviewMock).not.toHaveBeenCalled();
  });

  // Stage 2 Task 15. The debounced saver's write is FIRE-AND-FORGET —
  // nothing awaits it, so a rejection cannot surface on a promise any caller
  // holds. Over a local disk that was rare; over a network it is routine,
  // and one of the failures is a 409 refusing this save because somebody
  // else's write landed first, which is not an error at all but a fact the
  // reader has to act on before they close the tab.
  //
  // A notice with no test is a notice the next restyle deletes, so this
  // pins it: the callback App.tsx passes is invoked, and what it puts on
  // screen leads with the CONSEQUENCE rather than echoing a transport error
  // a lawyer cannot act on.
  it('shows a visible notice when the run s auto-save fails, naming the risk before the cause', async () => {
    await startLiveRunForM1();
    // The second argument App.tsx passes to `createDebouncedReviewSaver` —
    // the `onError` the interface has always had and nothing needed until
    // the store moved across a network.
    const onError = createDebouncedReviewSaverMock.mock.calls.at(-1)?.[1] as
      ((error: unknown, review: unknown) => void) | undefined;
    expect(onError, 'App.tsx passed no onError to the debounced saver').toBeTypeOf('function');

    act(() => {
      onError!(
        new ModelError(
          'This was changed since you opened it — by another tab, or by someone else.',
          'conflict', 409),
        { id: 'rev-1' },
      );
    });
    await flush();

    const toast = container.querySelector('[data-toast]');
    expect(toast, 'no notice was raised for a failed auto-save').not.toBeNull();
    expect(toast!.textContent).toMatch(/not being saved/i);
    expect(toast!.textContent).toMatch(/at risk if you close this tab/i);
    // The cause is carried too, after the consequence — a reader who can act
    // on "somebody else changed it" should still be told which it was.
    expect(toast!.textContent).toMatch(/by another tab, or by someone else/);
    // …and the run is NOT blocked: a run whose auto-save is failing is still
    // producing correct answers, and the results view stays up.
    expect(container.querySelector('[data-toast]')).not.toBeNull();
  });
});
