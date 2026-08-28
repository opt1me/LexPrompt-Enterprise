import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Playbook, PlaybookDraft, PlaybookVersion } from './types';
import type { InferredPosition } from './lib/inferPositions';
import type { ParsedEdit } from './lib/docxRedlines';
import { type as typeInto } from './test/mount';

// No @testing-library/react in this project — a real react-dom root, driven
// directly, exactly as App.authoring.test.tsx does for sub-project E's own
// "reachable from the running app" tests. This file is F's counterpart:
// Task 10A's brief names this file's job explicitly — "the test that would
// have caught this defect is an App-level one that reaches each screen from
// the chooser".
//
// Task 10A-fix. Task 10A reached F's CHANGESET mechanism from here, which
// required a live `PlaybookVersion`, so it minted a playbook and published
// an EMPTY v1 before the person had decided anything. These tests now drive
// the corrected path — adopted positions become E's `AuthoringDraft`,
// reviewed in `DraftReview` and published as a genuine v1 by
// `saveDraftAsV1` — and assert the three properties that ordering buys:
// nothing exists before the save, the one version published is v1 and
// carries the adopted positions, and abandoning the flow leaves nothing
// behind.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();
const listPlaybooksMock = vi.fn();
const getPlaybookMock = vi.fn();
const getPlaybookContentMock = vi.fn();
const publishAndPointMock = vi.fn();
const savePlaybookMock = vi.fn();
const publishVersionMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const listModelsMock = vi.fn();
const parseFileMock = vi.fn();
const parseDocxRedlinesMock = vi.fn();
const inferPositionsMock = vi.fn();
const buildChangesetMock = vi.fn();
const saveChangesetMock = vi.fn();
const publishChangesetMock = vi.fn();
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
  savePlaybook: (...args: unknown[]) => savePlaybookMock(...args),
  publishVersion: (...args: unknown[]) => publishVersionMock(...args),
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

// Still mocked although `App` no longer imports either: these ARE F's
// changeset mechanism, and the assertion that they are never called from
// this flow is what would catch a re-introduction of Task 10A's
// mint-an-empty-v1-then-changeset ordering.
vi.mock('./lib/buildChangeset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/buildChangeset')>()),
  buildChangeset: (...args: unknown[]) => buildChangesetMock(...args),
}));

vi.mock('./lib/db/changesets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/changesets')>()),
  saveChangeset: (...args: unknown[]) => saveChangesetMock(...args),
  publishChangeset: (...args: unknown[]) => publishChangesetMock(...args),
}));

import App from './App';

const SETTINGS_KEY = 'lexprompt.settings';

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
  selectFiles([file]);
}

/** Same, for more than one file at once — the case `proposeChains` actually
 *  chains on: it groups filenames only WITHIN one call's batch
 *  (`handleAddRedlinesFiles`'s own doc comment), so two files added as two
 *  separate single-file picks never chain, only two picked together do. */
function selectFiles(files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) throw new Error('No file input is on screen.');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

/** Every route by which this app can make a playbook or a version durable.
 *  Asserted together rather than one at a time so a future third write path
 *  cannot slip past a test that only knew about two. */
