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
        positionEdited: false,
        suggestions: [],
      },
      {
        id: 'c2',
        title: 'Rent review',
        extractPrompt: 'Extract the rent review mechanism.',
        disposition: 'unreviewed',
        edited: false,
        positionEdited: false,
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

function extractionField(): HTMLTextAreaElement {
  const field = container.querySelector('textarea[aria-label="Extract"]');
  if (!field) throw new Error('The clause editor is not on screen.');
  return field as HTMLTextAreaElement;
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
  click(buttonNamed(/^playbooks$/i));
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

  it('offers all three routes on the chooser, with learn-from-redlines now wired live (Task 10A)', async () => {
    // R-E6 kept this card rendered and honestly inert before sub-project F
    // landed; App.redlines.test.tsx is what now exercises the live route
    // end to end — this test only asserts the chooser itself is honest
    // about the third card no longer being a dead end.
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));

    expect(buttonNamed(/draft with ai/i)).toBeTruthy();
    expect(buttonNamed(/build by hand/i)).toBeTruthy();
    const redlines = buttonNamed(/learn from redlines/i);
    expect(redlines).toBeTruthy();
    expect(redlines!.getAttribute('aria-disabled')).toBe('false');
    expect(redlines!.textContent).not.toMatch(/not built yet/i);
  });

  it('Build by hand opens D\'s editor on a new, empty, unsaved playbook', async () => {
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
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
    click(buttonNamed(/^playbooks$/i));
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
    click(buttonNamed(/^playbooks$/i));
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

// Final honesty review (D/E), M1: a matters-load failure must read as "we
// could not read your matters", never as "you have none" — CLAUDE.md's
// empty-vs-broken rule, applied to a section of a screen rather than a whole
// one, exactly as `TemplateEditor`'s `healthError` already does.
describe('a matters load failure on the draft form reads as broken, not empty (M1)', () => {
  it('shows the load error instead of silently hiding the "learn from a matter" section', async () => {
    listMattersMock.mockReset().mockRejectedValue(new Error('boom'));
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));

    expect(container.textContent).toMatch(/matters list could not be loaded/i);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('retries the matters load from the form and then shows the section', async () => {
    listMattersMock.mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));
    expect(container.textContent).toMatch(/matters list could not be loaded/i);

    click(buttonNamed(/retry/i));
    await flush();

    expect(container.textContent).not.toMatch(/matters list could not be loaded/i);
  });
});

// Final honesty review (D/E), m2: `learnedFrom` (and, upstream of it, the
// sources actually handed to `generateDraft`) must name only sources that
// contributed material — a matter with zero verified findings is the common
// case, not the edge case, and crediting it overstates what shaped the draft.
describe('a ticked matter that contributed nothing is not credited (m2)', () => {
  it('does not pass an empty-contribution matter through to generateDraft', async () => {
    listMattersMock.mockReset().mockResolvedValue([
      { id: 'm1', name: 'Acme Lease', ownerId: 'u1', createdAt: 1, updatedAt: 1 },
    ]);
    listReviewsMock.mockReset().mockResolvedValue([]); // no reviews at all for m1
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));
    typeInto(contractTypeField(), 'Commercial Lease');

    const matterCheckbox = Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .find(el => /acme lease/i.test(el.closest('label')?.textContent ?? '')) as HTMLInputElement;
    expect(matterCheckbox).toBeTruthy();
    click(matterCheckbox);
    click(buttonNamed(/draft the playbook/i));
    await flush();

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    const [, , sourcesArg] = generateDraftMock.mock.calls[0];
    expect(sourcesArg).toEqual([]);
  });
});

