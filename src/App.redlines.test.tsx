import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Playbook, PlaybookVersion, Changeset, ChangesetItem } from './types';
import type { InferredPosition, OpenQuestion } from './lib/inferPositions';
import type { ParsedEdit } from './lib/docxRedlines';

// No @testing-library/react in this project — a real react-dom root, driven
// directly, exactly as App.authoring.test.tsx does for sub-project E's own
// "reachable from the running app" tests. This file is F's counterpart:
// Task 10A's brief names this file's job explicitly — "the test that would
// have caught this defect is an App-level one that reaches each screen from
// the chooser".
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();
const listPlaybooksMock = vi.fn();
const getPlaybookMock = vi.fn();
const getPlaybookContentMock = vi.fn();
const publishAndPointMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const listModelsMock = vi.fn();
const parseFileMock = vi.fn();
const parseDocxRedlinesMock = vi.fn();
const inferPositionsMock = vi.fn();
const buildChangesetMock = vi.fn();
const saveChangesetMock = vi.fn();
const recordDecisionMock = vi.fn();
const publishChangesetMock = vi.fn();
const getChangesetMock = vi.fn();
const addDocumentMock = vi.fn();
const getDocumentBlobMock = vi.fn();

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: (...args: unknown[]) => getPlaybookMock(...args),
  getPlaybookContent: (...args: unknown[]) => getPlaybookContentMock(...args),
  publishAndPoint: (...args: unknown[]) => publishAndPointMock(...args),
  savePlaybook: vi.fn(),
  publishVersion: vi.fn(),
  deletePlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
  getMatter: vi.fn(),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: vi.fn(),
  saveReview: vi.fn(),
  createDebouncedReviewSaver: () => ({ save: vi.fn(), flush: vi.fn(), cancel: vi.fn() }),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: async () => ({ id: 'u1', initials: 'AB', name: 'A B' }),
}));

vi.mock('./lib/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/openrouter')>()),
  listModels: (...args: unknown[]) => listModelsMock(...args),
}));

// The only route by which a precedent document's bytes could ever reach
// durable storage — spied on, not implemented, so a write shows up as a
// call rather than quietly succeeding (same reasoning as
// App.authoring.test.tsx's `savePlaybookMock`/`publishVersionMock`).
vi.mock('./lib/db/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/documents')>()),
  addDocument: (...args: unknown[]) => addDocumentMock(...args),
}));

vi.mock('./lib/db/blobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/blobs')>()),
  getDocumentBlob: (...args: unknown[]) => getDocumentBlobMock(...args),
}));

// `parseFile` (lib/documents.ts) never persists anything on its own — real
// pdfjs/mammoth parsing is simply not exercisable in jsdom, so it is mocked
// at the module boundary, mirroring `generateDraft`'s treatment in
// App.authoring.test.tsx: the network/parsing internals have their own
// suites, and this file only needs a stand-in that returns extracted text.
vi.mock('./lib/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/documents')>()),
  parseFile: (...args: unknown[]) => parseFileMock(...args),
}));

vi.mock('./lib/docxRedlines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/docxRedlines')>()),
  parseDocxRedlines: (...args: unknown[]) => parseDocxRedlinesMock(...args),
}));

vi.mock('./lib/inferPositions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/inferPositions')>()),
  inferPositions: (...args: unknown[]) => inferPositionsMock(...args),
}));

vi.mock('./lib/buildChangeset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/buildChangeset')>()),
  buildChangeset: (...args: unknown[]) => buildChangesetMock(...args),
}));

vi.mock('./lib/db/changesets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/changesets')>()),
  saveChangeset: (...args: unknown[]) => saveChangesetMock(...args),
  recordDecision: (...args: unknown[]) => recordDecisionMock(...args),
  publishChangeset: (...args: unknown[]) => publishChangesetMock(...args),
  getChangeset: (...args: unknown[]) => getChangesetMock(...args),
}));

import App from './App';

const SETTINGS_KEY = 'lexprompt.settings';

const emptyPlaybook: Playbook = {
  id: 'pb-new',
  name: 'Learned from redlines',
  createdAt: 1,
  updatedAt: 1,
  currentVersionId: 'v1-new',
  schemaVersion: 1,
};