function nothingWasWritten() {
  expect(publishAndPointMock).not.toHaveBeenCalled();
  expect(publishVersionMock).not.toHaveBeenCalled();
  expect(savePlaybookMock).not.toHaveBeenCalled();
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

/** Types into "Playbook name" on precedent intake — the field the R-F-fix-1
 *  ruling added, beside the documents. Must run before `Continue`, since
 *  once "What we learned" is reached there is no way back to this field
 *  short of the explicit "Back to documents" link. */
function nameThePlaybook(name: string) {
  const input = container.querySelector('[aria-label="Playbook name"]') as HTMLInputElement | null;
  typeInto(input, name);
}

/** ...names the playbook, adopts the one position and hands off to E's
 *  draft review. */
async function reachTheDraftReview() {
  await openRedlinesIntake();
  nameThePlaybook('Brookvale Lease (Landlord)');
  selectFile(new File(['x'], 'Brookvale - our markup.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }));
  await flush();
  click(buttonNamed(/^continue$/i));
  await flush();
  click(buttonNamed(/^adopt$/i));
  click(buttonNamed(/review and save as a playbook/i));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-test', modelId: 'test/model' }));
  migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
  listPlaybooksMock.mockReset().mockResolvedValue([]);
  getPlaybookMock.mockReset().mockResolvedValue(null);
  getPlaybookContentMock.mockReset().mockResolvedValue(null);
  savePlaybookMock.mockReset();
  publishVersionMock.mockReset();
  // Answers with a version built from what it was actually asked to
  // publish, so a test asserting "v1, carrying the adopted positions" is
  // reading the real argument rather than a fixture that would say v1 no
  // matter what the app passed.
  publishAndPointMock.mockReset().mockImplementation(
    async (identity: Playbook, draft: PlaybookDraft) => {
      const version: PlaybookVersion = {
        id: 'ver-1',
        playbookId: identity.id,
        version: 1,
        name: draft.name,
        contractType: draft.contractType,
        systemPrompt: draft.systemPrompt,
        formatPrompt: draft.formatPrompt,
        clauses: draft.clauses,
        changeSummary: draft.changeSummary,
        publishedAt: Date.now(),
        publishedByUserId: 'u1',
        schemaVersion: 1,
      };
      return { playbook: { ...identity, currentVersionId: version.id }, version };
    },
  );
  listMattersMock.mockReset().mockResolvedValue([]);
  listReviewsMock.mockReset().mockResolvedValue([]);
  listModelsMock.mockReset().mockResolvedValue([]);

  parseFileMock.mockReset().mockImplementation(async (file: File) => ({
    id: 'df1', name: file.name, text: `TEXT OF ${file.name}`, file, kind: 'docx' as const,
  }));
  parseDocxRedlinesMock.mockReset().mockResolvedValue({ edits: [edit()], hasMarkup: true });
  // `questions: []` is what `inferPositions` actually returns on this entry
  // point, every time: the app has no prior clause list to check these
  // documents against, so it passes `unamendedClauses: []` and no open
  // question can be derived. The screen has to say so rather than claim a
  // search came back clean — see the honesty test below.
  inferPositionsMock.mockReset().mockResolvedValue({
    positions: [consistentPosition()],
    questions: [],
  });
  buildChangesetMock.mockReset();
  saveChangesetMock.mockReset();
  publishChangesetMock.mockReset();
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
describe('the intake screen says each thing once (found by driving the real app)', () => {
  it('renders one heading and states the storage promise once, in the strong form', async () => {
    // `PrecedentUploadPanel` and `PrecedentIntake` are siblings on this
    // route, and both used to render "Bring in what you negotiated" plus
    // their own wording of the storage promise — "never stored" against
    // "Not stored with the playbook". Two headings looked like a bug; two
    // wordings were the real problem, because the narrower one reads as
    // leaving room for storage somewhere else, and a privacy promise must
    // never drift in the direction of understating itself.
    await openRedlinesIntake();
    const text = container.textContent ?? '';
    const occurrences = (needle: string) => text.split(needle).length - 1;

    expect(occurrences('Bring in what you negotiated')).toBe(1);
    expect(occurrences('Never stored')).toBe(1);
    expect(text).not.toContain('Not stored with the playbook');
  });
});

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

  it('hands the adopted positions to E\'s draft review, not to a changeset', async () => {
    await reachTheDraftReview();

    // E's screen, holding E's draft: the amber "unsaved draft" badge and the
    // clause editor's own fields.
    expect(container.textContent).toMatch(/unsaved draft/i);
    expect(container.textContent).toContain('Confidentiality period');
    expect(container.querySelector('[aria-label="Our standard position"]')).toBeTruthy();

    // F's changeset mechanism is not on this path at all — it belongs to
    // reading a new deal against a version that really exists.
    expect(buildChangesetMock).not.toHaveBeenCalled();
    expect(saveChangesetMock).not.toHaveBeenCalled();
    expect(publishChangesetMock).not.toHaveBeenCalled();
  });
});

// The correction Task 10A-fix exists for. Task 10A published an empty v1
// the moment "Build changeset" was pressed — a version recording a state
// the playbook was never in, written into an audit trail every future
// review cites. These are the tests that fail if that ordering comes back.
describe('nothing is published until a person saves from the draft review', () => {
  it('has created no playbook and no version by the time the draft review opens', async () => {
    await reachTheDraftReview();

    expect(container.textContent).toMatch(/unsaved draft/i);
    nothingWasWritten();
  });

  it('publishes exactly one version — v1 — carrying the adopted position', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReview();

    click(buttonNamed(/^keep$/i));
    click(buttonNamed(/save as v1/i));
    await flush();

    // Exactly one publish across the WHOLE flow. That is what makes the
    // published version v1: a second, earlier publish is precisely the
    // defect being corrected, and would make this one v2.
    expect(publishAndPointMock).toHaveBeenCalledTimes(1);
    const [identity, draft, byUserId] = publishAndPointMock.mock.calls[0];
    // A brand-new identity with no version yet — nothing was minted earlier
    // in the flow and carried here.
    expect(identity.currentVersionId).toBeUndefined();
    expect(byUserId).toBe('u1');

    // Named after what was typed on precedent intake (R-F-fix-1's gap), not
    // the old "Learned from redlines" constant every session used to share.
    expect(draft.name).toBe('Brookvale Lease (Landlord)');
    expect(draft.contractType).toBe('Brookvale Lease (Landlord)');

    // And it is not empty: the version carries the position the person
    // adopted, as a real clause with a real standard position.
    expect(draft.clauses).toHaveLength(1);
    expect(draft.clauses[0].title).toBe('Confidentiality period');
    expect(draft.clauses[0].standardPosition.text).toBe(
      'We strike an indefinite confidentiality tail in favour of a fixed term.',
    );
    expect(draft.clauses[0].standardPosition.origin).toBe('learned');
    expect(draft.clauses[0].standardPosition.reviewedByHuman).toBe(true);
    // Learned from the document that actually taught it, named in the
    // provenance that travels with the position.
    expect(draft.clauses[0].standardPosition.provenance).toMatch(/^Learned from /);

    expect(container.textContent).not.toMatch(/unsaved draft/i);
  });

  it('refuses to open the draft review when nothing was adopted, rather than offering an unsaveable draft', async () => {
    await reachWhatWeLearned();
    click(buttonNamed(/review and save as a playbook/i));
    await flush();

    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
    expect(container.textContent).toMatch(/adopt or reword at least one position/i);
    nothingWasWritten();
  });

  // R-F-fix-1's gap: every redlines playbook used to be named with the same
  // constant, unusable the moment the flow ran twice. Naming is collected on
  // intake but is not required to GET to "What we learned" — only to leave
  // it for the draft review, which is the moment an `AuthoringDraft` (and so
  // a name) actually has to exist.
  it('refuses to open the draft review when nothing was named, rather than saving a generic constant', async () => {
    await reachWhatWeLearned();
    click(buttonNamed(/^adopt$/i));
    click(buttonNamed(/review and save as a playbook/i));
    await flush();

    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
    expect(container.textContent).toMatch(/this playbook needs a name/i);
    nothingWasWritten();
  });

  it('does not block intake itself on the name being filled in', async () => {
    // No name typed at any point — Continue must still work, since someone
    // should be able to see what the redlines say before committing to one.
    await reachWhatWeLearned();
    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
  });

  it('carries the name typed on intake through to the saved playbook, not a constant', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReview();

    click(buttonNamed(/^keep$/i));
    click(buttonNamed(/save as v1/i));
    await flush();

    const [, draft] = publishAndPointMock.mock.calls[0];
    expect(draft.name).toBe('Brookvale Lease (Landlord)');
    expect(draft.name).not.toBe('Learned from redlines');
  });
});

