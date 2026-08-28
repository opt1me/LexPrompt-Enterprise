import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, PlaybookVersion, TrailStep } from './types';
import { unconfirmedPosition } from './lib/netPosition';
import { flushUntil } from './test/mount';

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
const migrateIfNeededMock = vi.fn();

// Captures the debounced saver's `scheduleSave` calls for the live-run test
// below, mirroring App.reviewSaveError.test.tsx's capture of `onError`.
// `saveNowMock` is captured the same way (Critical 1's fix site) so a test
// can assert on the *final* write a completed run makes, not just the
// mid-run debounced ones.
let scheduleSaveMock: ReturnType<typeof vi.fn>;
let saveNowMock: ReturnType<typeof vi.fn>;
const createDebouncedReviewSaverMock = vi.fn((..._args: unknown[]) => {
  scheduleSaveMock = vi.fn();
  saveNowMock = vi.fn().mockResolvedValue(undefined);
  return {
    scheduleSave: scheduleSaveMock,
    saveNow: saveNowMock,
    dispose: vi.fn(),
  };
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
  createDebouncedReviewSaver: (...args: unknown[]) => createDebouncedReviewSaverMock(...args),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

const extractClauseMock = vi.fn();
vi.mock('./features/review/extractClause', () => ({
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
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
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
    let resolveSave: (() => void) | undefined;
    saveReviewMock.mockImplementation(() => new Promise<void>(resolve => { resolveSave = () => resolve(); }));

    await openReview();

    expect(container.textContent).toMatch(/unconfirmed/i);

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    // The write is in flight — the badge must NOT have flipped yet
    // (await-then-apply).
    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    expect(persisted.findings.d1.c1.netPosition.state).toBe('confirmed');
    expect(container.textContent).toMatch(/unconfirmed/i);

    resolveSave!();
    await flush();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);
  });

  it('does not show a confirmation the store rejected, and says so', async () => {
    saveReviewMock.mockRejectedValue(new Error('Storage quota exceeded'));

    await openReview();

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    expect(container.textContent).toMatch(/unconfirmed/i);
    expect(container.textContent).not.toMatch(/\bconfirmed\b/i);
    expect(container.textContent).toContain('Storage quota exceeded');
  });

  it('records the local profile id and a timestamp against the confirmation', async () => {
    getProfileMock.mockResolvedValue({ id: 'u42', name: 'Someone Else', initials: 'SE' });

    await openReview();

    const before = Date.now();
    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    const persisted = saveReviewMock.mock.calls[0][0];
    const netPosition = persisted.findings.d1.c1.netPosition;
    expect(netPosition.byUserId).toBe('u42');
    expect(typeof netPosition.at).toBe('number');
    expect(netPosition.at).toBeGreaterThanOrEqual(before);
  });

  it('amends a net position with the human\'s text, marked stronger than a plain confirmation', async () => {
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

    const persisted = saveReviewMock.mock.calls[0][0];
    const netPosition = persisted.findings.d1.c1.netPosition;
    expect(netPosition.amended).toBe('Notice is actually 3 months.');
    expect(netPosition.state).toBe('confirmed');
    expect(container.textContent).toContain('Notice is actually 3 months.');
    expect(container.textContent).toMatch(/amended/i);
  });

  // Mutation test 3 (task-8-brief step 3): dropping `carryHumanState`'s new
  // net-position awareness must make this fail. c1 resolves immediately (so
  // it can be confirmed while the run is still live); c2 stays pending until
  // released, standing in for "some other cell finishing" after the
  // confirmation has already been written — `runReview`'s own onUpdate,
  // which knows nothing about it and would otherwise silently revert it.
  it('does not lose a net position confirmation to the next update from a live run', async () => {
    let resolveC2: ((finding: unknown) => void) | undefined;
    extractClauseMock.mockImplementation((_doc: unknown, clause: { id: string }) => {
      if (clause.id === 'c1') {
        return Promise.resolve({
          clauseId: 'c1',
          status: 'done',
          citations: [],
          summary: 'irrelevant',
          verification: { state: 'unchecked' },
          notes: [],
          netPosition: unconfirmedPosition('Notice is now 6 months.', TRAIL),
        });
      }
      return new Promise((resolve) => { resolveC2 = resolve; });
    });

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    expect(container.textContent).toMatch(/unconfirmed/i);

    act(() => { findButton(container, /^Confirm$/, 0).click(); });
    await flush();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);

    // c2 finishes — the run's own onUpdate, carrying a snapshot in which c1
    // has no net position at all (a plain finding, per `extractClauseMock`'s
    // default shape for c2 above). Without `carryHumanState` knowing about
    // `netPosition`, this would silently overwrite the confirmation.
    act(() => { resolveC2!({
      clauseId: 'c2',
      status: 'done',
      citations: [],
      summary: 'irrelevant',
      verification: { state: 'unchecked' },
      notes: [],
    }); });
    await flush();

    expect(container.textContent).not.toMatch(/unconfirmed/i);
    expect(container.textContent).toMatch(/\bconfirmed\b/i);
  });
});

