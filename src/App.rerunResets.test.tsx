import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, PlaybookVersion, TrailStep, Collection } from './types';
import { unconfirmedPosition, confirmPosition } from './lib/netPosition';
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

// `retryCell` itself is mocked (rather than `extractClause`, which is what
// the real `retryCell` calls) so the test below can inspect the exact `run`
// App.tsx's `handleRetryCell` hands to it — isolating Step 4's own
// verification-reset logic from `retryCell`'s independent behavior. This
// matters because the real `retryCell` always builds a brand-new Finding for
// the retried clause (`verification: unchecked()`, discarding whatever it
// was given), which would make the final persisted/rendered state "unchecked"
// regardless of whether `handleRetryCell`'s own reset ran — a mutation
// deleting that reset would go uncaught by an assertion on the end state
// alone. Checking `retryCellMock`'s call arguments directly instead pins
// down that `handleRetryCell` computed and passed a reset run, independent
// of what a (real or mocked) `retryCell` later does with it.
const retryCellMock = vi.fn();
vi.mock('./features/review/runReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./features/review/runReview')>();
  return {
    ...actual,
    retryCell: (...args: unknown[]) => retryCellMock(...args),
  };
});

// `documentFileForReview` is spied on (not replaced wholesale) because
// what these tests need to pin down is WHICH hydration App.tsx uses at
// retry time, not what that hydration does — the regeneration itself is
// covered against the real pdfjs stubs in `src/lib/documents.test.ts`.
// The top-level `beforeEach` below restores the real implementation for
// every test, so the existing suites keep exercising it; only the tests
// that need a scan's regenerated images, or a hydration held open
// mid-flight, override it.
const documentFileForReviewMock = vi.fn();
vi.mock('./lib/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/documents')>();
  return {
    ...actual,
    documentFileForReview: (...args: unknown[]) => documentFileForReviewMock(...args),
  };
});

import App from './App';
import type { DocumentFile, ReviewRun } from './types';
import type { WorkspaceSettings } from '@lexprompt/core';

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