// The orphan Task 10A created: the playbook was minted before the person
// had decided anything, so walking away left one behind.
describe('abandoning the flow leaves no playbook behind', () => {
  it('leaves nothing after bringing documents in and walking away', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openRedlinesIntake();
    selectFile(new File(['x'], 'Brookvale - our markup.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    await flush();

    click(buttonNamed(/^playbooks$/i));
    await flush();

    nothingWasWritten();
  });

  it('leaves nothing after adopting a position and walking away', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachWhatWeLearned();
    click(buttonNamed(/^adopt$/i));

    click(buttonNamed(/^playbooks$/i));
    await flush();

    nothingWasWritten();
  });

  it('leaves nothing after discarding from the draft review', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReview();

    click(buttonNamed(/^discard$/i));
    await flush();

    expect(container.textContent).not.toMatch(/unsaved draft/i);
    nothingWasWritten();
  });
});

// "Make sure the screen does not imply questions were looked for and none
// found, if that would be untrue." On this entry point there is no prior
// clause list, so `unamendedClauses` is genuinely `[]` and no open question
// can exist. The empty block is honest; a blank "nothing to report" would
// not be.
describe('the open-questions block says why it is empty, rather than claiming a clean search', () => {
  it('explains that no questions were looked for, and does not report none found', async () => {
    await reachWhatWeLearned();

    // The second argument is the clause list to check these documents
    // against — empty, because the playbook does not exist yet.
    expect(inferPositionsMock.mock.calls[0][1]).toEqual([]);

    expect(container.textContent).toMatch(/no open questions were looked for/i);
    expect(container.textContent).not.toMatch(/nothing the redlines raised without also settling it/i);
  });
});

