import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, PlaybookVersion, TrailStep } from './types';
import { ModelError, unconfirmedPosition } from '@lexprompt/core';
import { flushUntil } from './test/mount';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';

// No @testing-library/react in this project — see App.interrupted.test.tsx /
// App.reviewSaveError.test.tsx for the precedent this follows: drive a real
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
}));

// --- The RUN, which is the server's now (Task 18) ---------------------
//
// `runReview` is gone: the browser POSTs a run, watches its events and
// re-reads the findings map. These four mocks are that seam. `isRunOver`
// and the rest of the module come from `importOriginal`, so a predicate the
// app depends on is not quietly reimplemented in a test file.
const startRunMock = vi.fn();
const getRunMock = vi.fn();
const cancelRunMock = vi.fn();
const liveRunForMock = vi.fn();
const stopWatchMock = vi.fn();
/** The `onEvent` handed to the current `watchRun`, so a test can deliver an
 *  event the way the server does. */
let emitRunEvent: ((event: unknown) => void) | null = null;
const watchRunMock = vi.fn((
  _runId: string, onEvent: (event: unknown) => void,
) => {
  emitRunEvent = onEvent;
  return stopWatchMock;
});

vi.mock('./lib/api/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/runs')>()),
  startRun: (...args: unknown[]) => startRunMock(...args),
  getRun: (...args: unknown[]) => getRunMock(...args),
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  liveRunFor: (...args: unknown[]) => liveRunForMock(...args),
  watchRun: (...args: unknown[]) => (watchRunMock as unknown as (...a: unknown[]) => () => void)(...args),
}));

const getFindingsMock = vi.fn();
// TASK 19: A VERIFICATION, A NOTE AND A NET POSITION ARE EACH THEIR OWN
// WRITE, to their own row. The seam these tests drive moved from
// `saveReview` — a read-modify-write over the whole review — to these three
// calls. Every assertion about WHAT is written, and about the UI not showing
// what the store refused, is the same one.
const setDispositionMock = vi.fn();
const addNoteMock = vi.fn();
const setNetPositionMock = vi.fn();

vi.mock('./lib/api/findings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/findings')>()),
  getFindings: (...args: unknown[]) => getFindingsMock(...args),
  setDisposition: (...args: unknown[]) => setDispositionMock(...args),
  addNote: (...args: unknown[]) => addNoteMock(...args),
  setNetPosition: (...args: unknown[]) => setNetPositionMock(...args),
}));

/** The server's answer to a disposition write: the row it stored. The actor
 *  and the instant are ITS, which is the whole point of the route. */
function serverDisposition(over: Record<string, unknown> = {}): void {
  setDispositionMock.mockImplementation(async (
    _reviewId: string, findingsKey: string, clauseId: string,
    change: { state: string; reason?: string },
  ) => ({
    disposition: {
      reviewId: 'r1', findingsKey, clauseId, state: change.state,
      ...(change.reason ? { reason: change.reason } : {}),
      byUserId: 'u1', at: 1_700_000_000_000, changedCount: 1, version: 2, ...over,
    },
    event: {
      id: 1, fromState: 'unchecked', toState: change.state, cause: 'human',
      byUserId: 'u1', at: 1_700_000_000_000,
    },
  }));
}

const RUNNING_RUN = {
  id: 'run-1', reviewId: 'r-live', state: 'running' as const, requestedByUserId: 'u1',
  concurrency: 5, createdAt: 1,
  cells: { total: 2, queued: 1, leased: 1, done: 0, error: 0, cancelled: 0 },
  version: 1,
};

/** What `GET /v1/reviews/:id/findings` answers next. */
function serverFindings(findings: unknown): void {
  getFindingsMock.mockResolvedValue({ findings, dispositionVersions: {}, version: 1 });
}

/** Resets every run-seam mock to a working default. Called from each
 *  `beforeEach` that drives a live run. */