// Applies to every describe in this file and runs before their own
// `beforeEach`es: the default is the REAL `documentFileForReview`, so a
// test that says nothing about hydration still exercises it for real.
let realDocuments: typeof import('./lib/documents') | undefined;
beforeEach(async () => {
  // Imported once and cached: resolving it per call would leave the mock's
  // promise pending for longer than `flush()`'s microtask ticks, and the
  // retry would look stalled rather than hydrated.
  realDocuments ??= await vi.importActual<typeof import('./lib/documents')>('./lib/documents');
  const real = realDocuments;
  documentFileForReviewMock.mockReset().mockImplementation(
    (record: DocumentRecord, blob: Blob | null) => real.documentFileForReview(record, blob),
  );
});

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
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
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
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    // Simulates the real `retryCell`'s shape (a 'running' onUpdate, then a
    // fresh, unchecked, note-free 'done' finding) closely enough to drive
    // App.tsx's own retry-handling code paths, while leaving the `run`
    // App.tsx passed in (this mock's first argument) inspectable — that run
    // is what `retryCellMock.mock.calls[...][0]` checks below.
    retryCellMock.mockReset().mockImplementation(async (
      retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: WorkspaceSettings, onUpdate: (r: ReviewRun) => void,
    ) => {
      const running: ReviewRun = {
        ...retryRun,
        findings: {
          ...retryRun.findings,
          [doc.id]: {
            ...retryRun.findings[doc.id],
            [clauseId]: { clauseId, status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] },
          },
        },
      };
      onUpdate(running);
      const done: ReviewRun = {
        ...running,
        findings: {
          ...running.findings,
          [doc.id]: {
            ...running.findings[doc.id],
            [clauseId]: {
              clauseId,
              status: 'done',
              citations: [{ quote: 'z', documentId: doc.id }],
              summary: 'Updated: governed by Delaware law.',
              verification: { state: 'unchecked' },
              notes: [],
            },
          },
        },
      };
      onUpdate(done);
      return done;
    });

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

  it('resets a verified finding to unchecked when its clause is retried', async () => {
    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Verified');

    retryC1(container);
    await flush();

    expect(chips()[0].textContent).toBe('Unverified');
    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(persisted.findings.d1.c1.verification).toEqual({ state: 'unchecked' });

    // Pins down that `handleRetryCell` itself computed and passed a reset
    // run — not merely that the end state happens to read "unchecked"
    // because `retryCell` always builds a fresh Finding regardless of what
    // it's given. The `run` passed as `retryCellMock`'s first argument is
    // `handleRetryCell`'s own `cleared`, before any of `retryCell`'s own
    // processing ran.
    expect(retryCellMock).toHaveBeenCalled();
    const clearedRunPassedIn = retryCellMock.mock.calls[0][0] as ReviewRun;
    expect(clearedRunPassedIn.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
  });

  it('tells the user their verification was cleared', async () => {
    await openReview();

    retryC1(container);
    await flush();

    expect(container.textContent).toContain('Governing Law');
    expect(container.textContent).toMatch(/re-run/i);
    expect(container.textContent).toMatch(/verification was cleared/i);
  });

  it('leaves the verification of other findings alone', async () => {
    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[1].textContent).toBe('Verified');

    retryC1(container);
    await flush();

    expect(chips()[1].textContent).toBe('Verified');
    const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(persisted.findings.d1.c2.verification).toEqual({ state: 'verified', byUserId: 'u1', at: 200 });
  });

  it('keeps notes across a re-run, deleting none of them', async () => {
    await openReview();

    expect(container.textContent).toContain('Check this against the side letter.');

    retryC1(container);
    await flush();

    expect(container.textContent).toContain('Check this against the side letter.');
    const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(persisted.findings.d1.c1.notes).toEqual([NOTE_ON_C1]);
  });

  // Fix round 1 (reviewer-confirmed MEDIUM defect): a verification or note
  // written to a DIFFERENT finding while another clause's retry is still in
  // flight must not be discarded by the retry's own onUpdate/save, on screen
  // or in what gets persisted. `retryCell` is handed `cleared` — a snapshot
  // frozen at the moment the retry started — and knows nothing about a
  // write that lands on `latestRunRef.current` afterwards; without
  // `carryHumanState` in `onRetryUpdate`, the next snapshot `retryCell`
  // emits replaces the whole run with that stale, `cleared`-derived copy.
  describe('a human write to a different finding during an in-flight retry', () => {
    it('keeps a verification and a note on that finding, on screen and in what is persisted', async () => {
      // c1's retry pauses mid-flight (after its 'running' transition, before
      // its 'done' result) so a write to c2 can land while c1 is still
      // in-flight — exactly the reviewer's reproduction.
      let resolveC1Retry: (() => void) | undefined;
      retryCellMock.mockReset().mockImplementationOnce(async (
        retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: WorkspaceSettings, onUpdate: (r: ReviewRun) => void,
      ) => {
        const running: ReviewRun = {
          ...retryRun,
          findings: {
            ...retryRun.findings,
            [doc.id]: {
              ...retryRun.findings[doc.id],
              [clauseId]: { clauseId, status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] },
            },
          },
        };
        onUpdate(running);
        await new Promise<void>((resolve) => { resolveC1Retry = resolve; });
        const done: ReviewRun = {
          ...running,
          findings: {
            ...running.findings,
            [doc.id]: {
              ...running.findings[doc.id],
              [clauseId]: {
                clauseId,
                status: 'done',
                citations: [{ quote: 'z', documentId: doc.id }],
                summary: 'Updated: governed by Delaware law.',
                verification: { state: 'unchecked' },
                notes: [],
              },
            },
          },
        };
        onUpdate(done);
        return done;
      });

      await openReview();
      retryC1(container);
      await flush();

      // c1 is now 'running' (no VerificationControls/NotesPanel rendered for
      // it), so the one remaining textarea/state-chip on screen belongs to
      // c2 — the "different finding" the reviewer's repro writes to.
      const textarea = container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;
      act(() => { setTextareaValue(textarea, 'New note added mid-retry.'); });
      act(() => { findButton(container, /Add note/i, 0).click(); });
      await flush();

      expect(container.textContent).toContain('New note added mid-retry.');

      act(() => { findButton(container, /^Flag$/i, 0).click(); });
      await flush();

      const chipsDuring = () => Array.from(container.querySelectorAll('[role="status"]'));
      expect(chipsDuring()[0].textContent).toBe('Flagged');

      // Let c1's retry finish.
      act(() => { resolveC1Retry!(); });
      await flush();

      // Both survive on screen once c1's retry resolves and re-renders the
      // whole run...
      expect(container.textContent).toContain('New note added mid-retry.');
      const chipsAfter = () => Array.from(container.querySelectorAll('[role="status"]'));
      expect(chipsAfter()[0].textContent).toBe('Unverified'); // c1, correctly reset
      expect(chipsAfter()[1].textContent).toBe('Flagged'); // c2, must survive

      // ...and in what the retry's own completion handler persisted — this
      // is the exact write the reviewer found silently reverted.
      const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
      expect(persisted.findings.d1.c2.verification.state).toBe('flagged');
      expect(persisted.findings.d1.c2.notes.map((n: { text: string }) => n.text)).toContain('New note added mid-retry.');
    });

    it('keeps a second note on a finding that already had one', async () => {
      // Same shape as above, but c2 starts with ONE pre-existing note
      // (typical of a review reopened from an earlier session) rather than
      // none — `carryHumanState`'s notes rule keys off "before has notes,
      // incoming shows none"; this confirms it also holds when "incoming"
      // (retryCell's stale, cleared-derived copy) still shows a non-empty,
      // out-of-date note list rather than an empty one.
      const preExistingNote = { id: 'n2', findingId: 'd1::c2', text: 'Earlier note on c2.', byUserId: 'u1', at: 60 };
      getReviewMock.mockResolvedValue({
        ...makeReview(),
        findings: {
          d1: {
            ...makeReview().findings.d1,
            c2: { ...makeReview().findings.d1.c2, notes: [preExistingNote] },
          },
        },
      });

      let resolveC1Retry: (() => void) | undefined;
      retryCellMock.mockReset().mockImplementationOnce(async (
        retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: WorkspaceSettings, onUpdate: (r: ReviewRun) => void,
      ) => {
        const running: ReviewRun = {
          ...retryRun,
          findings: {
            ...retryRun.findings,
            [doc.id]: {
              ...retryRun.findings[doc.id],
              [clauseId]: { clauseId, status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] },
            },
          },
        };
        onUpdate(running);
        await new Promise<void>((resolve) => { resolveC1Retry = resolve; });
        const done: ReviewRun = {
          ...running,
          findings: {
            ...running.findings,
            [doc.id]: {
              ...running.findings[doc.id],
              [clauseId]: {
                clauseId,
                status: 'done',
                citations: [{ quote: 'z', documentId: doc.id }],
                summary: 'Updated: governed by Delaware law.',
                verification: { state: 'unchecked' },
                notes: [],
              },
            },
          },
        };
        onUpdate(done);
        return done;
      });

      await openReview();
      expect(container.textContent).toContain('Earlier note on c2.');

      retryC1(container);
      await flush();

      const textarea = container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;
      act(() => { setTextareaValue(textarea, 'Second note added mid-retry.'); });
      act(() => { findButton(container, /Add note/i, 0).click(); });
      await flush();

      act(() => { resolveC1Retry!(); });
      await flush();

      expect(container.textContent).toContain('Earlier note on c2.');
      expect(container.textContent).toContain('Second note added mid-retry.');

      const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
      const texts = persisted.findings.d1.c2.notes.map((n: { text: string }) => n.text);
      expect(texts).toContain('Earlier note on c2.');
      expect(texts).toContain('Second note added mid-retry.');
    });
  });

  // Minor 4 (final fix round): `handleRetryCell` used to pass
  // `createdByUserIdRef.current` with no fallback, unlike its two siblings
  // (`handleVerify`/`handleAddNote`, which fall back to `profile.id`). A
  // stored review that predates the `createdByUserId` field (or was
  // corrupted) would leave `createdByUserIdRef.current` falsy, and a retry's
  // save would then write an author-less review.
  it('Minor 4: falls back to the profile id when createdByUserId was never set, matching handleVerify/handleAddNote', async () => {
    getReviewMock.mockResolvedValue({ ...makeReview(), createdByUserId: undefined });
    getProfileMock.mockResolvedValue({ id: 'u9', name: 'Someone Else', initials: 'SE' });

    await openReview();
    retryC1(container);
    await flush();

    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(persisted.createdByUserId).toBe('u9');
  });

  // Task 8, Step 4 / mutation 1: removing the net-position reset from
  // `handleRetryCell` must make this fail. c1 carries a CONFIRMED net
  // position alongside its verified verification — re-running it must clear
  // both, exactly as `resetVerification` and `resetPosition` say: the human
  // judgement described specific output that a retry replaces.
  describe('re-running a clause also resets its net position (Task 8)', () => {
    const TRAIL: TrailStep[] = [
      { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
    ];

    function makeReviewWithNetPosition(): Review {
      const review = makeReview();
      const confirmed = confirmPosition(unconfirmedPosition('Notice is now 6 months.', TRAIL), 'u1', 100);
      return {
        ...review,
        findings: {
          d1: {
            ...review.findings.d1,
            c1: { ...review.findings.d1.c1, netPosition: confirmed },
          },
        },
      };
    }

    beforeEach(() => {
      getReviewMock.mockReset().mockResolvedValue(makeReviewWithNetPosition());
    });

    // `retryCellMock`'s default implementation (top-level `beforeEach`) —
    // mirroring the real `retryCell`/`extractClause`, which never write a
    // `netPosition` at all for a document-target review — builds its 'done'
    // finding with no `netPosition` key whatsoever. So the run this test's
    // clause ENDS UP with (after `retryCell` "completes") has no
    // `netPosition` on c1 either way, whether or not `handleRetryCell`'s own
    // reset ran: that end state cannot tell the two apart, exactly the
    // reason the existing verification test above checks
    // `retryCellMock.mock.calls[0][0]` (the `cleared` run `handleRetryCell`
    // computed and handed to `retryCell`) rather than the final persisted
    // state. That is the assertion this test relies on too.
    it('resets a confirmed net position to unconfirmed BEFORE handing the run to retryCell', async () => {
      await openReview();

      expect(container.textContent).toMatch(/\bconfirmed\b/i);

      retryC1(container);
      await flush();

      expect(retryCellMock).toHaveBeenCalled();
      const clearedRunPassedIn = retryCellMock.mock.calls[0][0] as ReviewRun;
      const clearedPosition = clearedRunPassedIn.findings.d1.c1.netPosition;
      expect(clearedPosition?.state).toBe('unconfirmed');
      expect(clearedPosition && 'amended' in clearedPosition).toBe(false);
      expect(clearedPosition && 'byUserId' in clearedPosition).toBe(false);

      // The old confirmation's own text/attribution must be gone from
      // screen once the retry completes — whatever replaces it (here,
      // nothing at all, since this mock's fresh finding carries no
      // `netPosition`), it must not still read "Confirmed by u1".
      expect(container.textContent).not.toMatch(/confirmed by u1/i);
    });

    it('resets both verification and net position, and says so, when a clause carries both', async () => {
      // makeReviewWithNetPosition() starts from makeReview(), whose c1 is
      // already `verified` — so this clause carries both a human
      // verification AND a confirmed net position, and retrying it must
      // clear both together.
      await openReview();

      const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
      expect(chips()[0].textContent).toBe('Verified');

      retryC1(container);
      await flush();

      // The notify banner fires synchronously as part of `handleRetryCell`
      // itself, before `retryCell` is even called — unaffected by whatever
      // the (mocked) `retryCell` later does.
      expect(container.textContent).toMatch(/verification and net position were cleared/i);

      const clearedRunPassedIn = retryCellMock.mock.calls[0][0] as ReviewRun;
      expect(clearedRunPassedIn.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
      expect(clearedRunPassedIn.findings.d1.c1.netPosition?.state).toBe('unconfirmed');
    });

    it('leaves an unrelated clause\'s net position alone', async () => {
      // c2 has no net position at all in this fixture — retrying c1 must not
      // invent one for it.
      await openReview();

      retryC1(container);
      await flush();

      const clearedRunPassedIn = retryCellMock.mock.calls[0][0] as ReviewRun;
      expect('netPosition' in clearedRunPassedIn.findings.d1.c2).toBe(false);
    });
  });
});

