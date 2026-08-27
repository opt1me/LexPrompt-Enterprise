import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Playbook, PlaybookVersion } from './types';
import type { AuthoringDraft } from './lib/authoringDraft';

// No @testing-library/react in this project — a real react-dom root, driven
// directly, exactly as App.test.tsx does.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();
const listPlaybooksMock = vi.fn();
const getPlaybookMock = vi.fn();
const getPlaybookContentMock = vi.fn();
const savePlaybookMock = vi.fn();
const publishAndPointMock = vi.fn();
const publishVersionMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const generateDraftMock = vi.fn();
const listModelsMock = vi.fn();

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

// The pure helpers come from the real module (re-implementing them here
// would be a second copy of the thing under test); only the store-touching
// functions are replaced. `savePlaybook` and `publishVersion` are spies
// with no implementation on purpose: the session-only test asserts they are
// never reached while a draft is alive, and a spy that quietly succeeded
// would hide a write rather than reveal it.
vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: (...args: unknown[]) => getPlaybookMock(...args),
  getPlaybookContent: (...args: unknown[]) => getPlaybookContentMock(...args),
  savePlaybook: (...args: unknown[]) => savePlaybookMock(...args),
  publishVersion: (...args: unknown[]) => publishVersionMock(...args),
  publishAndPoint: (...args: unknown[]) => publishAndPointMock(...args),
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

// The one network call this flow makes. Mocked at the module boundary so
// the test drives the app's own route from the form to the review screen
// without a provider — `generateDraft`'s own behaviour has its own suite.
vi.mock('./features/authoring/generateDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./features/authoring/generateDraft')>()),
  generateDraft: (...args: unknown[]) => generateDraftMock(...args),
}));

vi.mock('./lib/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/openrouter')>()),
  listModels: (...args: unknown[]) => listModelsMock(...args),
}));

import App from './App';

const SETTINGS_KEY = 'lexprompt.settings';

function draftWithTwoClauses(): AuthoringDraft {
  return {
    contractType: 'Commercial Lease',
    learnedFrom: [],
    modelId: 'test/model',
    clauses: [
      {
        id: 'c1',
        title: 'Break clause',
        extractPrompt: 'Extract the break clause.',
        disposition: 'unreviewed',
        edited: false,
        suggestions: [],
      },
      {
        id: 'c2',
        title: 'Rent review',
        extractPrompt: 'Extract the rent review mechanism.',
        disposition: 'unreviewed',
        edited: false,
        suggestions: [],
      },
    ],
  };
}

const publishedPlaybook: Playbook = {
  id: 'pb-new',
  name: 'Commercial Lease',
  createdAt: 1,
  updatedAt: 1,
  currentVersionId: 'v-new',
  schemaVersion: 1,
};

const publishedVersion: PlaybookVersion = {
  id: 'v-new',
  playbookId: 'pb-new',
  version: 1,
  name: 'Commercial Lease',
  contractType: 'Commercial Lease',
  systemPrompt: 'You are an expert legal contract reviewer.',
  formatPrompt: 'Answer strictly from the document text. Quote verbatim.',
  clauses: [{ id: 'c1', title: 'Break clause', extractPrompt: 'Extract the break clause.' }],
  changeSummary: '',
  publishedAt: 2,
  publishedByUserId: 'u1',
  schemaVersion: 1,
};

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
  // Trimmed, because an icon-plus-label button's textContent carries the
  // leading space from its JSX text node — an anchored `/^matters$/` would
  // otherwise silently match nothing.
  return buttons().find(b =>
    name.test((b.textContent || '').trim()) || name.test(b.getAttribute('aria-label') || ''));
}

function pressJ() {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click() was given nothing to click.');
  act(() => { (el as HTMLElement).click(); });
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!el) throw new Error('typeInto() was given nothing to type into.');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function contractTypeField(): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input'))
    .find(i => /SaaS Agreement/i.test(i.getAttribute('placeholder') ?? ''));
  if (!input) throw new Error('The draft form is not on screen.');
  return input as HTMLInputElement;
}