function resetRunMocks(): void {
  emitRunEvent = null;
  stopWatchMock.mockClear();
  watchRunMock.mockClear();
  startRunMock.mockReset().mockImplementation(async (reviewId: string) =>
    ({ ...RUNNING_RUN, reviewId }));
  getRunMock.mockReset().mockResolvedValue({ ...RUNNING_RUN, state: 'succeeded', finishedAt: 5 });
  cancelRunMock.mockReset().mockResolvedValue({ ...RUNNING_RUN, state: 'cancelling' });
  liveRunForMock.mockReset().mockResolvedValue(null);
  getFindingsMock.mockReset();
  serverFindings({});
  setDispositionMock.mockReset();
  serverDisposition();
  addNoteMock.mockReset().mockImplementation(async (
    _reviewId: string, findingsKey: string, clauseId: string, text: string,
  ) => ({ id: 'note-1', findingId: `${findingsKey}::${clauseId}`, text, byUserId: 'u1', at: 5 }));
  setNetPositionMock.mockReset();
}

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

const extractClauseMock = vi.fn();
// The extractors live in `@lexprompt/core` now (Stage 3 Task 3), so the
// mock target is the barrel — spread over `importOriginal` so every other
// core export stays REAL. Stubbing the whole package would silently
// replace `unchecked`, `findingsKeyFor` and the rest with undefined.
vi.mock('@lexprompt/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@lexprompt/core')>(),
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
}));

