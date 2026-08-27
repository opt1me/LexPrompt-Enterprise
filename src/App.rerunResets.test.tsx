import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, Template, TrailStep, Collection } from './types';
import { unconfirmedPosition, confirmPosition } from './lib/netPosition';
// Deliberately UNMOCKED: Task 8A's App-level collection-retry tests (bottom
// of this file) need `getCollection` to run for real against fake-indexeddb
// (this project's standard test setup — `vitest.setup.ts`), exercising the
// actual `openReview` reconstruction path rather than a stand-in for it.
import { saveCollection } from './lib/db/collections';
import { closeDb } from './lib/db/open';

// No @testing-library/react in this project — see App.interrupted.test.tsx
// for the precedent this follows: drive a real react-dom root directly,
// mocking App.tsx's repository/module boundaries.
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

import App from './App';
import type { DocumentFile, ReviewRun, Settings } from './types';

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
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    // Simulates the real `retryCell`'s shape (a 'running' onUpdate, then a
    // fresh, unchecked, note-free 'done' finding) closely enough to drive
    // App.tsx's own retry-handling code paths, while leaving the `run`
    // App.tsx passed in (this mock's first argument) inspectable — that run
    // is what `retryCellMock.mock.calls[...][0]` checks below.
    retryCellMock.mockReset().mockImplementation(async (
      retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: Settings, onUpdate: (r: ReviewRun) => void,
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
    await flush();
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
        retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: Settings, onUpdate: (r: ReviewRun) => void,
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
        retryRun: ReviewRun, doc: DocumentFile, clauseId: string, _settings: Settings, onUpdate: (r: ReviewRun) => void,
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
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
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
    await flush();
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

  it('refuses the retry, without calling retryCell, when the collection record cannot be reloaded', async () => {
    // Deliberately no `saveCollection` call — `getCollection('coll-1')`
    // genuinely resolves null here, mirroring a deleted or unreachable
    // collection. Falling back to `extractClause` in this situation would be
    // exactly the silent, confidently-wrong single-document answer this
    // sub-project exists to prevent.
    await openReview();

    act(() => { findButton(container, /^Retry$/i, 0).click(); });
    await flush();

    expect(retryCellMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/could not be prepared for retry/i);
  });
});
