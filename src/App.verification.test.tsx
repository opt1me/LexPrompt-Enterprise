import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, Template } from './types';

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
  createDebouncedReviewSaver: (...args: unknown[]) => createDebouncedReviewSaverMock(...args),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

vi.mock('./lib/openrouter', () => ({
  listModels: vi.fn().mockResolvedValue([]),
  isAuthError: () => false,
}));

const extractClauseMock = vi.fn();
vi.mock('./features/review/extractClause', () => ({
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
}));

// Only exercised by the live-run test at the bottom of this file — drives a
// run without a real file upload, mirroring App.reviewSaveError.test.tsx.
vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: Template[]; onRun: (t: Template) => void }) => (
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
    await flush();
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

    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();

    act(() => { findButton(container, /^Library$/i, 0).click(); });
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

    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();

    act(() => { findButton(container, /^Library$/i, 0).click(); });
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

    const threeClauseTemplate: Template = {
      ...makeTemplate(),
      clauses: [...makeTemplate().clauses, { id: 'c3', title: 'Indemnity', prompt: 'Extract the indemnity clause.' }],
    };

    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([threeClauseTemplate]);
    listMattersMock.mockResolvedValue([makeMatter()]);

    // Holds the verify write's own `saveReview` open, so c2's onUpdate can
    // land on `latestRunRef` before `handleVerify` writes it back.
    let resolveSave: (() => void) | undefined;
    saveReviewMock.mockImplementation(() => new Promise<void>(resolve => { resolveSave = () => resolve(); }));

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Library$/i, 0).click(); });
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

    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Library$/i, 0).click(); });
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

    localStorage.setItem('lexprompt.settings', JSON.stringify({ apiKey: 'sk-or-v1-test', modelId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makeTemplate()]);
    listMattersMock.mockResolvedValue([makeMatter()]);
    saveReviewMock.mockResolvedValue(undefined);

    act(() => { root.render(<App />); });
    await flush();
    act(() => { findButton(container, /^Library$/i, 0).click(); });
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