// Task 8A: a collection review's retry must go through the COLLECTION
// extractor, never `extractClause` — verified here at the point
// `handleRetryCell` actually invokes `retryCell`, by inspecting the
// collection argument it is handed (and, in the second test, that it is
// refused rather than silently omitted).
describe('App — retrying a collection clause calls the collection extractor (Task 8A)', () => {
  let container: HTMLDivElement;
  let root: Root;

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
            clauseId: 'c1', status: 'done', citations: [],
            summary: 'The notice period is now 6 months.',
            verification: { state: 'unchecked' }, notes: [],
          },
          c2: {
            clauseId: 'c2', status: 'done', citations: [],
            summary: 'Unaffected by the amendment.',
            verification: { state: 'unchecked' }, notes: [],
          },
        },
      },
      modelId: 'test/model',
      startedAt: 1,
      completedAt: 2,
      createdByUserId: 'u1',
    };
  }

  beforeEach(async () => {
    closeDb();
    indexedDB.deleteDatabase('lexprompt');
    localStorage.clear();
    // The in-memory collection store stands where `indexedDB.deleteDatabase`
    // used to: without this, the "collection is gone" case below reads a
    // collection an earlier test saved and proves nothing.
    collectionStore.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    // Two distinct member documents — `documentFileForViewing` keys off
    // `record.id`, not the id it was fetched by, so a single fixed record
    // (as other describe blocks in this file use) would collapse d1/d2.
    getDocumentMock.mockReset().mockImplementation((id: string) => Promise.resolve({
      ...makeDocumentRecord(), id, name: `${id}.txt`,
    }));
    // A real Blob, not `null`: `handleRetryCell` re-hydrates the document
    // FOR REVIEW from its stored bytes before extracting (page images are
    // never persisted), and a document whose bytes are missing legitimately
    // fails that re-hydration rather than being retried. `null` here would
    // model a document with no file left, which is not what these tests are
    // about.
    getDocumentBlobMock.mockReset().mockResolvedValue(new Blob(['This is the contract text.'], { type: 'text/plain' }));
    getReviewMock.mockReset().mockResolvedValue(makeCollectionReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
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

  it('calls retryCell with the collection\'s target and ordered members, not with extractClause\'s single document', async () => {
    const collection: Collection = {
      id: 'coll-1',
      matterId: 'm1',
      name: 'Lease + amendments',
      baseDocumentId: 'd1',
      variesDocumentIds: ['d2'],
      createdAt: 1,
      createdByUserId: 'u1',
    };
    await saveCollection(collection);
    retryCellMock.mockResolvedValue(makeCollectionReview());

    await openReview();
    act(() => { findButton(container, /^Retry$/i, 0).click(); });
    await flush();

    expect(retryCellMock).toHaveBeenCalled();
    const collectionArg = retryCellMock.mock.calls[0][5] as
      { target: unknown; members: { documentId: string }[] } | undefined;
    expect(collectionArg).toBeDefined();
    expect(collectionArg?.target).toEqual({ kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] });
    expect(collectionArg?.members.map(m => m.documentId)).toEqual(['d1', 'd2']);
  });

  // The collection half of the re-hydration fix. A collection retry extracts
  // from `activeCollectionRef.current.members`, which `openReview` built from
  // VIEW-hydrated files — so a scanned deed of variation reached the
  // collection extractor with no page images and was reported as having "no
  // extractable content". Every present member is re-hydrated for review,
  // and the reading order `orderedMembers` already decided is carried
  // through untouched rather than re-derived.
  it('re-hydrates every present member for review, keeping the reading order it was given', async () => {
    const collection: Collection = {
      id: 'coll-1',
      matterId: 'm1',
      name: 'Lease + amendments',
      baseDocumentId: 'd1',
      variesDocumentIds: ['d2'],
      createdAt: 1,
      createdByUserId: 'u1',
    };
    await saveCollection(collection);
    retryCellMock.mockResolvedValue(makeCollectionReview());
    const images = [{ mime: 'image/jpeg', data: 'c2Nhbg==' }];
    documentFileForReviewMock.mockImplementation(async (record: DocumentRecord) => ({
      id: record.id,
      name: record.name,
      text: record.text,
      kind: record.kind,
      file: new File([''], record.name),
      pageImages: images,
    }));

    await openReview();
    act(() => { findButton(container, /^Retry$/i, 0).click(); });
    await flush();

    expect(documentFileForReviewMock.mock.calls.map(c => (c[0] as DocumentRecord).id)).toEqual(['d1', 'd2']);

    const collectionArg = retryCellMock.mock.calls[0][5] as
      { members: { documentId: string; kind: string; position: number; document: DocumentFile | null }[] };
    expect(collectionArg.members.map(m => m.documentId)).toEqual(['d1', 'd2']);
    expect(collectionArg.members.map(m => m.kind)).toEqual(['original', 'varies']);
    expect(collectionArg.members.map(m => m.position)).toEqual([1, 2]);
    for (const member of collectionArg.members) {
      expect(member.document?.pageImages).toEqual(images);
    }
  });

  it('refuses the retry, without calling retryCell, when the collection is gone', async () => {
    // Deliberately no `saveCollection` call — `getCollection('coll-1')`
    // genuinely resolves null here, mirroring a collection that was ungrouped
    // or deleted. Falling back to `extractClause` in this situation would be
    // exactly the silent, confidently-wrong single-document answer this
    // sub-project exists to prevent.
    await openReview();

    act(() => { findButton(container, /^Retry$/i, 0).click(); });
    await flush();

    expect(retryCellMock).not.toHaveBeenCalled();
    // Found by driving the app after ungrouping a real collection: the old
    // wording told the reader to "reload the review and try again", which for
    // an ungrouped collection is advice that can never work — they reload,
    // retry, and get the same message. A refusal has to be loud AND accurate.
    expect(container.textContent).toMatch(/no longer grouped as a collection/i);
    expect(container.textContent).toMatch(/findings already here are unchanged/i);
    expect(container.textContent).not.toMatch(/try again/i);
  });

  // NOT tested here: the other branch, where the collection read THROWS and
  // the message stays "could not be prepared ... try again". This file
  // deliberately leaves `db/collections` unmocked so the Task 8A tests above
  // exercise the real `openReview` reconstruction path, and there is no way to
  // force `getCollection` to reject without mocking it and taking that
  // property away from them. The branch is one ternary away from the case
  // that IS pinned above, and swapping the two messages fails that test.
});