// Only exercised by the live-run test at the bottom of this file — drives a
// run without a real file upload, mirroring App.reviewSaveError.test.tsx.
vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: PlaybookVersion[]; onRun: (t: PlaybookVersion) => void }) => (
    <div>{templates.map(t => <button key={t.id} onClick={() => onRun(t)}>{`Run ${t.name}`}</button>)}</div>
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

/**
 * Drives a run from the Library, through the matter picker and the stubbed
 * `RunPanel`, to the point where `watchRun` has been armed.
 *
 * Everything after the click is the SERVER's: `startRun` answers a running
 * run, the browser watches it, and each event below makes the browser
 * re-read the findings map. There is no `runReview` to resolve any more.
 */
async function startLiveRun(container: HTMLDivElement, root: Root): Promise<void> {
  act(() => { root.render(<App />); });
  await flush();
  act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
  await flush();
  act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
  await flush();
  if (!emitRunEvent) throw new Error('the run was never watched — `startRun` or `attachRun` failed');
}

/** One cell finished, as the server says it. */
async function emitFindingDone(clauseId = 'c1'): Promise<void> {
  const emit = emitRunEvent;
  if (!emit) throw new Error('nothing is watching this run');
  act(() => {
    emit({
      id: 1, type: 'finding.done', reviewId: 'r-live', runId: 'run-1', at: 1,
      payload: { runId: 'run-1', reviewId: 'r-live', findingsKey: 'live-doc', clauseId, version: 2 },
    });
  });
  await flush();
}

/** The run ended. `getRunMock` decides HOW. */
async function emitRunFinished(): Promise<void> {
  const emit = emitRunEvent;
  if (!emit) throw new Error('nothing is watching this run');
  act(() => {
    emit({
      id: 9, type: 'run.finished', reviewId: 'r-live', runId: 'run-1', at: 9,
      payload: { runId: 'run-1', reviewId: 'r-live', state: 'succeeded', cells: 2, done: 2,
        errored: 0, cancelled: 0, version: 3 },
    });
  });
  await flush();
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLDivElement, re: RegExp, index = 0): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll('button')).filter(b => re.test((b.textContent || '').trim()));
  const button = matches[index];
  if (!button) throw new Error(`No button [${index}] found matching ${re}`);
  return button as HTMLButtonElement;
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
    clauses: [
      { id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' },
      { id: 'c2', title: 'Term', extractPrompt: 'Extract the term.' },
    ],
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

/** A completed review with two done findings, both unverified and note-free
 *  — the base case every test below starts from and mutates. */
function makeReview(): Review {
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
        c2: {
          clauseId: 'c2',
          status: 'done',
          citations: [{ quote: 'y', documentId: 'd1' }],
          summary: 'Term is 12 months.',
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
}

const TRAIL: TrailStep[] = [
  { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
];

/** Same shape as `makeReview()`, but c1's finding also carries an
 *  unconfirmed net position — the case sub-project C's `handleConfirmNetPosition`
 *  / `handleAmendNetPosition` (Task 8) act on. A standalone-document review
 *  never actually produces one (only `extractCollectionClause` does), but
 *  App.tsx's own persistence plumbing for it is target-agnostic — it reads
 *  and writes whatever `Finding.netPosition` it's given — so this fixture
 *  exercises that plumbing directly without needing a full collection-review
 *  rig. */
function makeReviewWithNetPosition(): Review {
  const review = makeReview();
  return {
    ...review,
    findings: {
      d1: {
        ...review.findings.d1,
        c1: {
          ...review.findings.d1.c1,
          netPosition: unconfirmedPosition('Notice is now 6 months.', TRAIL),
        },
      },
    },
  };
}

describe('App — persisting a net position (Task 8)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeReviewWithNetPosition());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockReset();
    resetRunMocks();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  async function openReview() {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    // Waits for the load to SETTLE rather than for a fixed tick count — see
    // `flushUntil` for why counting ticks here was wrong.
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading',
    );
  }

  it('confirms a net position and shows it only after the write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    setNetPositionMock.mockImplementation(() => new Promise(resolve => {
      resolveWrite = () => resolve({
        netPosition: {
          proposed: 'Notice is now 6 months.', state: 'confirmed',
          byUserId: 'u1', at: 1_700_000_000_000, trail: TRAIL,
        },
        version: 2,
      });
    }));

    await openReview();

    expect(container.textContent).toMatch(/unconfirmed/i);

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    // The write is in flight — the badge must NOT have flipped yet
    // (await-then-apply).
    expect(setNetPositionMock).toHaveBeenCalled();
    // The ACTION, never a `NetPosition`: `confirmPosition` runs on the
    // server, over what is stored, with the actor and the instant it knows.
    expect(setNetPositionMock.mock.calls[0][3]).toEqual({ action: 'confirm' });
    expect(container.textContent).toMatch(/unconfirmed/i);

    resolveWrite!();
    await flush();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);
  });

  it('does not show a confirmation the store rejected, and says so', async () => {
    setNetPositionMock.mockRejectedValue(new Error('Storage quota exceeded'));

    await openReview();

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    expect(container.textContent).toMatch(/unconfirmed/i);
    expect(container.textContent).toContain('Storage quota exceeded');
  });

  it('shows the actor and the instant the SERVER recorded, and asks for neither itself', async () => {
    // Was "records the local profile id and a timestamp against the
    // confirmation". Both are the server's now, and the browser cannot
    // state either: a body that could would let a client put somebody
    // else's name on a confirmation. What the browser does with them is
    // unchanged — it renders what the store took.
    setNetPositionMock.mockResolvedValue({
      netPosition: {
        proposed: 'Notice is now 6 months.', state: 'confirmed',
        byUserId: 'u42', at: 1_700_000_123_000, trail: TRAIL,
      },
      version: 2,
    });

    await openReview();
    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    // Nothing about the actor or the instant was sent.
    expect(setNetPositionMock.mock.calls[0][3]).toEqual({ action: 'confirm' });
    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);
  });

  it('amends a net position with the human\'s text, marked stronger than a plain confirmation', async () => {
    setNetPositionMock.mockResolvedValue({
      netPosition: {
        proposed: 'Notice is now 6 months.', amended: 'Notice is actually 3 months.',
        state: 'confirmed', byUserId: 'u1', at: 1_700_000_000_000, trail: TRAIL,
      },
      version: 2,
    });
    await openReview();

    act(() => { findButton(container, /^Amend$/, 0).click(); });
    await flush();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(textarea, 'Notice is actually 3 months.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { findButton(container, /confirm amendment/i, 0).click(); });
    await flush();

    // The ACTION and the person's words, never a `NetPosition`. `amendPosition`
    // runs on the server, over what is stored — which is what makes "state:
    // confirmed, byUserId: someone" impossible for a client to assert.
    expect(setNetPositionMock.mock.calls[0][3])
      .toEqual({ action: 'amend', text: 'Notice is actually 3 months.' });
    expect(container.textContent).toContain('Notice is actually 3 months.');
    expect(container.textContent).toMatch(/amended/i);
  });

  // Mutation test 3 (task-8-brief step 3): dropping `carryHumanState`'s
  // net-position awareness must make this fail.
  //
  // TASK 18 MOVED THE SEAM AND NOT THE CLAIM. The "next update from a live
  // run" used to be `runReview`'s own `onUpdate`; it is now a `finding.done`
  // event from the server followed by a re-read of the findings map, which
  // knows nothing about a confirmation this browser has just made. The
  // assertions below are unchanged.
  it('does not lose a net position confirmation to the next update from a live run', async () => {
    const withPosition = {
      clauseId: 'c1', status: 'done' as const, citations: [], summary: 'irrelevant',
      verification: { state: 'unchecked' as const }, notes: [],
      netPosition: unconfirmedPosition('Notice is now 6 months.', TRAIL),
    };
    const pendingC2 = {
      clauseId: 'c2', status: 'pending' as const, citations: [],
      verification: { state: 'unchecked' as const }, notes: [],
    };

    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    serverFindings({ 'live-doc': { c1: withPosition, c2: pendingC2 } });

    setNetPositionMock.mockResolvedValue({
      netPosition: {
        proposed: 'Notice is now 6 months.', state: 'confirmed',
        byUserId: 'u1', at: 1_700_000_000_000, trail: TRAIL,
      },
      version: 2,
    });

    await startLiveRun(container, root);
    await emitFindingDone();

    expect(container.textContent).toMatch(/unconfirmed/i);

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);

    // c2 finishes. The server's findings map still carries c1's position as
    // UNCONFIRMED — the confirmation is this browser's, and until Task 19 it
    // reaches the store through the review record rather than the findings
    // rows. Without `carryHumanState` knowing about `netPosition`, this
    // re-read would silently overwrite the confirmation.
    serverFindings({
      'live-doc': { c1: withPosition, c2: { ...pendingC2, status: 'done', summary: 'irrelevant' } },
    });
    await emitFindingDone();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);
  });
});