const emptyVersion: PlaybookVersion = {
  id: 'v1-new',
  playbookId: 'pb-new',
  version: 1,
  name: 'Learned from redlines',
  contractType: 'Custom',
  systemPrompt: 'sys',
  formatPrompt: 'fmt',
  clauses: [],
  changeSummary: '',
  publishedAt: 1,
  publishedByUserId: 'u1',
  schemaVersion: 1,
};

function edit(overrides: Partial<ParsedEdit> = {}): ParsedEdit {
  return {
    kind: 'deletion',
    text: 'confidential for five years',
    context: 'Confidential information shall remain confidential for five years.',
    ...overrides,
  };
}

function consistentPosition(): InferredPosition {
  return {
    id: 'p1',
    clauseTitle: 'Confidentiality period',
    statement: 'We strike an indefinite confidentiality tail in favour of a fixed term.',
    strength: 'consistent',
    supporting: 2,
    total: 2,
    basis: [
      { documentId: 'd1', supports: true, edits: [edit()] },
      { documentId: 'd2', supports: true, edits: [edit()] },
    ],
    contradicted: false,
    disposition: 'undecided',
    diffDerivedOnly: false,
  };
}

function openQuestion(): OpenQuestion {
  return {
    id: 'q1',
    clauseTitle: 'Break clause',
    question: 'This clause was never amended — do you have a position on it, or is this open?',
  };
}

function changesetItem(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return {
    id: 'i1',
    kind: 'new_clause',
    title: 'Confidentiality period',
    proposedText: 'Confidentiality survives for a fixed term of five years, not indefinitely.',
    rationale: 'Both deals struck the indefinite confidentiality tail.',
    basis: [{
      documentId: 'd1',
      kind: 'deletion',
      text: 'confidential for five years',
      context: 'Confidential information shall remain confidential for five years.',
      clauseRef: 'Confidentiality period',
      source: 'tracked',
    }],
    decision: 'open',
    ...overrides,
  };
}