// Spec §4/§11: "precedent documents are read once and are not stored with
// the playbook". Mutation-tested by hand while building Task 10A (calling
// `addDocument` from inside `handleAddRedlinesFiles` made this test fail,
// as expected, before being reverted) — see the Task 10A report for the
// specific mutation.
describe('a precedent document is read and never stored (spec §4, §11)', () => {
  it('never calls addDocument/getDocumentBlob and writes nothing new to localStorage across the whole flow', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReview();
    click(buttonNamed(/^keep$/i));
    click(buttonNamed(/save as v1/i));
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

// Task 10 (R-F6): the session lives only in this tab — leaving it loses the
// documents brought in and the positions found in them, and nothing here is
// ever durable. `beforeunload` alone would not catch this: it never fires on
// an in-app route change, which is how a draft was lost before (E's own
// `useUnsavedDraftGuard` doc comment). These tests exercise the IN-APP half
// — the nav click a real person actually uses to leave — reusing E's guard
// rather than a second one written for F.
describe('warns before navigating away from a live learning session (R-F6)', () => {
  it('asks before an in-app nav click leaves a session with documents in it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openRedlinesIntake();
    selectFile(new File(['x'], 'Brookvale - our markup.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    await flush();

    click(buttonNamed(/^playbooks$/i));
    await flush();

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/leaving loses the documents/i));
    // Cancelled: the session is still here, not silently dropped.
    expect(container.textContent).toMatch(/bring in what you negotiated/i);
    expect(container.textContent).toContain('Brookvale - our markup.docx');
  });

  it('leaves for real once the warning is confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openRedlinesIntake();
    selectFile(new File(['x'], 'Brookvale - our markup.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    await flush();

    click(buttonNamed(/^playbooks$/i));
    await flush();

    expect(container.textContent).not.toMatch(/bring in what you negotiated/i);
    expect(container.textContent).toMatch(/create template/i);
  });

  it('does not ask at all when the session has no documents yet', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await openRedlinesIntake();

    click(buttonNamed(/^playbooks$/i));
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/create template/i);
  });

  it('also asks from "What we learned", not only from precedent intake', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await reachWhatWeLearned();

    click(buttonNamed(/^playbooks$/i));
    await flush();

    expect(confirmSpy).toHaveBeenCalled();
    expect(container.textContent).toMatch(/observations about what you did, not advice/i);
  });
});

// Spec §8: "a chain the user rejects is ungrouped, not re-proposed." Chain
// detection (`chains.ts`) is pure and stateless — the guarantee that a
// rejection SURVIVES a later upload lives in `App.tsx`'s decision to run
// `proposeChains` only over each new batch of files, never over documents
// already in the session (see `handleAddRedlinesFiles`'s own doc comment).
// This is the integration point that actually proves it holds.
describe('a rejected chain stays ungrouped and is not re-proposed', () => {
  it('keeps two documents apart after their proposed chain is rejected, even once more files arrive', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await openRedlinesIntake();
    // Both in ONE selection, the case `proposeChains` actually groups —
    // matching filenames picked one at a time never chain in the first
    // place (see `selectFiles`'s own doc comment).
    selectFiles([
      new File(['x'], 'Brookvale - their draft.docx', { type: DOCX }),
      new File(['x'], 'Brookvale - our markup.docx', { type: DOCX }),
    ]);
    await flush();

    // Proposed as one two-turn chain — the arrow is only ever rendered
    // between roles that share a chain.
    expect(container.textContent).toMatch(/2 turns/i);
    expect(container.textContent).toContain('→');

    click(buttonNamed(/not one chain/i));
    await flush();

    expect(container.textContent).not.toContain('→');

    // A later, unrelated upload must not re-run chain detection over the
    // whole session and silently undo the rejection.
    selectFile(new File(['x'], 'Ashfield - our markup.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    await flush();

    expect(container.textContent).not.toContain('→');
  });
});