describe('App — persisting a verification (Task 10, spec section 9)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockReset();
    resetRunMocks();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  async function openReview() {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    // Waits for the load to SETTLE rather than for a fixed tick count — see
    // `flushUntil` for why counting ticks here was wrong.
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading',
    );
  }

  it('persists a verification and shows it only after the write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    setDispositionMock.mockImplementation(() => new Promise(resolve => {
      resolveWrite = () => resolve({
        disposition: {
          reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', state: 'verified',
          byUserId: 'u1', at: 1_700_000_000_000, changedCount: 1, version: 2,
        },
        event: {
          id: 1, fromState: 'unchecked', toState: 'verified', cause: 'human',
          byUserId: 'u1', at: 1_700_000_000_000,
        },
      });
    }));

    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    // Two done findings, both unverified before anything happens.
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // The write is in flight — the chip must NOT have flipped to Verified
    // yet (await-then-apply).
    expect(setDispositionMock).toHaveBeenCalled();
    expect(setDispositionMock.mock.calls[0].slice(0, 3)).toEqual(['r1', 'd1', 'c1']);
    expect(setDispositionMock.mock.calls[0][3]).toEqual({ state: 'verified' });
    expect(chips()[0].textContent).toBe('Unverified');

    resolveWrite!();
    await flush();

    expect(chips()[0].textContent).toBe('Verified');
  });

  it('does not show a verification the store rejected, and says so', async () => {
    setDispositionMock.mockRejectedValue(new Error('Storage quota exceeded'));

    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    const chips = Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips[0].textContent).toBe('Unverified');
    expect(container.textContent).toContain('Storage quota exceeded');
  });

  it('REFUSES a stale write with a sentence that says what to do, never a silent retry', async () => {
    // Was "Task 16: a getProfile() failure refuses the verification". That
    // await is GONE — the server knows who is asking — and with it one of
    // the five unhandled-rejection sites Stage 2's Task 16 found among
    // exactly these call sites.
    //
    // What replaces it is the refusal P25 is about: the row moved on, so
    // applying this write would overwrite a judgement nobody has seen. It
    // must not be softened into a retry, and the chip must not flip.
    setDispositionMock.mockRejectedValue(
      new ModelError('This was changed since you opened it.', 'conflict', 409));

    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    const chips = Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips[0].textContent).toBe('Unverified');
    expect(container.textContent).toContain('Reload the review and try again');
    // Once. A refusal that retried itself would be the silent overwrite
    // this refusal exists to prevent, arriving a second later.
    expect(setDispositionMock).toHaveBeenCalledTimes(1);
  });

  it('shows the actor and the instant the SERVER recorded, and states neither itself', async () => {
    // Was "records the local profile id and a timestamp against the
    // verification". `getProfile()` is gone from this path: the server knows
    // who is asking and REFUSES a body that says otherwise, which is what
    // stops a client putting somebody else's name on a rejection.
    serverDisposition({ byUserId: 'u42', at: 1_700_000_123_000 });

    await openReview();
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // Only the change and the version this browser was looking at.
    expect(setDispositionMock.mock.calls[0][3]).toEqual({ state: 'verified' });
    // Nothing about the actor crossed the wire — the fourth argument is the
    // change and nothing else. (`getProfile` is still used elsewhere in the
    // app; what matters is that this write does not state who made it.)
    expect(setDispositionMock.mock.calls[0]).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('[role="status"]'))[0].textContent)
      .toBe('Verified');
  });

  it('Minor 2: a verification cannot reattribute the review, because it does not write one', async () => {
    // The defect this pinned — a verification's whole-review save
    // overwriting `createdByUserId` with whoever just clicked — is not
    // reachable any more: the write is one row, and the review record is not
    // touched at all.
    await openReview();
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    expect(setDispositionMock).toHaveBeenCalled();
    expect(saveReviewMock, 'a verification wrote the whole review').not.toHaveBeenCalled();
  });

  it('persists a note the same way, and does not show one the store rejected', async () => {
    await openReview();

    const textarea = () => container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;

    act(() => { setTextareaValue(textarea(), 'Check this against the side letter.'); });
    act(() => { findButton(container, /Add note/i, 0).click(); });
    await flush();

    expect(addNoteMock).toHaveBeenCalled();
    expect(addNoteMock.mock.calls[0].slice(0, 3)).toEqual(['r1', 'd1', 'c1']);
    expect(addNoteMock.mock.calls[0][3]).toBe('Check this against the side letter.');
    expect(container.textContent).toContain('Check this against the side letter.');

    // Now a rejected write: the new note must not appear anywhere, and the
    // failure must be named.
    addNoteMock.mockReset().mockRejectedValue(new Error('Disk full'));
    act(() => { setTextareaValue(textarea(), 'This one should not stick.'); });
    act(() => { findButton(container, /Add note/i, 0).click(); });
    await flush();

    expect(container.textContent).not.toContain('This one should not stick.');
    expect(container.textContent).toContain('Disk full');
    // The earlier, successfully-saved note is untouched by the failure.
    expect(container.textContent).toContain('Check this against the side letter.');
  });

  /*
   * TASK 18 MOVED THE SEAM UNDER EVERY TEST BELOW, AND MOVED NO ASSERTION.
   *
   * A run is the server's now. What used to be `runReview`'s `onUpdate`
   * carrying a snapshot in which a mid-run verification does not appear is
   * now a `finding.done` event followed by a re-read of the findings map,
   * which carries the same absence for the same reason: until Task 19 a
   * verification reaches the store through the review record, not through
   * the findings rows, so a map read back from the server has it
   * `unchecked`.
   *
   * The thing being defended is identical and is this project's one
   * irreversible risk: a verification made while a run is live must not be
   * silently overwritten by the run's next update. `carryHumanState` is
   * still what defends it, and is still deleted in Task 21 rather than here.
   */

  const DONE_C1 = {
    clauseId: 'c1', status: 'done' as const,
    citations: [{ quote: 'x', documentId: 'live-doc' }],
    summary: 'Governed by NY law.', verification: { state: 'unchecked' as const }, notes: [],
  };
  const PENDING_C2 = {
    clauseId: 'c2', status: 'pending' as const, citations: [],
    verification: { state: 'unchecked' as const }, notes: [],
  };
  const DONE_C2 = {
    ...PENDING_C2, status: 'done' as const, summary: 'Term is 12 months.',
  };

  it('does not lose a verification to the next update from a live run', async () => {
    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: PENDING_C2 } });

    await startLiveRun(container, root);
    await emitFindingDone();

    // c1 is `done`; c2 is still pending. Verify c1 now, while the run is
    // still live.
    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips().length).toBeGreaterThan(0);
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(chips()[0].textContent).toBe('Verified');
    expect(setDispositionMock.mock.calls[0][3]).toEqual({ state: 'verified' });

    // Now let the other cell finish — the server's own "unrelated cell
    // finished" event, followed by a findings map that STILL SAYS
    // `unchecked` for c1. That is the case this defends: a stale read
    // landing after a write. Without `carryHumanState`, it would silently
    // overwrite the verification just made.
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: DONE_C2 } });
    await emitFindingDone();

    expect(chips()[0].textContent).toBe('Verified');
  });

  it('the run completion save holds a verification made during the run, not the server\'s unmerged map', async () => {
    // Was "Critical 1: … not runReview's own unmerged snapshot". The
    // unmerged snapshot is now the findings map the server answers with, and
    // the save under test is the ONE the browser makes when it learns the
    // run has finished — the write that records WHEN this review ended.
    // `reviewFromRun` builds it from `latestRunRef`, so it carries whatever
    // human state this browser holds; building it from the map instead would
    // persist a review whose verification the reviewer watched succeed and
    // whose store never took.
    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: PENDING_C2 } });

    await startLiveRun(container, root);
    await emitFindingDone();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    saveReviewMock.mockClear();

    serverFindings({ 'live-doc': { c1: DONE_C1, c2: DONE_C2 } });
    getRunMock.mockResolvedValue({
      ...RUNNING_RUN, state: 'succeeded', finishedAt: 5,
      cells: { total: 2, queued: 0, leased: 0, done: 2, error: 0, cancelled: 0 },
    });
    await emitRunFinished();

    const finalSaved = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(finalSaved.findings['live-doc'].c1.verification.state).toBe('verified');
    // …and it is the write that records the ending, which is the only new
    // fact it carries.
    expect(finalSaved.completedAt).toBe(5);
  });

  it('Important 1: handleVerify does not lose a run update that lands while its own save is in flight', async () => {
    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: PENDING_C2 } });

    await startLiveRun(container, root);
    await emitFindingDone();

    // The verification's own save is held open. A run update lands INSIDE
    // that window and writes `latestRunRef` from under it; the handler must
    // re-read the ref after its awaits rather than writing back the snapshot
    // it captured before them.
    let resolveWrite: (() => void) | undefined;
    setDispositionMock.mockImplementation(() => new Promise(resolve => {
      resolveWrite = () => resolve({
        disposition: {
          reviewId: 'r-live', findingsKey: 'live-doc', clauseId: 'c1', state: 'verified',
          byUserId: 'u1', at: 1_700_000_000_000, changedCount: 1, version: 2,
        },
        event: {
          id: 1, fromState: 'unchecked', toState: 'verified', cause: 'human',
          byUserId: 'u1', at: 1_700_000_000_000,
        },
      });
    }));

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    serverFindings({ 'live-doc': { c1: DONE_C1, c2: DONE_C2 } });
    await emitFindingDone();

    act(() => { resolveWrite!(); });
    await flush();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    // The verification survived…
    expect(chips()[0].textContent).toBe('Verified');
    // …and so did the run update that landed while it was in flight.
    expect(container.textContent).toContain('Term is 12 months.');
  });

  it('stops watching the run once it has finished, so nothing later overwrites what is on screen', async () => {
    // Was "Item 2: a post-completion write does not reassert through, or
    // re-arm, the run's (now-disposed) saver". The debounced saver is gone
    // with Task 18, and the mechanism that could now reassert a stale state
    // over a human's write is a POLL that kept running past the end of the
    // run. So the claim is the same one, against the thing that replaced it:
    // nothing keeps reading after the run is over.
    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: DONE_C2 } });
    getRunMock.mockResolvedValue({
      ...RUNNING_RUN, state: 'succeeded', finishedAt: 5,
      cells: { total: 2, queued: 0, leased: 0, done: 2, error: 0, cancelled: 0 },
    });

    await startLiveRun(container, root);
    await emitRunFinished();

    expect(stopWatchMock, 'the run finished and the watch kept polling').toHaveBeenCalled();

    // The human's own write after the run is over is one write to one row,
    // with nothing left to reassert over it.
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(setDispositionMock).toHaveBeenCalledTimes(1);
    expect(Array.from(container.querySelectorAll('[role="status"]'))[0].textContent).toBe('Verified');
  });

  it('a cancelled run\'s completion save still holds a verification made during it', async () => {
    // Was "Critical 1 (abort path)". A cancellation is a request now rather
    // than an `AbortController`, and it is still NOT a failure: what
    // completed stays completed, and the verification a person made while it
    // ran is part of what completed.
    getWorkspaceSettingsMock.mockResolvedValue({ modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 });
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);
    serverFindings({ 'live-doc': { c1: DONE_C1, c2: PENDING_C2 } });

    await startLiveRun(container, root);
    await emitFindingDone();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    cancelRunMock.mockResolvedValue({ ...RUNNING_RUN, state: 'cancelling' });
    act(() => { findButton(container, /Stop|Cancel/i, 0).click(); });
    await flush();
    expect(cancelRunMock).toHaveBeenCalledWith('run-1');

    getRunMock.mockResolvedValue({
      ...RUNNING_RUN, state: 'cancelled', finishedAt: 7,
      cells: { total: 2, queued: 0, leased: 0, done: 1, error: 0, cancelled: 1 },
    });
    await emitRunFinished();

    const finalSaved = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(finalSaved.findings['live-doc'].c1.verification.state).toBe('verified');
    expect(finalSaved.cancelledAt).toBe(7);
    expect(finalSaved.completedAt).toBeUndefined();
  });
});