// Integrity review (D/E), Major 4. `handleSaveDraftAsV1` captured
// `authoringDraft` from its render closure, awaited `getProfile()`, and
// published the captured value — while `DraftReview` left Keep and Cut live
// for the whole publish. Anything decided in that window went into React
// state and not into the version, and `setAuthoringDraft(null)` on success
// then destroyed it: the draft exists only in memory (R-E1), so a decision
// the user watched happen was unrecoverable.
describe('Save as v1 publishes what the screen holds, not a stale copy (Major 4)', () => {
  it('publishes an edit typed into the clause editor and never Kept', async () => {
    await reachTheDraftReviewScreen();
    keepEveryClause();
    // `keepEveryClause` leaves the second clause active. Type into it and go
    // straight to Save — the commit happens in the same tick as the click,
    // so a handler reading its own render's `authoringDraft` sees the value
    // from BEFORE the commit.
    typeInto(extractionField(), 'Extract the rent review mechanism AND its cap.');
    click(buttonNamed(/save as v1/i));
    await flush();

    expect(publishAndPointMock).toHaveBeenCalledTimes(1);
    const [, draft] = publishAndPointMock.mock.calls[0];
    expect(draft.clauses[1].extractPrompt).toBe('Extract the rent review mechanism AND its cap.');
  });

  it('leaves nothing on the draft review screen live while the publish is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    publishAndPointMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    // Re-review N2: the active clause carries a suggestion, so "Add as
    // clause" and "Dismiss suggestion" are actually on screen to assert
    // against — Major 4's fix threaded `saving` into Keep, Cut and the
    // textareas but left these two live.
    const draft = draftWithTwoClauses();
    draft.clauses[1]!.suggestions = ['Consider a break option at year 3.'];
    generateDraftMock.mockResolvedValueOnce(draft);

    await reachTheDraftReviewScreen();
    keepEveryClause();
    expect(buttonNamed(/add as clause/i)).toBeTruthy();
    click(buttonNamed(/save as v1/i));
    await flush();

    // Every control that could change the draft under the write. A button
    // that responds normally and then turns out not to have counted is the
    // failure this guards: the user watched clause 12 be cut and v1 shipped
    // with it.
    expect(buttonNamed(/^keep$/i)!.disabled).toBe(true);
    expect(buttonNamed(/^cut$/i)!.disabled).toBe(true);
    expect(buttonNamed(/break clause/i)!.disabled).toBe(true);
    expect(extractionField().disabled).toBe(true);
    expect(buttonNamed(/discard/i)!.disabled).toBe(true);
    // N2's own two: clicking either mid-publish used to insert an
    // `unreviewed` clause into the ref (failing the re-checked gate, or
    // being silently discarded with the whole draft) — a control that
    // responds normally but cannot reach the version being written.
    expect(buttonNamed(/add as clause/i)!.disabled).toBe(true);
    expect(buttonNamed(/dismiss suggestion/i)!.disabled).toBe(true);

    await act(async () => {
      release({ playbook: publishedPlaybook, version: publishedVersion });
      await Promise.resolve();
    });
    await flush();
    expect(window.location.pathname).toBe('/playbooks/pb-new');
  });
});

// Integrity review (D/E), Major 5. `handleGenerateDraft`'s success path ran
// `setAuthoringDraft(draft); setView('authoring-review');` unconditionally,
// ~30s later, on whatever screen the user had since navigated to. `setView`
// is the raw setter, so `requestView`'s `confirmDiscardIfDirty` never ran:
// the app threw the user onto the draft-review screen with no interaction,
// and — the worse variant — did it straight past `confirmLeaveTemplate`,
// taking a playbook's unpublished edits with it.
describe('a slow generation does not follow the user off the screen (Major 5)', () => {
  /** Library -> Create Template -> Draft with AI -> fill -> generate, with
   *  the generation left hanging. */
  async function startAGenerationThatNeverFinishes(): Promise<(draft: AuthoringDraft) => void> {
    let release: (draft: AuthoringDraft) => void = () => {};
    generateDraftMock.mockReturnValue(new Promise<AuthoringDraft>((resolve) => { release = resolve; }));
    act(() => { root.render(<App />); });
    await flush();
    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/draft with ai/i));
    typeInto(contractTypeField(), 'Commercial Lease');
    click(buttonNamed(/draft the playbook/i));
    await flush();
    return release;
  }

  it('leaves the user where they navigated to when the draft finally arrives', async () => {
    const release = await startAGenerationThatNeverFinishes();

    // Correctly unguarded: nothing has been generated, so there is no draft
    // to warn about.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(buttonNamed(/^matters$/i));
    await flush();
    expect(confirmSpy).not.toHaveBeenCalled();

    await act(async () => { release(draftWithTwoClauses()); await Promise.resolve(); });
    await flush();

    expect(container.textContent).not.toMatch(/unsaved draft/i);
    expect(container.textContent).not.toContain('Break clause');
    // Matters is the root route (`ROUTE_FOR_VIEW`), so this is where the
    // user actually is, unchanged by the resolve.
    expect(window.location.pathname).toBe('/');
  });

  it('does not carry unpublished playbook edits off the editor with it', async () => {
    const release = await startAGenerationThatNeverFinishes();

    click(buttonNamed(/^playbooks$/i));
    await flush();
    click(buttonNamed(/create template/i));
    click(buttonNamed(/build by hand/i));
    await flush();
    const nameField = container.querySelector('input[value="Untitled playbook"]') as HTMLInputElement;
    typeInto(nameField, 'Warehouse Lease');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { release(draftWithTwoClauses()); await Promise.resolve(); });
    await flush();

    // Still in the editor, with the edit still there and nothing asked. The
    // teleport bypassed confirmLeaveTemplate's three-way prompt entirely,
    // and the next navigation then cleared `activeDraft` with no warning.
    expect(window.location.pathname).toMatch(/^\/playbooks\//);
    expect(container.textContent).not.toMatch(/unsaved draft/i);
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('Warehouse Lease');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