describe('App — persisting a verification (Task 10, spec section 9)', () => {
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
    extractClauseMock.mockReset();
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
    let resolveSave: (() => void) | undefined;
    saveReviewMock.mockImplementation(() => new Promise<void>(resolve => { resolveSave = () => resolve(); }));

    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    // Two done findings, both unverified before anything happens.
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // The write is in flight (saveReview called, not yet resolved) — the
    // chip must NOT have flipped to Verified yet (await-then-apply).
    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    expect(persisted.findings.d1.c1.verification.state).toBe('verified');
    expect(chips()[0].textContent).toBe('Unverified');

    resolveSave!();
    await flush();

    expect(chips()[0].textContent).toBe('Verified');
  });

  it('does not show a verification the store rejected, and says so', async () => {
    saveReviewMock.mockRejectedValue(new Error('Storage quota exceeded'));

    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    const chips = Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips[0].textContent).toBe('Unverified');
    expect(container.textContent).toContain('Storage quota exceeded');
  });

  it('records the local profile id and a timestamp against the verification', async () => {
    getProfileMock.mockResolvedValue({ id: 'u42', name: 'Someone Else', initials: 'SE' });
    saveReviewMock.mockResolvedValue(undefined);

    await openReview();

    const before = Date.now();
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    const verification = persisted.findings.d1.c1.verification;
    expect(verification.byUserId).toBe('u42');
    expect(typeof verification.at).toBe('number');
    expect(verification.at).toBeGreaterThanOrEqual(before);
  });

  it('Minor 2: does not reattribute the review\'s createdByUserId to whoever verifies or adds a note', async () => {
    // makeReview()'s createdByUserId is 'u1'; the acting user here is a
    // different profile ('u42') to prove the two are not conflated.
    getProfileMock.mockResolvedValue({ id: 'u42', name: 'Someone Else', initials: 'SE' });
    saveReviewMock.mockResolvedValue(undefined);

    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    expect(persisted.findings.d1.c1.verification.byUserId).toBe('u42');
    // The review's authorship must be untouched by a later verification.
    expect(persisted.createdByUserId).toBe('u1');
  });

  it('persists a note the same way, and does not show one the store rejected', async () => {
    saveReviewMock.mockResolvedValue(undefined);
    await openReview();

    const textarea = () => container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;

    act(() => { setTextareaValue(textarea(), 'Check this against the side letter.'); });
    act(() => { findButton(container, /Add note/i, 0).click(); });
    await flush();

    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    expect(persisted.findings.d1.c1.notes).toHaveLength(1);
    expect(persisted.findings.d1.c1.notes[0].text).toBe('Check this against the side letter.');
    expect(container.textContent).toContain('Check this against the side letter.');

    // Now a rejected write: the new note must not appear anywhere, and the
    // failure must be named.
    saveReviewMock.mockReset().mockRejectedValue(new Error('Disk full'));
    act(() => { setTextareaValue(textarea(), 'This one should not stick.'); });
    act(() => { findButton(container, /Add note/i, 0).click(); });
    await flush();

    expect(container.textContent).not.toContain('This one should not stick.');
    expect(container.textContent).toContain('Disk full');
    // The earlier, successfully-saved note is untouched by the failure.
    expect(container.textContent).toContain('Check this against the side letter.');
  });

  it('does not lose a verification to the next update from a live run', async () => {
    // c1 resolves immediately (so it can be verified while the run is still
    // live); c2 stays pending until released, standing in for "some other
    // cell finishing" after the verification has already been written.
    let resolveC2: ((finding: unknown) => void) | undefined;
    extractClauseMock.mockImplementation((_doc: unknown, clause: { id: string }) => {
      if (clause.id === 'c1') {
        return Promise.resolve({
          clauseId: 'c1',
          status: 'done',
          citations: [{ quote: 'x', documentId: 'live-doc' }],
          summary: 'Governed by NY law.',
          verification: { state: 'unchecked' },
          notes: [],
        });
      }
      return new Promise((resolve) => { resolveC2 = resolve; });
    });

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();

    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    // c1 has resolved to `done`; c2 is still pending/running. Verify c1 now,
    // while the run is still live.
    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips().length).toBeGreaterThan(0);
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(chips()[0].textContent).toBe('Verified');

    const verifyWriteCount = saveReviewMock.mock.calls.length;
    expect(verifyWriteCount).toBeGreaterThan(0);
    expect(saveReviewMock.mock.calls[verifyWriteCount - 1][0].findings['live-doc'].c1.verification.state).toBe('verified');

    // Now let the other cell (c2) finish — this is `runReview`'s own
    // "unrelated cell finishing" onUpdate, carrying a snapshot in which c1
    // is still `unchecked` per `runReview`'s own bookkeeping. Without
    // `carryHumanState`, this would silently overwrite the verification
    // just written.
    act(() => { resolveC2!({
      clauseId: 'c2',
      status: 'done',
      citations: [],
      summary: 'Term is 12 months.',
      verification: { state: 'unchecked' },
      notes: [],
    }); });
    await flush();

    expect(chips()[0].textContent).toBe('Verified');
    // The debounced mid-run saver must also have received the merged run —
    // not the raw, unchecked snapshot `runReview` produced — or a reload
    // mid-run would still lose the verification to the next debounced save.
    expect(scheduleSaveMock).toHaveBeenCalled();
    const lastScheduled = scheduleSaveMock.mock.calls[scheduleSaveMock.mock.calls.length - 1][0];
    expect(lastScheduled.findings['live-doc'].c1.verification.state).toBe('verified');
  });

  it('Critical 1: the run completion save holds a verification made during the run, not runReview\'s own unmerged snapshot', async () => {
    // Same setup as the previous test — c1 resolves immediately so it can be
    // verified while the run is still live, c2 stays pending until released
    // — but this time c2 is released with `runReview`'s own `onUpdate`
    // eventually resolving the whole run, so the FINAL save (`saveNow`, not
    // the debounced `scheduleSave`) is the thing under test. `runReview`
    // builds every Finding with `unchecked()`; the run's own return value
    // never sees the verification written mid-run. `persistFinal` must not
    // hand `saveNow` that raw return value.
    let resolveC2: ((finding: unknown) => void) | undefined;
    extractClauseMock.mockImplementation((_doc: unknown, clause: { id: string }) => {
      if (clause.id === 'c1') {
        return Promise.resolve({
          clauseId: 'c1',
          status: 'done',
          citations: [{ quote: 'x', documentId: 'live-doc' }],
          summary: 'Governed by NY law.',
          verification: { state: 'unchecked' },
          notes: [],
        });
      }
      return new Promise((resolve) => { resolveC2 = resolve; });
    });

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();

    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(chips()[0].textContent).toBe('Verified');

    // Finish the run: c2 resolves, `runReview`'s promise resolves, and
    // `persistFinal` fires the run's completion save.
    act(() => { resolveC2!({
      clauseId: 'c2',
      status: 'done',
      citations: [],
      summary: 'Term is 12 months.',
      verification: { state: 'unchecked' },
      notes: [],
    }); });
    await flush();

    expect(saveNowMock).toHaveBeenCalled();
    const finalSaved = saveNowMock.mock.calls[saveNowMock.mock.calls.length - 1][0];
    expect(finalSaved.findings['live-doc'].c1.verification.state).toBe('verified');
  });

  it('Important 1: handleVerify does not lose a run update that lands while its own save is in flight', async () => {
    // Three clauses so the run stays live throughout: c1 resolves
    // immediately (so it can be verified while live), c2 resolves INSIDE
    // the verify write's own await window (reproducing the exact race —
    // `handleVerify` reads `latestRunRef`, then crosses `getProfile()` and
    // `saveReview()`, before ever writing it back), and c3 never resolves,
    // so the run itself does not complete and dispose its saver out from
    // under this test's assertions on it.
    let resolveC2: ((finding: unknown) => void) | undefined;
    extractClauseMock.mockImplementation((_doc: unknown, clause: { id: string }) => {
      if (clause.id === 'c1') {
        return Promise.resolve({
          clauseId: 'c1',
          status: 'done',
          citations: [{ quote: 'x', documentId: 'live-doc' }],
          summary: 'Governed by NY law.',
          verification: { state: 'unchecked' },
          notes: [],
        });
      }
      if (clause.id === 'c2') {
        return new Promise((resolve) => { resolveC2 = resolve; });
      }
      return new Promise(() => { /* c3: never resolves, keeps the run live. */ });
    });

    const threeClauseTemplate: PlaybookVersion = {
      ...makeTemplate(),
      clauses: [...makeTemplate().clauses, { id: 'c3', title: 'Indemnity', extractPrompt: 'Extract the indemnity clause.' }],
    };

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([threeClauseTemplate]);
    listMattersMock.mockResolvedValue([makeMatter()]);

    // Holds the verify write's own `saveReview` open, so c2's onUpdate can
    // land on `latestRunRef` before `handleVerify` writes it back.
    let resolveSave: (() => void) | undefined;
    saveReviewMock.mockImplementation(() => new Promise<void>(resolve => { resolveSave = () => resolve(); }));

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(saveReviewMock).toHaveBeenCalled();

    // c2 finishes INSIDE the write's await window — the run's own onUpdate,
    // which the old code let clobber `latestRunRef` once the write's own
    // await resolved.
    act(() => { resolveC2!({
      clauseId: 'c2',
      status: 'done',
      citations: [],
      summary: 'Term is 12 months.',
      verification: { state: 'unchecked' },
      notes: [],
    }); });
    await flush();

    // Now let the verification's own write resolve.
    resolveSave!();
    await flush();

    // Both must survive: this write's own verification, and c2's newer,
    // unrelated status. The old code overwrote `latestRunRef` here with the
    // pre-await snapshot, which still had c2 `running` — reverting an
    // already-finished clause back to a skeleton card on screen.
    expect(chips()[0].textContent).toBe('Verified');
    expect(container.textContent).toContain('Term is 12 months.');

    // Item 2: the merged, post-race state is reasserted through the run's
    // own debounced saver, not just local state — closing the gap where a
    // stale, already-armed `scheduleSave` payload (from before this write)
    // could otherwise fire afterward and silently reassert the older data
    // in storage even though the screen shows the new one.
    const lastScheduled = scheduleSaveMock.mock.calls[scheduleSaveMock.mock.calls.length - 1][0];
    expect(lastScheduled.findings['live-doc'].c1.verification.state).toBe('verified');
    expect(lastScheduled.findings['live-doc'].c2.status).toBe('done');
    // c3 never resolved — the run is genuinely still live here, so this
    // assertion is exercising an armed saver, not a leftover from a
    // completed run's final save.
    expect(lastScheduled.findings['live-doc'].c3.status).not.toBe('done');
  });

  it('Item 2: a post-completion write does not reassert through, or re-arm, the run\'s (now-disposed) saver', async () => {
    // Ordinary two-clause template: both clauses resolve immediately, so the
    // run completes and `persistFinal` disposes its saver and clears
    // `activeRunSaverRef` before this test ever verifies anything.
    extractClauseMock.mockImplementation((_doc: unknown, clause: { id: string }) => Promise.resolve({
      clauseId: clause.id,
      status: 'done',
      citations: clause.id === 'c1' ? [{ quote: 'x', documentId: 'live-doc' }] : [],
      summary: clause.id === 'c1' ? 'Governed by NY law.' : 'Term is 12 months.',
      verification: { state: 'unchecked' },
      notes: [],
    }));

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    // The run has already completed and disposed its saver.
    expect(saveNowMock).toHaveBeenCalled();
    const scheduleCallsBefore = scheduleSaveMock.mock.calls.length;

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Verified');
    // The direct write itself still happens...
    expect(saveReviewMock).toHaveBeenCalled();
    // ...but `activeRunSaverRef` is null by now, so the reschedule added by
    // Item 2 is the no-op it has to be: no new call, and (implicitly, since
    // nothing here ever throws) no timer armed against a saver nothing will
    // ever dispose again.
    expect(scheduleSaveMock.mock.calls.length).toBe(scheduleCallsBefore);
  });

  it('Critical 1 (abort path): a cancelled run\'s completion save still holds a verification made during it', async () => {
    // c1 resolves immediately (so it can be verified while the run is still
    // live); c2 hangs until the run's own AbortController fires, then
    // rejects the way a real in-flight fetch would (the same pattern
    // App.matterDelete.test.tsx uses to reach this same `persistFinal` call
    // site from a different trigger). The re-review's own gap: the success
    // path above is covered, but nothing exercised the abort path's use of
    // `latestRunRef.current` in `persistFinal`.
    extractClauseMock.mockImplementation(
      (_doc: unknown, clause: { id: string }, _template: unknown, _settings: unknown, signal?: AbortSignal) => {
        if (clause.id === 'c1') {
          return Promise.resolve({
            clauseId: 'c1',
            status: 'done',
            citations: [{ quote: 'x', documentId: 'live-doc' }],
            summary: 'Governed by NY law.',
            verification: { state: 'unchecked' },
            notes: [],
          });
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    );

    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Playbooks$/i, 0).click(); });
    await flush();
    act(() => { findButton(container, /^Run Basic Contract Review$/, 0).click(); });
    await flush();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();
    expect(chips()[0].textContent).toBe('Verified');

    // Cancel the run while c2 is still stuck — this is the abort path.
    act(() => { findButton(container, /^Cancel$/, 0).click(); });
    await flush();

    expect(saveNowMock).toHaveBeenCalled();
    const finalSaved = saveNowMock.mock.calls[saveNowMock.mock.calls.length - 1][0];
    expect(finalSaved.findings['live-doc'].c1.verification.state).toBe('verified');
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
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
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
    let resolveSave: (() => void) | undefined;
    saveReviewMock.mockImplementation(() => new Promise<void>(resolve => { resolveSave = () => resolve(); }));

    await openReview();

    const chips = () => Array.from(container.querySelectorAll('[role="status"]'));
    expect(chips()[0].textContent).toBe('Unverified');

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    // The write is in flight — persisted under 'coll-1', never under 'd1' or
    // 'd2' (the active document in the viewer pane, which is what `onVerify`
    // is actually called with).
    expect(saveReviewMock).toHaveBeenCalled();
    const persisted = saveReviewMock.mock.calls[0][0];
    expect('coll-1' in persisted.findings).toBe(true);
    expect(persisted.findings['coll-1'].c1.verification.state).toBe('verified');
    expect('d1' in persisted.findings).toBe(false);
    expect('d2' in persisted.findings).toBe(false);

    // await-then-apply: not shown on screen until the write resolves.
    expect(chips()[0].textContent).toBe('Unverified');

    resolveSave!();
    await flush();

    // The round trip: written under the collection key, and read back from
    // that same key onto the screen.
    expect(chips()[0].textContent).toBe('Verified');
  });

  it('leaves the OTHER clause\'s finding, under the same collection key, untouched', async () => {
    await openReview();

    act(() => { findButton(container, /^Verify$/, 0).click(); });
    await flush();

    const persisted = saveReviewMock.mock.calls[0][0];
    expect(persisted.findings['coll-1'].c2.verification).toEqual({ state: 'unchecked' });
  });
});
