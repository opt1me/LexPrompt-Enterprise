import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, PlaybookVersion, TrailStep, Collection } from './types';
import { ModelError, unconfirmedPosition, confirmPosition } from '@lexprompt/core';
import type { WorkspaceSettings } from '@lexprompt/core';
import { saveCollection } from './lib/db/collections';
import { closeDb } from './lib/db/open';
import { flushUntil } from './test/mount';

// No @testing-library/react in this project — see App.interrupted.test.tsx
// for the precedent this follows: drive a real react-dom root directly,
// mocking App.tsx's repository/module boundaries.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `db/collections` is an HTTP client since Stage 2 Task 12, so leaving it
// unmocked no longer means "runs for real against fake-indexeddb" — it means
// "reaches for a bearer token and a network". Replaced with an in-memory
// store that keeps the repository's OWN semantics (`saveCollection` writes,
// `getCollection` answers the record or `null`, `listCollections` filters by
// matter), which is a stand-in for the STORAGE and not for the thing these
// tests are about: `openReview`'s collection reconstruction still runs for
// real, exactly as before.
const collectionStore = new Map<string, Collection>();
vi.mock('./lib/db/collections', async (importOriginal) => ({
  // `newCollection` is pure and comes from the real module.
  ...(await importOriginal<typeof import('./lib/db/collections')>()),
  saveCollection: async (c: Collection) => { collectionStore.set(c.id, c); return c; },
  getCollection: async (id: string) => collectionStore.get(id) ?? null,
  listCollections: async (matterId: string) =>
    [...collectionStore.values()].filter(c => c.matterId === matterId),
  deleteCollection: async (id: string) => { collectionStore.delete(id); },
}));


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

// TASK 19: a verification and a note are each their own write, to their own
// row. This file's subject is the RESET, not the write, so the two are
// stubbed to answer what the server would — the reset's own assertions are
// unchanged by that.
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

/** Puts the three write stubs back to answering as the server does. */
function resetHumanWriteMocks(): void {
  setDispositionMock.mockReset().mockImplementation(async (
    _reviewId: string, findingsKey: string, clauseId: string,
    change: { state: string; reason?: string },
  ) => ({
    disposition: {
      reviewId: 'r1', findingsKey, clauseId, state: change.state,
      ...(change.reason ? { reason: change.reason } : {}),
      byUserId: 'u1', at: 1_700_000_000_000, changedCount: 1, version: 2,
    },
    event: {
      id: 1, fromState: 'unchecked', toState: change.state, cause: 'human',
      byUserId: 'u1', at: 1_700_000_000_000,
    },
  }));
  addNoteMock.mockReset().mockImplementation(async (
    _reviewId: string, findingsKey: string, clauseId: string, text: string,
  ) => ({
    id: `note-${text.length}`, findingId: `${findingsKey}::${clauseId}`,
    text, byUserId: 'u1', at: 1_700_000_000_000,
  }));
  setNetPositionMock.mockReset();
}

// Task 18 / Part 2A M1: `getWorkspaceSettings` is a NETWORK call, and this
// file never mocked it — so `vitest.setup.ts`'s refusing `fetch` stub
// answered it, App swallowed the rejection, and `modelChoiceId` sat at `''`.
// That silent swallow is the defect M1 fixed: a failed settings load now has
// its own state and its own Retry banner, and a suite that leaves the fetch
// failing gets that banner rendered over every screen it asserts against.
//
// Mocked to resolve with NOTHING CHOSEN — byte-for-byte the state this file
// was actually running in before, so no assertion here moves. This suite is
// about re-running a clause, not about the workspace's model.
const getWorkspaceSettingsMock = vi.fn()
  .mockResolvedValue({ modelChoiceId: '', concurrency: 5, version: 1, updatedAt: 1 });
vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: (...args: unknown[]) => getWorkspaceSettingsMock(...args),
  saveWorkspaceSettings: vi.fn(),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  // Task 16/17: `src/lib/role.ts`'s `useRole()` reads this off the SAME
  // module — a stub returning `undefined` keeps the new App-level role gate
  // permanently in its `unknown` state here, which is exactly what a test
  // that isn't about roles needs: it never trips the `failed` branch, so
  // `AppShell` renders exactly as it did before this module gained a role.
  getCachedRole: () => undefined,
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