// ---------------------------------------------------------------------------
// A retry on a REOPENED review must re-hydrate its documents FOR REVIEW.
//
// Found by driving the real app: open a saved review over a scanned PDF, hit
// Retry, and it failed with "<file> has no readable text or images to review.
// It may have failed to parse, or be a scan with no extractable content." —
// a message that blames a document the reviewer can see rendered in the pane
// beside it. `openReview` hydrates with `documentFileForViewing` (correct for
// the viewer, which renders the PDF itself and needs no base64 page images),
// and `handleRetryCell` then extracted from those same view-hydrated files.
// A view-hydrated `DocumentFile` has exactly the field a raw `DocumentRecord`
// is missing: `pageImages`. For a scan that means empty text and no images,
// which `assessDocument` correctly calls `unreadable`.
// ---------------------------------------------------------------------------
describe('App — a retry on a reopened review re-hydrates its documents for review', () => {
  let container: HTMLDivElement;
  let root: Root;

  const SCAN_BLOB = new Blob(['%PDF-1.4 scanned bytes'], { type: 'application/pdf' });
  const REGENERATED_IMAGES = [
    { mime: 'image/jpeg', data: 'cGFnZTE=' },
    { mime: 'image/jpeg', data: 'cGFnZTI=' },
  ];
  const SCAN_NAME = 'signed-counterpart-lease-unit-14-meadowview.pdf';

  /** A scan: a PDF whose every page is below `SCAN_TEXT_THRESHOLD`, so
   *  `documentNeedsPageImages` reports true and a review of it depends
   *  entirely on regenerated page images. */
  function makeScanRecord(): DocumentRecord {
    return {
      id: 'd1',
      matterId: 'm1',
      name: SCAN_NAME,
      kind: 'pdf',
      text: '[Page 1]\n\n[Page 2]\n\n',
      byteSize: 900000,
      addedAt: 1,
      addedByUserId: 'u1',
      role: 'standalone',
    };
  }

  /** What `documentFileForReview` returns for that record: the same text,
   *  plus the page images it re-rendered from the stored bytes. */
  function reviewHydratedScan(): DocumentFile {
    return {
      id: 'd1',
      name: SCAN_NAME,
      text: '[Page 1]\n\n[Page 2]\n\n',
      kind: 'pdf',
      file: new File([SCAN_BLOB], SCAN_NAME),
      pageImages: REGENERATED_IMAGES,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeScanRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(SCAN_BLOB);
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    // Returns the run it was handed, unchanged: these tests are about what
    // reaches `retryCell`, not about what it does afterwards.
    retryCellMock.mockReset().mockImplementation(async (retryRun: ReviewRun) => retryRun);

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

  function retryC1() {
    act(() => { findButton(container, /^Retry$/i, 0).click(); });
  }

  // Required assertion 1. Fails against the pre-fix code, which never called
  // `documentFileForReview` from the retry path at all and handed the
  // extractor `openReview`'s view-hydrated file — no `pageImages`.
  it('hands the extractor a document re-hydrated from storage, carrying the regenerated page images', async () => {
    documentFileForReviewMock.mockResolvedValue(reviewHydratedScan());

    await openReview();
    retryC1();
    await flush();

    expect(documentFileForReviewMock).toHaveBeenCalledTimes(1);
    const [recordArg, blobArg] = documentFileForReviewMock.mock.calls[0] as [DocumentRecord, Blob];
    expect(recordArg.id).toBe('d1');
    expect(blobArg).toBe(SCAN_BLOB);

    expect(retryCellMock).toHaveBeenCalled();
    const docHandedToExtractor = retryCellMock.mock.calls[0][1] as DocumentFile;
    expect(docHandedToExtractor.pageImages).toEqual(REGENERATED_IMAGES);
  });

  // Required assertion 2. `handleRetryCell` is now async, and re-rendering a
  // multi-page scan through pdfjs takes real time — if the busy state were
  // set after the hydration await, the card would sit showing its old answer
  // and its Retry button for the whole render, which reads as a dead button.
  it('shows the cell as busy before the re-hydration has finished', async () => {
    let releaseHydration: ((doc: DocumentFile) => void) | undefined;
    documentFileForReviewMock.mockImplementation(() => new Promise<DocumentFile>((resolve) => {
      releaseHydration = resolve;
    }));

    await openReview();
    // Both clauses are `done` in the fixture, so both cards offer Retry and
    // c1's card shows its answer.
    expect(container.textContent).toContain('Governed by NY law.');

    retryC1();
    await flush();

    // The hydration is still in flight: it was started, and nothing has been
    // handed to the extractor yet.
    expect(documentFileForReviewMock).toHaveBeenCalledTimes(1);
    expect(releaseHydration).toBeDefined();
    expect(retryCellMock).not.toHaveBeenCalled();

    // ...and yet c1's card already reads as busy: the old answer is gone, a
    // spinner is up, and c1 no longer offers Retry (only c2 does).
    expect(container.textContent).not.toContain('Governed by NY law.');
    // The busy contract, not a styling class: `data-busy` survives the
    // reskin, and the word survives `prefers-reduced-motion` (R-G20/R-GP2).
    //
    // The WORD is the load-bearing half. From Task 4 onward a loading
    // `Button` also carries `data-busy="true"`, so a bare
    // `querySelectorAll('[data-busy]').length > 0` could be satisfied by an
    // unrelated element and would stop proving anything about this card —
    // the "green suite is not evidence" failure, arriving four commits after
    // the mutation test that certified it (F11). So the attribute is
    // asserted INSIDE the card region, not across the container.
    const busyCard = Array.from(container.querySelectorAll('[data-busy="true"]'))
      .find(el => /Extracting…/.test(el.textContent || ''));
    expect(busyCard, 'the retried clause card must expose the busy contract').toBeTruthy();
    expect(container.textContent).toContain('Extracting…');
    const retryButtons = Array.from(container.querySelectorAll('button'))
      .filter(b => /^Retry$/i.test((b.textContent || '').trim()));
    expect(retryButtons.length).toBe(1);

    act(() => { releaseHydration!(reviewHydratedScan()); });
    await flush();
    expect(retryCellMock).toHaveBeenCalled();
  });

  // Required assertion 3. The whole point of the fix: never blame the
  // document for a failure to find or re-read its bytes.
  it('reports a hydration failure honestly, without blaming the document for having no content', async () => {
    // The real `documentFileForReview` (restored by the file-level
    // `beforeEach`) reports a missing blob as `parseError`, exactly as it
    // documents: "a caller checking `pageImages` alone cannot tell an
    // unreadable scan from a document that never needed images".
    getDocumentBlobMock.mockResolvedValue(null);

    await openReview();
    retryC1();
    await flush();

    expect(retryCellMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/could not be re-read/i);
    expect(container.textContent).toContain('The original file for this document is no longer available.');
    expect(container.textContent).not.toMatch(/has no readable text or images to review/i);

    // ...and the screen and storage agree about it: the cell is an error
    // finding naming the real cause, not a spinner that never finishes and
    // not the old, human-verified answer left standing in storage.
    const persisted = saveReviewMock.mock.calls[saveReviewMock.mock.calls.length - 1][0];
    expect(persisted.findings.d1.c1.status).toBe('error');
    expect(persisted.findings.d1.c1.error).toMatch(/could not be re-read/i);
    expect(persisted.findings.d1.c1.error).not.toMatch(/has no readable text or images to review/i);
    expect(persisted.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
  });

  // Required assertion 4: a document that needs no page images is retried
  // exactly as it always was — re-hydrated (so the path is uniform) but
  // handed to the extractor with no images, because it needs none.
  it('retries a document with a healthy text layer unchanged, with no page images invented for it', async () => {
    getDocumentMock.mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockResolvedValue(new Blob(['This is the contract text.'], { type: 'text/plain' }));

    await openReview();
    retryC1();
    await flush();

    expect(retryCellMock).toHaveBeenCalled();
    const docHandedToExtractor = retryCellMock.mock.calls[0][1] as DocumentFile;
    expect(docHandedToExtractor.id).toBe('d1');
    expect(docHandedToExtractor.text).toBe('This is the contract text.');
    // Absence, not `undefined`: `structuredClone` (how IndexedDB writes every
    // record) preserves an `undefined`-valued key, and `toEqual` cannot tell
    // the two apart.
    expect('pageImages' in docHandedToExtractor).toBe(false);
    expect('parseError' in docHandedToExtractor).toBe(false);
  });

  // Required assertion 5: pinned here as well as in the suites above,
  // because the re-hydration is inserted between the reset and the call to
  // `retryCell`, and the run that reaches `retryCell` must still be the one
  // carrying the reset — not a re-read of `latestRunRef.current`.
  it('still resets a verified finding and its confirmed net position across the re-hydration', async () => {
    const confirmed = confirmPosition(
      unconfirmedPosition('Notice is now 6 months.', [
        { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
      ]),
      'u1',
      100,
    );
    const review = makeReview();
    getReviewMock.mockResolvedValue({
      ...review,
      findings: { d1: { ...review.findings.d1, c1: { ...review.findings.d1.c1, netPosition: confirmed } } },
    });
    documentFileForReviewMock.mockResolvedValue(reviewHydratedScan());

    await openReview();
    retryC1();
    await flush();

    expect(retryCellMock).toHaveBeenCalled();
    const runPassedIn = retryCellMock.mock.calls[0][0] as ReviewRun;
    expect(runPassedIn.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
    expect(runPassedIn.findings.d1.c1.netPosition?.state).toBe('unconfirmed');
    const position = runPassedIn.findings.d1.c1.netPosition;
    expect(position && 'byUserId' in position).toBe(false);
    // The retried cell is busy in that same run — the reset and the busy
    // state are one snapshot, not two competing ones.
    expect(runPassedIn.findings.d1.c1.status).toBe('running');
    // ...and an unrelated clause is untouched by either.
    expect(runPassedIn.findings.d1.c2.verification).toEqual({ state: 'verified', byUserId: 'u1', at: 200 });
  });
});