function unpublishedChangeset(): Changeset {
  return {
    id: 'cs1',
    playbookId: 'pb-new',
    fromVersionId: 'v1-new',
    sourceSummary: 'Learned from 1 document across 1 chain',
    items: [changesetItem()],
    createdAt: Date.now(),
    createdByUserId: 'u1',
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonNamed(name: RegExp): HTMLButtonElement | undefined {
  return buttons().find(b =>
    name.test((b.textContent || '').trim()) || name.test(b.getAttribute('aria-label') || ''));
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click() was given nothing to click.');
  act(() => { (el as HTMLElement).click(); });
}

/** Simulates picking one file in `PrecedentUploadPanel`'s
 *  `<input type="file">` — jsdom's own file-picker cannot be driven, so a
 *  `FileList`-shaped value is installed directly and a `change` event is
 *  dispatched, the standard way to exercise a file input in this
 *  environment. */
function selectFile(file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) throw new Error('No file input is on screen.');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

/** Library → Create Template → Learn from redlines. Leaves the app on
 *  precedent intake. */
async function openRedlinesIntake() {
  act(() => { root.render(<App />); });
  await flush();
  click(buttonNamed(/^playbooks$/i));
  await flush();
  click(buttonNamed(/create template/i));
  click(buttonNamed(/learn from redlines/i));
  await flush();
}

/** Brings in one marked-up `.docx`, then clicks Continue — leaves the app on
 *  "What we learned". */
async function reachWhatWeLearned() {
  await openRedlinesIntake();
  selectFile(new File(['x'], 'Brookvale - our markup.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }));
  await flush();
  click(buttonNamed(/^continue$/i));
  await flush();
}

/** ...through to a built (unpublished) changeset. */
async function reachTheChangeset() {
  await reachWhatWeLearned();
  click(buttonNamed(/^adopt$/i));
  click(buttonNamed(/build changeset/i));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-test', modelId: 'test/model' }));
  migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
  listPlaybooksMock.mockReset().mockResolvedValue([]);
  getPlaybookMock.mockReset().mockResolvedValue(null);
  getPlaybookContentMock.mockReset().mockResolvedValue(null);
  publishAndPointMock.mockReset().mockResolvedValue({ playbook: emptyPlaybook, version: emptyVersion });
  listMattersMock.mockReset().mockResolvedValue([]);
  listReviewsMock.mockReset().mockResolvedValue([]);
  listModelsMock.mockReset().mockResolvedValue([]);

  parseFileMock.mockReset().mockImplementation(async (file: File) => ({
    id: 'df1', name: file.name, text: `TEXT OF ${file.name}`, file, kind: 'docx' as const,
  }));
  parseDocxRedlinesMock.mockReset().mockResolvedValue({ edits: [edit()], hasMarkup: true });
  inferPositionsMock.mockReset().mockResolvedValue({
    positions: [consistentPosition()],
    questions: [openQuestion()],
  });
  buildChangesetMock.mockReset().mockResolvedValue(unpublishedChangeset());
  saveChangesetMock.mockReset().mockImplementation(async (cs: Changeset) => cs);
  recordDecisionMock.mockReset().mockImplementation(async (
    cs: Changeset, itemId: string, decision: ChangesetItem['decision'], rewordedText?: string,
  ) => ({
    ...cs,
    items: cs.items.map((i) => (i.id === itemId
      ? { ...i, decision, ...(decision === 'reworded' ? { rewordedText } : {}) }
      : i)),
  }));
  publishChangesetMock.mockReset().mockResolvedValue({ ...emptyVersion, id: 'v2-new', version: 2 });
  getChangesetMock.mockReset().mockImplementation(async (id: string) => ({
    ...unpublishedChangeset(),
    id,
    items: [changesetItem({ decision: 'accepted' })],
    publishedVersionId: 'v2-new',
  }));
  addDocumentMock.mockReset();
  getDocumentBlobMock.mockReset().mockResolvedValue(null);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

// Task 10A: sub-project F was built, tested and committed with no path to it
// from the running app — the chooser's third card still read "Not built
// yet". These tests exercise that path, not the pieces behind it (each of
// which has its own suite already).
describe('the redlines route is reachable from the chooser (Task 10A)', () => {
  it('offers "Learn from redlines" enabled, and clicking it opens precedent intake', async () => {
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));

    const redlinesCard = buttonNamed(/learn from redlines/i);
    expect(redlinesCard).toBeTruthy();
    expect(redlinesCard!.getAttribute('aria-disabled')).toBe('false');

    click(redlinesCard);
    await flush();

    expect(container.textContent).toMatch(/bring in what you negotiated/i);
  });

  it('reaches "What we learned" after bringing in a document and continuing', async () => {
    await reachWhatWeLearned();

    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
    expect(container.textContent).toContain('Confidentiality period');
    // The open question the redlines never settled — never an adoptable
    // position (spec §11).
    expect(container.textContent).toMatch(/break clause/i);
  });

  it('opens "the workings" for a position and can adopt it from there', async () => {
    await reachWhatWeLearned();
    click(buttonNamed(/see the workings/i));
    await flush();

    expect(container.textContent).toMatch(/will not adopt a position they cannot see the workings for/i);
    click(buttonNamed(/^adopt$/i));

    click(buttonNamed(/back to what we learned/i));
    await flush();
    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
  });

  it('builds a changeset from an adopted position and reaches changeset review', async () => {
    await reachTheChangeset();

    expect(buildChangesetMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/nothing changes .* until you publish/i);
    expect(container.textContent).toContain('Confidentiality period');
  });

  it('publishes the changeset, producing a new version through the existing changeset path', async () => {
    await reachTheChangeset();
    click(buttonNamed(/^accept$/i));
    await flush();
    click(buttonNamed(/^publish v2$/i));
    await flush();

    expect(publishChangesetMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/published/i);
  });
});

// Spec §4/§11: "precedent documents are read once and are not stored with
// the playbook". Mutation-tested by hand while building this task (calling
// `addDocument` from inside `handleAddRedlinesFiles` made this test fail,
// as expected, before being reverted) — see the Task 10A report for the
// specific mutation.
describe('a precedent document is read and never stored (spec §4, §11)', () => {
  it('never calls addDocument/getDocumentBlob and writes nothing new to localStorage across the whole flow', async () => {
    await reachTheChangeset();
    click(buttonNamed(/^accept$/i));
    await flush();
    click(buttonNamed(/^publish v2$/i));
    await flush();

    expect(addDocumentMock).not.toHaveBeenCalled();
    expect(getDocumentBlobMock).not.toHaveBeenCalled();

    // Only the settings blob that was there before the session started —
    // no key holding a document's name or extracted text under any name.
    const keys = Object.keys(localStorage);
    expect(keys).toEqual([SETTINGS_KEY]);
    for (const key of keys) {
      expect(localStorage.getItem(key)).not.toMatch(/Brookvale|TEXT OF/);
    }
  });
});