// TASK 20: A RETRY IS ONE POST, so the seam these tests drive is the run
// client rather than the browser's own engine.
//
// What moved to the server with it: the reset itself (Task 16, in ONE
// transaction, with a history row the browser never had), the re-hydration
// for review (Task 9), the collection-retry refusal, and the "the stored
// file could not be read" path. Their suites moved with them —
// `rerunReset.pg.test.ts` and `hydrate.pg.test.ts` — because a rule about
// what an extractor may be handed can only be true where the extractor is.
//
// What stays HERE is what the browser still owns: it asks for the right
// clause, it does not lose anybody else's judgement while the retry is in
// flight, and it says the right sentence to the person who clicked.
const retryCellMock = vi.fn();
const getFindingsMock = vi.fn();
const startRunMock = vi.fn();
const stopWatchMock = vi.fn();
let emitRunEvent: ((event: unknown) => void) | null = null;

vi.mock('./lib/api/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/runs')>()),
  retryCell: (...args: unknown[]) => retryCellMock(...args),
  startRun: (...args: unknown[]) => startRunMock(...args),
  getRun: vi.fn(async () => ({ ...RETRY_RUN, state: 'succeeded' as const, finishedAt: 9 })),
  cancelRun: vi.fn().mockResolvedValue(undefined),
  liveRunFor: vi.fn().mockResolvedValue(null),
  watchRun: (_runId: string, onEvent: (event: unknown) => void) => {
    emitRunEvent = onEvent;
    return stopWatchMock;
  },
}));

const RETRY_RUN = {
  id: 'retry-run', reviewId: 'r1', state: 'running' as const, requestedByUserId: 'u1',
  concurrency: 5, createdAt: 1,
  cells: { total: 1, queued: 0, leased: 1, done: 0, error: 0, cancelled: 0 },
  version: 1,
};

/** What `GET /v1/reviews/:id/findings` answers next. */
function serverFindings(findings: unknown): void {
  getFindingsMock.mockResolvedValue({
    findings, dispositionVersions: {}, findingVersions: {}, version: 1,
  });
}

/**
 * The retry route's answer: the one-cell run it queued, and WHAT IT
 * CLEARED. The browser composes its notice from `cleared` rather than from
 * its own copy of the finding, so the sentence and the write cannot
 * disagree.
 */
function serverRetry(cleared: { verification: boolean; netPosition: boolean }): void {
  retryCellMock.mockResolvedValue({ run: RETRY_RUN, cleared });
}

import App from './App';
import type { DocumentFile, ReviewRun } from './types';

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function findButton(container: HTMLDivElement, re: RegExp, index = 0): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll('button')).filter(b => re.test((b.textContent || '').trim()));
  const button = matches[index];
  if (!button) throw new Error(`No button [${index}] found matching ${re}`);
  return button as HTMLButtonElement;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
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

const NOTE_ON_C1 = { id: 'n1', findingId: 'd1::c1', text: 'Check this against the side letter.', byUserId: 'u1', at: 50 };