// Task 8A: the read side of a collection review. Task 6A made a collection
// run write its findings under `findingsKeyFor(target)` — the collection id
// — but `withUpdatedFinding` (App.tsx) still wrote by `docId`, and
// `ResultsView` still read by `docId`. So a verification on a collection
// finding landed under a document key nothing read, and the reviewer's own
// click appeared to do nothing. `onVerify`/`onAddNote`/etc. are still called
// with the ACTIVE document id (one of the collection's members, for the
// viewer pane) — App.tsx, not the caller, is responsible for resolving that
// to the collection key via `findingsKeyFor`.
describe('App — reading and writing a collection review\'s findings (Task 8A)', () => {
  let container: HTMLDivElement;
  let root: Root;

  /** A completed collection review with one clause, keyed by the
   *  collection id — exactly what a collection run seeds and writes
   *  (Task 6A's `emptyRun`/`runReview`). */
  function makeCollectionReview(): Review {
    return {
      id: 'r1',
      matterId: 'm1',
      playbookSnapshot: makeTemplate(),
      documentIds: ['d1', 'd2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] },
      findings: {
        'coll-1': {
          c1: {
            clauseId: 'c1',
            status: 'done',
            citations: [{ quote: 'x', documentId: 'd2' }],
            summary: 'The notice period is now 6 months.',
            verification: { state: 'unchecked' },
            notes: [],
          },
          c2: {
            clauseId: 'c2',
            status: 'done',
            citations: [],
            summary: 'Unaffected by the amendment.',
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
  }

  beforeEach(() => {
    localStorage.clear();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    // Two distinct member documents, unlike the single fixed record other
    // describe blocks in this file use — a collection review's viewer pane
    // switches between real, distinct documents (`documentFileForViewing`
    // keys off `record.id`, not the id it was fetched by).
    getDocumentMock.mockReset().mockImplementation((id: string) => Promise.resolve({
      ...makeDocumentRecord(), id, name: `${id}.txt`,
    }));
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeCollectionReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockReset();
    resetRunMocks();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  async function openReview() {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    // Waits for the load to SETTLE rather than for a fixed tick count — see
    // `flushUntil` for why counting ticks here was wrong.
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading',
    );
  }

  it('renders a collection review\'s findings — not an empty pane', async () => {
    await openReview();
    expect(container.textContent).toContain('The notice period is now 6 months.');
  });

  it('verifies a collection finding, persists it under the COLLECTION key, and reads it back once the write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    setDispositionMock.mockImplementation(() => new Promise(resolve => {
      resolveWrite = () => resolve({
        disposition: {
          reviewId: 'r1', findingsKey: 'coll-1', clauseId: 'c1', state: 'verified',
          byUserId: 'u1', at: 1_700_000_000_000, changedCount: 1, version: 2,
        },
        event: {
          id: 1, fromState: 'unchecked', toState: 'verified', cause: 'human',
          byUserId: 'u1', at: 1_700_000_000_000,
        },
      });
    }));

    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // The write is in flight — addressed to 'coll-1', never to 'd1' or 'd2'
    // (the active document in the viewer pane, which is what `onVerify` is
    // actually called with). R-C1: `findingsKeyFor` is the only place a
    // findings key is decided, and it decides this one too.
    expect(setDispositionMock).toHaveBeenCalled();
    expect(setDispositionMock.mock.calls[0][1]).toBe('coll-1');
    expect(setDispositionMock.mock.calls[0][2]).toBe('c1');
    expect(setDispositionMock.mock.calls[0][3]).toEqual({ state: 'verified' });

    // await-then-apply: not shown on screen until the write resolves.
    expect(chips()[0].textContent).toBe('Unverified');

    resolveWrite!();
    await flush();

    // The round trip: written under the collection key, and read back from
    // that same key onto the screen.
    expect(chips()[0].textContent).toBe('Verified');
  });

  it('leaves the OTHER clause\'s finding, under the same collection key, untouched', async () => {
    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // ONE write, naming ONE clause. The whole-review save that could once
    // have carried a change to c2 with it does not happen at all.
    expect(setDispositionMock).toHaveBeenCalledTimes(1);
    expect(setDispositionMock.mock.calls[0][2]).toBe('c1');
    const chips = Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips[chips.length - 1].textContent).toBe('Unverified');
  });
});