/** Library → Create Template → Draft with AI → fill → generate. Leaves the
 *  app on the draft review screen with two unreviewed clauses. */
async function reachTheDraftReviewScreen() {
  act(() => { root.render(<App />); });
  await flush();
  click(buttonNamed(/^library$/i));
  await flush();
  click(buttonNamed(/create template/i));
  click(buttonNamed(/draft with ai/i));
  typeInto(contractTypeField(), 'Commercial Lease');
  click(buttonNamed(/draft the playbook/i));
  await flush();
}

/** Marks both clauses kept, which is what opens the save gate. `J` is how
 *  the screen moves to the next unreviewed clause — keeping does not
 *  advance the selection on its own, so clicking Keep twice would decide
 *  the first clause twice and leave the second untouched. */
function keepEveryClause() {
  click(buttonNamed(/^keep$/i));
  pressJ();
  click(buttonNamed(/^keep$/i));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: 'sk-test', modelId: 'test/model' }));
  migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
  listPlaybooksMock.mockReset().mockResolvedValue([]);
  getPlaybookMock.mockReset().mockResolvedValue(publishedPlaybook);
  getPlaybookContentMock.mockReset().mockResolvedValue(publishedVersion);
  savePlaybookMock.mockReset();
  publishVersionMock.mockReset();
  publishAndPointMock.mockReset().mockResolvedValue({
    playbook: publishedPlaybook,
    version: publishedVersion,
  });
  listMattersMock.mockReset().mockResolvedValue([]);
  listReviewsMock.mockReset().mockResolvedValue([]);
  generateDraftMock.mockReset().mockResolvedValue(draftWithTwoClauses());
  listModelsMock.mockReset().mockResolvedValue([]);
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

// Part 0. Every screen in sub-project E was unit-tested in isolation and
// none of them was reachable from the running app — the same "correct
// mechanism with no path to it" defect as D's DoD #7. These tests exist to
// make the path itself the thing under test.
describe('the authoring route is reachable from the library', () => {
  it('goes library → chooser → form → generation → draft review', async () => {
    await reachTheDraftReviewScreen();
    expect(container.textContent).toMatch(/unsaved draft/i);
    expect(container.textContent).toContain('Break clause');
    expect(container.textContent).toContain('Rent review');
  });

  it('offers all three routes on the chooser, with learn-from-redlines honestly inert (R-E6)', async () => {
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^library$/i));
    await flush();
    click(buttonNamed(/create template/i));

    expect(buttonNamed(/draft with ai/i)).toBeTruthy();
    expect(buttonNamed(/build by hand/i)).toBeTruthy();
    const redlines = buttonNamed(/learn from redlines/i);
    expect(redlines).toBeTruthy();
    // Rendered, not hidden — and saying why it does nothing rather than
    // being mysteriously inert.
    expect(redlines!.getAttribute('aria-disabled')).toBe('true');
    expect(redlines!.textContent).toMatch(/not built yet/i);
  });

  it('Build by hand opens D\'s editor on a new, empty, unsaved playbook', async () => {
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^library$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/build by hand/i));
    await flush();

    // The editor, not a dead end — and nothing written on the way in.
    expect(container.querySelector('input[value="Untitled playbook"]')).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/playbooks\//);
    expect(savePlaybookMock).not.toHaveBeenCalled();
    expect(publishAndPointMock).not.toHaveBeenCalled();
  });

  it('Save as v1 publishes through D\'s path and opens the published playbook in the editor', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReviewScreen();
    keepEveryClause();
    click(buttonNamed(/save as v1/i));
    await flush();

    expect(publishAndPointMock).toHaveBeenCalledTimes(1);
    // The published version carries the kept clauses, named after the
    // contract type the person typed.
    const [, draft, byUserId] = publishAndPointMock.mock.calls[0];
    expect(draft.name).toBe('Commercial Lease');
    expect(draft.clauses).toHaveLength(2);
    expect(byUserId).toBe('u1');

    expect(window.location.pathname).toBe('/playbooks/pb-new');
    expect(container.textContent).not.toMatch(/unsaved draft/i);
  });
});