/** Both findings verified, c1 additionally carrying a human note — the base
 *  case for every test below. Re-running c1 must clear only c1's
 *  verification, leave c2's verification alone, and keep c1's note. */
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
          verification: { state: 'verified', byUserId: 'u1', at: 100 },
          notes: [NOTE_ON_C1],
        },
        c2: {
          clauseId: 'c2',
          status: 'done',
          citations: [{ quote: 'y', documentId: 'd1' }],
          summary: 'Term is 12 months.',
          verification: { state: 'verified', byUserId: 'u1', at: 200 },
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

describe('App — re-running a clause clears its verification (Task 10, Step 4)', () => {
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
    // A real Blob, not `null`: `handleRetryCell` re-hydrates the document
    // FOR REVIEW from its stored bytes before extracting (page images are
    // never persisted), and a document whose bytes are missing legitimately
    // fails that re-hydration rather than being retried. `null` here would
    // model a document with no file left, which is not what these tests are
    // about.
    getDocumentBlobMock.mockReset().mockResolvedValue(new Blob(['This is the contract text.'], { type: 'text/plain' }));
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    resetHumanWriteMocks();
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    emitRunEvent = null;
    stopWatchMock.mockClear();
    startRunMock.mockReset();
    getFindingsMock.mockReset();
    retryCellMock.mockReset();
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

  function retryC1(container: HTMLDivElement) {
    // Card order follows template clause order (c1, then c2) — the first
    // Retry button belongs to c1's card.
    act(() => { findButton(container, /^Retry$/i, 0).click(); });
  }

  /**
   * After the POST answers, the browser re-reads the findings map — the row
   * is `pending` again and its judgement is cleared, server-side, in one
   * transaction. `afterRetry` is that map.
   */
  function afterRetry(over: Record<string, unknown> = {}): void {
    const review = makeReview();
    serverFindings({
      d1: {
        ...review.findings.d1,
        // The re-run's own answer, with the judgement that described the
        // OLD answer cleared — by the server, in the same transaction that
        // queued the work. The notes are untouched, which is the point of
        // the test below.
        c1: {
          clauseId: 'c1', status: 'done',
          citations: [{ quote: 'z', documentId: 'd1' }],
          summary: 'Updated: governed by Delaware law.',
          verification: { state: 'unchecked' }, notes: [NOTE_ON_C1],
        },
        ...over,
      },
    });
  }

  it('resets a verified finding to unchecked when its clause is retried', async () => {
    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Verified');

    serverRetry({ verification: true, netPosition: false });
    afterRetry();
    retryC1(container);
    await flush();
    expect(chips()[0].textContent).toBe('Unverified');

    // The RESET is the server's now, in one transaction with the queueing
    // and with a `finding_disposition_event` recording that it cleared
    // (`rerunReset.pg.test.ts`). What this pins is that the browser asked
    // about the right clause, under the right key — `findingsKeyFor`'s, not
    // the active document's.
    expect(retryCellMock).toHaveBeenCalledTimes(1);
    expect(retryCellMock.mock.calls[0]).toEqual(['r1', 'd1', 'c1']);
  });

  it('tells the user their verification was cleared', async () => {
    await openReview();

    serverRetry({ verification: true, netPosition: false });
    afterRetry();
    retryC1(container);
    await flush();

    expect(container.textContent).toContain('Governing Law');
    expect(container.textContent).toMatch(/re-run/i);
    expect(container.textContent).toMatch(/verification was cleared/i);
  });

  it('says nothing about a clearing the transaction did not do', async () => {
    // The notice is composed from what the SERVER says it cleared, not from
    // this browser's copy of the finding — so the sentence and the write
    // cannot disagree. A finding nobody had judged clears nothing.
    await openReview();

    serverRetry({ verification: false, netPosition: false });
    afterRetry();
    retryC1(container);
    await flush();

    expect(container.textContent).not.toMatch(/was cleared/i);
  });

  it('leaves the verification of other findings alone', async () => {
    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[1].textContent).toBe('Verified');

    serverRetry({ verification: true, netPosition: false });
    afterRetry();
    retryC1(container);
    await flush();

    expect(chips()[1].textContent).toBe('Verified');
  });

  it('keeps notes across a re-run, deleting none of them', async () => {
    // "A note is a person's remark about the clause, not a component of
    // their judgement on one answer." The server's transaction does not
    // touch them (`rerunReset.pg.test.ts`); this is the same claim on
    // screen.
    await openReview();

    expect(container.textContent).toContain('Check this against the side letter.');

    serverRetry({ verification: true, netPosition: false });
    afterRetry();
    retryC1(container);
    await flush();

    expect(container.textContent).toContain('Check this against the side letter.');
  });

  it('puts the cell back exactly as it was when the retry is REFUSED', async () => {
    // Nothing happened server-side, so nothing on screen may say it did —
    // and the spinner must not be left up. This project has shipped a cell
    // that spins forever once already.
    await openReview();

    retryCellMock.mockRejectedValue(new ModelError(
      'This review is already running (run r-1 is running).', 'conflict', 409));
    retryC1(container);
    await flush();

    const chips = Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips[0].textContent).toBe('Verified');
    expect(container.textContent).toContain('already running');
    expect(container.textContent).not.toMatch(/Extracting/i);
  });

  describe('a human write to a different finding during an in-flight retry', () => {
    /*
     * Fix round 1 (reviewer-confirmed MEDIUM defect), and it survives the
     * move: a verification or a note written to a DIFFERENT finding while
     * another clause's retry is still in flight must not be discarded by
     * the findings re-read the retry performs afterwards. That read knows
     * nothing about a write this browser has just made — which is exactly
     * what `carryHumanState` is for, and why it is deleted in Task 21 and
     * not here.
     */
    it('keeps a verification and a note on that finding, on screen and in what it renders', async () => {
      await openReview();

      // The retry's own request is held open, so the human writes below
      // land while it is in flight.
      let resolveRetry: (() => void) | undefined;
      retryCellMock.mockImplementation(() => new Promise(resolve => {
        resolveRetry = () => resolve({
          run: RETRY_RUN, cleared: { verification: true, netPosition: false },
        });
      }));
      retryC1(container);
      await flush();

      // c2 is the OTHER finding — the only one with a card while c1 is
      // being re-run. Note it, then flag it.
      const textareas = container.querySelectorAll('textarea');
      const textarea = textareas[textareas.length - 1] as HTMLTextAreaElement;
      act(() => { setTextareaValue(textarea, 'New note added mid-retry.'); });
      act(() => {
        const buttons = Array.from(container.querySelectorAll('button'))
          .filter(b => /Add note/i.test(b.textContent || ''));
        (buttons[buttons.length - 1] as HTMLButtonElement).click();
      });
      await flush();

      expect(container.textContent).toContain('New note added mid-retry.');

      act(() => { findButton(container, /^Flag$/i, 0).click(); });
      await flush();

      // Now the retry answers, and the findings map that comes back knows
      // nothing about either write.
      afterRetry({ c2: {
        clauseId: 'c2', status: 'done', citations: [{ quote: 'y', documentId: 'd1' }],
        summary: 'Term is 12 months.', verification: { state: 'unchecked' }, notes: [],
      } });
      act(() => { resolveRetry!(); });
      await flush();

      expect(container.textContent).toContain('New note added mid-retry.');
      const chips = Array.from(container.querySelectorAll('[role="status"]'));
      expect(chips[chips.length - 1].textContent).toBe('Flagged');
    });
  });

  describe('re-running a clause also resets its net position (Task 8)', () => {
    it('says "net position was cleared" when that is all there was', async () => {
      await openReview();

      serverRetry({ verification: false, netPosition: true });
      afterRetry();
      retryC1(container);
      await flush();

      expect(container.textContent).toMatch(/net position was cleared/i);
      expect(container.textContent).not.toMatch(/verification and net position/i);
    });

    it('resets both verification and net position, and says so, when a clause carries both', async () => {
      await openReview();

      serverRetry({ verification: true, netPosition: true });
      afterRetry();
      retryC1(container);
      await flush();

      expect(container.textContent).toMatch(/verification and net position were cleared/i);
    });
  });
});

/*
 * THE COLLECTION-RETRY REFUSAL AND THE RE-HYDRATION MOVED TO THE SERVER
 * (Task 20), and their suites moved with them.
 *
 * What used to be here:
 *
 *  - "calls retryCell with the collection's target and ordered members" and
 *    "re-hydrates every present member for review, keeping the reading
 *    order" — now `rerunReset.pg.test.ts`'s "queues a cell keyed by the
 *    collection, never by a document", which is a stronger claim: the key
 *    is checked through `cellsFor` → `findingsKeyFor`, so a collection
 *    review retried by one of its document ids answers 404 rather than
 *    quietly running the single-document extractor.
 *  - "refuses the retry when the collection is gone" — the server reads the
 *    collection record itself.
 *  - the whole "a retry on a reopened review re-hydrates its documents for
 *    review" describe — `hydrate.pg.test.ts`, where the extraction now
 *    happens. `documentFileForReview` no longer exists in the browser at
 *    all, so there is nothing left here that could hydrate the wrong way.
 *
 * None of those claims was dropped. Every one of them is made where the
 * thing it is about now lives, which is the only place it can be true.
 */