describe('the draft is session-only (R-E1)', () => {
  it('writes nothing to IndexedDB or localStorage while a draft exists', async () => {
    await reachTheDraftReviewScreen();
    keepEveryClause();
    expect(container.textContent).toMatch(/unsaved draft/i);

    // Spying on the stores, not on intent: no repository write of any kind
    // happens between generation and an explicit Save as v1.
    expect(savePlaybookMock).not.toHaveBeenCalled();
    expect(publishVersionMock).not.toHaveBeenCalled();
    expect(publishAndPointMock).not.toHaveBeenCalled();

    // And nothing in localStorage beyond the settings blob that was there
    // before the draft existed — no draft key under any name.
    const keys = Object.keys(localStorage);
    expect(keys).toEqual([SETTINGS_KEY]);
    expect(localStorage.getItem(SETTINGS_KEY)).not.toMatch(/Break clause/);
  });

  it('does not put the draft in the URL, so a reload cannot resurrect it', async () => {
    await reachTheDraftReviewScreen();
    // Still the library's own URL: the authoring screens deliberately own
    // no route. A URL that reopened a draft would be a URL promising a
    // draft it cannot produce.
    expect(window.location.pathname).toBe('/playbooks');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });
});

describe('losing a draft is warned about by BOTH routes out of it (R-E4)', () => {
  it('warns before an in-app navigation away from a live draft', async () => {
    await reachTheDraftReviewScreen();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    click(buttonNamed(/^matters$/i));
    await flush();

    expect(confirmSpy).toHaveBeenCalled();
    // Refused, so the draft is still on screen — the guard has to actually
    // stop the navigation, not merely ask about it.
    expect(container.textContent).toMatch(/unsaved draft/i);
  });

  it('lets the navigation through when the person confirms, and drops the draft', async () => {
    await reachTheDraftReviewScreen();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    click(buttonNamed(/^matters$/i));
    await flush();

    expect(container.textContent).not.toMatch(/unsaved draft/i);
  });

  it('cancels beforeunload while a draft is live, and stops once it is gone', async () => {
    await reachTheDraftReviewScreen();
    const live = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(live);
    expect(live.defaultPrevented).toBe(true);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(buttonNamed(/^matters$/i));
    await flush();

    const gone = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(gone);
    expect(gone.defaultPrevented).toBe(false);
  });

  it('does not warn once the draft has been saved', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await reachTheDraftReviewScreen();
    keepEveryClause();
    click(buttonNamed(/save as v1/i));
    await flush();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(buttonNamed(/^matters$/i));
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('does not warn a second time once the draft has been discarded', async () => {
    await reachTheDraftReviewScreen();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    // One confirm, from Discard itself.
    click(buttonNamed(/discard/i));
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toMatch(/unsaved draft/i);

    click(buttonNamed(/^matters$/i));
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn while only the form is open — nothing has been generated yet', async () => {
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^library$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));
    typeInto(contractTypeField(), 'Commercial Lease');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(buttonNamed(/^matters$/i));
    await flush();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('a generation failure keeps the form and everything typed into it (spec §7)', () => {
  it('reports an ordinary failure inline without losing the form', async () => {
    generateDraftMock.mockRejectedValue(new Error('The model returned no clauses that could be used.'));
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^library$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));
    typeInto(contractTypeField(), 'Commercial Lease');
    click(buttonNamed(/draft the playbook/i));
    await flush();

    expect(container.textContent).toMatch(/no clauses that could be used/i);
    expect(contractTypeField().value).toBe('Commercial Lease');
    expect(container.textContent).not.toMatch(/unsaved draft/i);
  });
});
