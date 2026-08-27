import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DbBlockedError } from './lib/db/open';

const listPlaybooksMock = vi.fn();
const getPlaybookMock = vi.fn();
const getPlaybookContentMock = vi.fn();
const publishAndPointMock = vi.fn();
const saveDraftMock = vi.fn();
const discardDraftMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const migrateIfNeededMock = vi.fn();
const listVersionsMock = vi.fn();

// App's startup migration gate (Task 14) runs before any of the mocks below
// are ever reached. Mocking it — rather than letting the real
// `migrateIfNeeded` touch fake-indexeddb here too — keeps this file's mount
// sequence deterministic and fast; the migration's own three outcomes get
// dedicated coverage in App.migration.test.tsx.
vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

// App.tsx talks to the playbook repository only through these named
// exports; mocking the module lets the mount effect's very first await
// reject deterministically, without needing a real (or fake) IndexedDB
// failure mode.
vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  // The pure helpers (`newPlaybookDraft`, `draftFromVersion`) come from
  // the real module: re-implementing them here would be a second copy of
  // logic this task just extracted. Only the store-touching functions
  // below are replaced.
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: (...args: unknown[]) => getPlaybookMock(...args),
  // Defaults to the library's own record, so every existing test keeps the
  // behaviour it was written against; the `mockImplementationOnce` in the
  // unconverted-playbook test below is the only thing that overrides it.
  getPlaybookContent: (...args: unknown[]) => getPlaybookContentMock(...args),
  savePlaybook: vi.fn(),
  publishAndPoint: (...args: unknown[]) => publishAndPointMock(...args),
  saveDraft: (...args: unknown[]) => saveDraftMock(...args),
  discardDraft: (...args: unknown[]) => discardDraftMock(...args),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

// Same reasoning as playbooks above, for the new matters entry point.
vi.mock('./lib/db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
}));

// Task 9A: the editor's cross-matter position-health scan reads every
// version of the open playbook.
vi.mock('./lib/db/playbookVersions', () => ({
  listVersions: (...args: unknown[]) => listVersionsMock(...args),
}));

import App from './App';
import { UnconvertedPlaybookError } from './lib/db/playbookMigration';

// The default `getPlaybookContent`: the library's own record, which is what
// every test in this file was written against. Set once here rather than in
// each `beforeEach` — nothing calls `mockReset()` on it, so a
// `mockImplementationOnce` in a single test is the only override.
getPlaybookContentMock.mockImplementation(
  async (id: string) => (await listPlaybooksMock()).find((p: { id: string }) => p.id === id) ?? null,
);
// Task 9A. Defaults so a describe that never touches drafts is unaffected;
// the suites below reset and re-arm them.
listVersionsMock.mockResolvedValue([]);
saveDraftMock.mockImplementation(async (playbook: unknown) => playbook);
discardDraftMock.mockResolvedValue(undefined);

async function flush() {
  // App now runs a startup migration gate ahead of everything else (Task
  // 14) — one extra microtask layer (the mocked `migrateIfNeeded` settling,
  // then AppShell mounting) sits in front of the turns this already
  // accounted for: the mocked repository call's resolution/rejection, and
  // the resulting setState.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Clicks the header nav button with the given (case-insensitive) text. */
function clickNav(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find(b => new RegExp(`^${label}$`, 'i').test((b.textContent || '').trim()));
  if (!button) throw new Error(`No nav button found for "${label}"`);
  act(() => { (button as HTMLButtonElement).click(); });
}

describe('App mount — matters list load failure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset();
    listReviewsMock.mockReset().mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('surfaces a DbBlockedError with its own explanatory message, never an empty matters list', async () => {
    listMattersMock.mockRejectedValue(new DbBlockedError());
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('another tab');
    expect(container.textContent).not.toContain('No matters yet');
  });

  it('surfaces a generic load failure with a retry, never an empty matters list', async () => {
    listMattersMock.mockRejectedValue(new Error('boom'));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('No matters yet');
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
  });

  it('retry re-fetches and clears the error once the matters list loads successfully', async () => {
    listMattersMock.mockRejectedValueOnce(new Error('boom'));
    listMattersMock.mockResolvedValueOnce([]);
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toContain('could not be loaded');

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { retryButton.click(); });
    await flush();

    expect(container.textContent).not.toContain('could not be loaded');
    expect(container.textContent).toContain('No matters yet');
    expect(listMattersMock).toHaveBeenCalledTimes(2);
  });

  it('renders the matters list normally when the load succeeds', async () => {
    listMattersMock.mockResolvedValue([]);
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('No matters yet');
    expect(container.textContent).not.toContain('could not be loaded');
  });

  it('does not fail the matters list when review counts fail to load, but still fetches them per matter', async () => {
    const matter = { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
    listMattersMock.mockResolvedValue([matter]);
    listReviewsMock.mockRejectedValue(new Error('reviews down'));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('Acme v Bolt');
    expect(container.textContent).not.toContain('could not be loaded');
    expect(listReviewsMock).toHaveBeenCalledWith('m1');
    // Pins the undefined-vs-0 distinction MattersListItem's own doc comment
    // promises: a failed count must be omitted from the row entirely, never
    // rendered as if the matter genuinely has zero reviews. Without this
    // assertion, a regression that rendered "0 reviews" on failure would
    // pass this test unchanged (Task 10 minor, closed here).
    expect(container.textContent).not.toContain('0 review');
  });
});

describe('App mount — playbook library load failure (Critical fix-round-1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset();
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  // The matters list is now the entry point (Task 10), so these tests
  // navigate to the Library view first — exactly what a user clicking
  // "Library" in the header would do — before asserting on playbook-load
  // behaviour that lives on that screen.

  it('surfaces a DbBlockedError with its own explanatory message, never an empty library', async () => {
    listPlaybooksMock.mockRejectedValue(new DbBlockedError());
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();

    expect(container.textContent).toContain('another tab');
    expect(container.textContent).not.toContain('No templates yet');
  });

  it('surfaces a generic load failure with a retry, never an empty library', async () => {
    listPlaybooksMock.mockRejectedValue(new Error('boom'));
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();

    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('No templates yet');
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
  });

  it('retry re-fetches and clears the error once the library loads successfully', async () => {
    listPlaybooksMock.mockRejectedValueOnce(new Error('boom'));
    listPlaybooksMock.mockResolvedValueOnce([]);
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();
    expect(container.textContent).toContain('could not be loaded');

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { retryButton.click(); });
    await flush();

    expect(container.textContent).not.toContain('could not be loaded');
    expect(container.textContent).toContain('No templates yet');
    expect(listPlaybooksMock).toHaveBeenCalledTimes(2);
  });

  it('renders the library normally when the load succeeds', async () => {
    listPlaybooksMock.mockResolvedValue([]);
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();

    expect(container.textContent).toContain('No templates yet');
    expect(container.textContent).not.toContain('could not be loaded');
  });
});

describe('App — playbook editor route (Task 12)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPath = window.location.pathname;

  const playbook = {
    id: 'pb1',
    name: 'NDA Review',
    contractType: 'NDA',
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
  };

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listPlaybooksMock.mockReset().mockResolvedValue([playbook]);
    // The library lists IDENTITY records now — they carry no clauses — so
    // opening one always reads it (and its published content) from storage,
    // where before the card handed the whole template over in memory.
    getPlaybookMock.mockReset().mockResolvedValue(playbook);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.replaceState(null, '', originalPath);
  });

  it('opening a playbook from the library navigates to /playbooks/:playbookId', async () => {
    window.history.replaceState(null, '', '/');
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Library');
    await flush();

    const card = Array.from(container.querySelectorAll('h3'))
      .find(h => h.textContent === 'NDA Review');
    expect(card).toBeTruthy();
    act(() => { (card as HTMLElement).click(); });
    await flush();

    expect(window.location.pathname).toBe('/playbooks/pb1');
    const nameInput = container.querySelector('input') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('NDA Review');
  });

  it('a cold load of /playbooks/:id fetches that playbook from storage and opens it in the editor', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    getPlaybookMock.mockResolvedValue(playbook);
    act(() => { root.render(<App />); });
    await flush();

    expect(getPlaybookMock).toHaveBeenCalledWith('pb1');
    const nameInput = container.querySelector('input') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('NDA Review');
  });

  it('a cold load of /playbooks/:id for an id that no longer exists shows an honest not-found state, not a blank editor', async () => {
    window.history.replaceState(null, '', '/playbooks/gone');
    getPlaybookMock.mockResolvedValue(null);
    act(() => { root.render(<App />); });
    await flush();

    expect(getPlaybookMock).toHaveBeenCalledWith('gone');
    expect(container.textContent).toContain('could not be found');
    expect(container.querySelector('input')).toBeNull();
  });

  // M3 (fix round 1), the App half. A record whose clauses the startup
  // conversion never reached reads as "never published", and the editor
  // answers that with `newPlaybookDraft` — a blank editor over a playbook
  // that still has clauses, whose next Save publishes an empty v1 and
  // destroys them. The store now refuses to answer, and this is what the
  // reviewer sees instead: the honest error, its own message, a retry, and
  // NO editor.
  it('a playbook whose content was never converted shows an error, never a blank editor', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    getPlaybookMock.mockResolvedValue(playbook);
    getPlaybookContentMock.mockRejectedValueOnce(new UnconvertedPlaybookError());
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toMatch(/finished upgrading/i);
    expect(container.textContent).toMatch(/reload the page/i);
    // The blank editor is the whole defect: no name field, no Save.
    expect(container.querySelector('input')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some(b => /^save$/i.test(b.textContent || ''))).toBe(false);
    // Recoverable, like every other load failure on this screen.
    expect(Array.from(container.querySelectorAll('button')).some(b => /retry/i.test(b.textContent || ''))).toBe(true);
  });

  it('a DbBlockedError on a cold load of /playbooks/:id surfaces its own message with a working retry', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    getPlaybookMock.mockRejectedValueOnce(new DbBlockedError());
    getPlaybookMock.mockResolvedValueOnce(playbook);
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('another tab');
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(b => /retry/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(retryButton).toBeTruthy();

    act(() => { retryButton.click(); });
    await flush();

    expect(container.textContent).not.toContain('another tab');
    const nameInput = container.querySelector('input') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('NDA Review');
  });

  it('closing the editor navigates back to /playbooks', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    getPlaybookMock.mockResolvedValue(playbook);
    act(() => { root.render(<App />); });
    await flush();

    const closeButton = Array.from(container.querySelectorAll('button'))
      .find(b => /^close$/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    act(() => { closeButton.click(); });
    await flush();

    expect(window.location.pathname).toBe('/playbooks');
  });
});

describe('App — unsaved-changes guard on browser Back (Task 12 fix round 1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPath = window.location.pathname;

  const playbook = {
    id: 'pb1',
    name: 'NDA Review',
    contractType: 'NDA',
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
  };

  // Bypasses React's tracked-value shortcut (setting `.value` directly is a
  // no-op from React's perspective) so the subsequent 'input' event is seen
  // as a genuine change — the same trick @testing-library/react's fireEvent
  // uses internally. This is what lets a test actually dirty the editor
  // through its real onChange handler, rather than asserting on `isTemplateDirty`
  // from outside the component.
  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Simulates a browser Back press: the address bar has already moved
   *  (exactly as a real Back does before `popstate` fires) — mirrors the
   *  router-level test in router.test.ts, but here driving the real App
   *  component so the guard exercised is the real confirmDiscardIfDirty,
   *  not a synthetic stand-in. */
  function simulateBrowserBack(toPath: string) {
    window.history.pushState(null, '', toPath);
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
  }

  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listPlaybooksMock.mockReset().mockResolvedValue([playbook]);
    getPlaybookMock.mockReset().mockResolvedValue(playbook);
    saveDraftMock.mockReset().mockImplementation(async (playbook: unknown) => playbook);
    discardDraftMock.mockReset().mockResolvedValue(undefined);
    confirmSpy = vi.spyOn(window, 'confirm');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.replaceState(null, '', originalPath);
    confirmSpy.mockRestore();
  });

  // R-D16: the prompt is now three-way. The FIRST confirm offers to keep the
  // changes; declining it offers to discard them; declining that too is
  // Cancel, and Cancel is what must veto the navigation.
  it('blocks Back and restores the URL when the editor is dirty and both prompts are declined', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValue(false);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'NDA Review EDITED'); });

    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // Nothing was written either way — Cancel means the edits stay exactly
    // where they are, in memory and nowhere else.
    expect(saveDraftMock).not.toHaveBeenCalled();
    expect(discardDraftMock).not.toHaveBeenCalled();
    // Vetoed: the address bar must be restored to the editor's own URL...
    expect(window.location.pathname).toBe('/playbooks/pb1');
    // ...and the unsaved edit must still be showing, not discarded.
    const stillThere = container.querySelector('input') as HTMLInputElement | null;
    expect(stillThere?.value).toBe('NDA Review EDITED');
  });

  it('allows Back and discards the unsaved edit when Discard is chosen', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'NDA Review EDITED'); });

    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe('/playbooks');
    // Navigated away from the editor entirely — the edited input is gone,
    // not merely reverted in place.
    expect(container.textContent).toContain('NDA Review');
    expect(container.textContent).not.toContain('NDA Review EDITED');
  });

  // M2 (fix round 1). `handleOpenTemplate` used to do
  // `setActiveTemplate(t); setSavedTemplateSnapshot(JSON.stringify(t))` from
  // the library's own record, so reopening a playbook always reset the
  // editor. Task 3 reduced it to a bare `navigate(...)`, and the route
  // effect short-circuits when `activePlaybook.id` already matches — so
  // nothing anywhere reset `activeDraft` on leaving. A confirmed
  // "Discard them?" then discarded nothing: the editor reopened holding the
  // rejected edits, still dirty, and the next Save PUBLISHED them as a
  // version. In the sub-project whose purpose is making "which version did
  // this review run against" answerable, a version could record a change
  // the user explicitly rejected.
  it('reopening a playbook after a confirmed discard shows the stored content, not the discarded edits', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'EDITED'); });
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('EDITED');

    const closeButton = Array.from(container.querySelectorAll('button'))
      .find(b => /^close$/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { closeButton.click(); });
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe('/playbooks');

    const card = Array.from(container.querySelectorAll('h3'))
      .find(h => h.textContent === 'NDA Review');
    expect(card).toBeTruthy();
    act(() => { (card as HTMLElement).click(); });
    await flush();

    expect(window.location.pathname).toBe('/playbooks/pb1');
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('NDA Review');
  });

  // The same reset, reached by the browser's own Back button rather than
  // the Close control — a different code path into "left the editor".
  it('reopening after a confirmed discard via browser Back also shows the stored content', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'EDITED'); });

    simulateBrowserBack('/playbooks');
    await flush();

    const card = Array.from(container.querySelectorAll('h3'))
      .find(h => h.textContent === 'NDA Review');
    act(() => { (card as HTMLElement).click(); });
    await flush();

    expect((container.querySelector('input') as HTMLInputElement).value).toBe('NDA Review');
  });

  // Task 9A / M2 / R-D16. Until this, `App.tsx` wired the editor's draft
  // callback to `setActiveDraft` and nothing else — so `saveDraft`,
  // `Playbook.draft`, `loadPlaybookForEdit`'s draft preference,
  // `publishAndPoint`'s draft consumption and the library's "Unpublished
  // changes" badge were five shipped mechanisms with no writer between them.
  it('the Save draft control stores the working copy, and leaves the editor clean', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();

    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    await flush();

    const save = Array.from(container.querySelectorAll('button'))
      .find(b => /save draft/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    act(() => { save.click(); });
    await flush();

    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    const [identity, draft] = saveDraftMock.mock.calls[0]!;
    expect((identity as { id: string }).id).toBe('pb1');
    expect((draft as { name: string }).name).toBe('NDA Review EDITED');
    // Saving a draft is not publishing: no version is minted.
    expect(publishAndPointMock).not.toHaveBeenCalled();

    // ...and the editor is clean afterwards, so leaving asks nothing.
    simulateBrowserBack('/playbooks');
    await flush();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/playbooks');
  });

  it('keeping the unpublished changes on the way out stores them as a draft', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    // The FIRST confirm is "Keep your unpublished changes?".
    confirmSpy.mockReturnValue(true);
    act(() => { root.render(<App />); });
    await flush();

    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/playbooks');
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    expect((saveDraftMock.mock.calls[0]![1] as { name: string }).name).toBe('NDA Review EDITED');
    expect(discardDraftMock).not.toHaveBeenCalled();
  });

  // R-D16. Discard has to clear the STORED draft as well as the in-memory
  // one. Otherwise the rejected edits stay durable and
  // `loadPlaybookForEdit` prefers a stored draft over the published version
  // — so the next open would resurrect exactly what was just rejected,
  // which is the defect Task 3's M2 fixed one layer up.
  it('discarding clears the STORED draft, not just the in-memory one', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => { root.render(<App />); });
    await flush();

    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    simulateBrowserBack('/playbooks');
    await flush();

    expect(discardDraftMock).toHaveBeenCalledWith('pb1');
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  // The other half of the same rule: once a draft IS stored, opening the
  // playbook must show it rather than the published version underneath.
  it('reopening a playbook with a stored draft shows the draft, not the published version', async () => {
    getPlaybookMock.mockResolvedValue({
      ...playbook,
      draft: {
        name: 'Work in progress',
        contractType: 'NDA',
        systemPrompt: 'You are an expert.',
        formatPrompt: 'Quote verbatim.',
        clauses: [],
        changeSummary: '',
      },
    });
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();

    expect((container.querySelector('input') as HTMLInputElement).value).toBe('Work in progress');
  });

  it('never prompts on Back when the editor has no unsaved changes', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();

    // No edit made — the freshly-loaded playbook is clean by construction
    // (savedTemplateSnapshot is set to match right after load).
    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/playbooks');
  });
});

// Task 9. The editor no longer mutates a playbook: it edits a draft, and
// Publish freezes that draft into an immutable version. Driven through the
// real App because the three pieces — the editor's Publish button, the
// dialog's change-summary rule, and `publishAndPoint` — only meet here.
describe('App — editing a draft and publishing a version (Task 9)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPath = window.location.pathname;

  const publishedV1 = {
    id: 'pb1',
    name: 'NDA Review',
    contractType: 'NDA',
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    playbookId: 'pb1',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
  };

  function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const buttonNamed = (name: RegExp) =>
    Array.from(container.querySelectorAll('button'))
      .find(b => name.test(b.textContent || '')) as HTMLButtonElement | undefined;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listPlaybooksMock.mockReset().mockResolvedValue([publishedV1]);
    getPlaybookMock.mockReset().mockResolvedValue(publishedV1);
    publishAndPointMock.mockReset().mockResolvedValue({
      playbook: { id: 'pb1', name: 'NDA Review EDITED', createdAt: 1, updatedAt: 2, currentVersionId: 'v2', schemaVersion: 6 },
      version: { ...publishedV1, id: 'v2', version: 2, name: 'NDA Review EDITED', changeSummary: 'Renamed it.' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.replaceState(null, '', originalPath);
  });

  async function openEditor() {
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();
  }

  // Nothing unpublished means nothing to publish: republishing an unchanged
  // draft is how a real library came to hold two byte-identical versions a
  // millisecond apart, which its history cannot explain.
  it('offers no publish until something has been edited', async () => {
    await openEditor();
    expect(container.textContent).not.toMatch(/unpublished changes/i);
    expect(buttonNamed(/^\s*publish\s*$/i)?.disabled).toBe(true);
  });

  it('an edit becomes a draft, and publishing it records the change summary', async () => {
    await openEditor();

    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    await flush();
    expect(container.textContent).toMatch(/unpublished changes/i);

    act(() => { buttonNamed(/^\s*publish\s*$/i)!.click(); });
    await flush();
    expect(container.textContent).toContain('Publish v2');

    // Refused without a summary — and the store is never reached, so the
    // rule is enforced before the write rather than reported after it.
    act(() => { buttonNamed(/^\s*publish v2\s*$/i)!.click(); });
    await flush();
    expect(publishAndPointMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/say what changed/i);

    setInputValue(container.querySelector('[aria-label="Change summary"]') as HTMLTextAreaElement, 'Renamed it.');
    act(() => { buttonNamed(/^\s*publish v2\s*$/i)!.click(); });
    await flush();

    expect(publishAndPointMock).toHaveBeenCalledTimes(1);
    const [identity, draft] = publishAndPointMock.mock.calls[0]!;
    expect((identity as { id: string }).id).toBe('pb1');
    expect((draft as { name: string; changeSummary: string }).name).toBe('NDA Review EDITED');
    expect((draft as { changeSummary: string }).changeSummary).toBe('Renamed it.');
  });

  // The edits are IN the version now. A surviving draft would leave the
  // editor claiming unpublished changes over content that is published, and
  // would offer to publish it a second time.
  it('clears the unpublished-changes state once the version is published', async () => {
    await openEditor();
    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    await flush();

    act(() => { buttonNamed(/^\s*publish\s*$/i)!.click(); });
    await flush();
    setInputValue(container.querySelector('[aria-label="Change summary"]') as HTMLTextAreaElement, 'Renamed it.');
    act(() => { buttonNamed(/^\s*publish v2\s*$/i)!.click(); });
    await flush();

    expect(container.textContent).not.toContain('Publish v2');
    expect(container.textContent).not.toMatch(/unpublished changes/i);
    expect(container.textContent).toContain('v2');
    expect(buttonNamed(/^\s*publish\s*$/i)?.disabled).toBe(true);
  });

  // A failed publish must not look like a successful one: the draft is
  // still unpublished, and the summary the user typed is still in the box.
  it('keeps the draft and the dialog open when the publish fails', async () => {
    publishAndPointMock.mockRejectedValue(new Error('Could not save — your browser storage is full.'));
    await openEditor();
    setInputValue(container.querySelector('input') as HTMLInputElement, 'NDA Review EDITED');
    await flush();

    act(() => { buttonNamed(/^\s*publish\s*$/i)!.click(); });
    await flush();
    setInputValue(container.querySelector('[aria-label="Change summary"]') as HTMLTextAreaElement, 'Renamed it.');
    act(() => { buttonNamed(/^\s*publish v2\s*$/i)!.click(); });
    await flush();

    expect(container.textContent).toContain('Publish v2');
    expect(container.textContent).toMatch(/storage is full/i);
    expect(container.textContent).toMatch(/unpublished changes/i);
    expect((container.querySelector('[aria-label="Change summary"]') as HTMLTextAreaElement).value)
      .toBe('Renamed it.');
  });
});

// Task 9A Part 2 / M1. `positionHealth` was built in Task 8 and given a prop
// in Task 9, and nothing wired it — DoD #7 would have shipped unmet with
// nothing in the plan to catch it. The scan is cross-matter because
// `listReviews` is matter-scoped and a playbook's positions are tested
// wherever it has been run.
describe('App — position health in the playbook editor (Task 9A)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPath = window.location.pathname;

  const clauseWithPosition = {
    id: 'c1',
    title: 'Break notice',
    extractPrompt: 'What notice is required?',
    standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true },
  };

  const v1 = {
    id: 'v1',
    playbookId: 'pb1',
    version: 1,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [clauseWithPosition],
    changeSummary: '',
    publishedAt: 1000,
    publishedByUserId: 'u1',
    schemaVersion: 6,
  };

  const identity = {
    id: 'pb1', name: 'Lease Review', createdAt: 1, updatedAt: 2,
    currentVersionId: 'v1', schemaVersion: 6,
  };

  const verifiedMeets = {
    clauseId: 'c1',
    status: 'done',
    summary: 'Six months, as asked.',
    citations: [],
    verification: { state: 'verified', byUserId: 'u1', at: 1500 },
    notes: [],
    positionOutcome: 'meets',
  };

  function reviewAgainst(versionId: string | undefined, matterId: string) {
    const r: Record<string, unknown> = {
      id: `r-${matterId}`,
      matterId,
      playbookSnapshot: v1,
      documentIds: ['d1'],
      target: { kind: 'documents', documentIds: ['d1'] },
      findings: { d1: { c1: verifiedMeets } },
      modelId: 'm',
      startedAt: 1,
      createdByUserId: 'u1',
    };
    if (versionId !== undefined) r.playbookVersionId = versionId;
    return r;
  }

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([identity]);
    getPlaybookMock.mockReset().mockResolvedValue(identity);
    getPlaybookContentMock.mockImplementation(async () => v1);
    listVersionsMock.mockReset().mockResolvedValue([v1]);
    listMattersMock.mockReset().mockResolvedValue([
      { id: 'm1', name: 'Acme HQ lease', ownerId: 'u1', createdAt: 1, updatedAt: 1 },
      { id: 'm2', name: 'Beta sublease', ownerId: 'u1', createdAt: 1, updatedAt: 1 },
    ]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.replaceState(null, '', originalPath);
    getPlaybookContentMock.mockImplementation(
      async (id: string) => (await listPlaybooksMock()).find((p: { id: string }) => p.id === id) ?? null,
    );
  });

  async function openEditor() {
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();
    await flush();
  }

  it('shows HELD n of m from verified findings across every matter', async () => {
    listReviewsMock.mockImplementation(async (matterId: string) => [reviewAgainst('v1', matterId)]);
    await openEditor();
    // One verified `meets` in each of the two matters. A matter-scoped scan
    // would have found one.
    expect(container.textContent).toContain('HELD 2 of 2');
  });

  it('renders an error state, never an empty map, when the review scan fails', async () => {
    listReviewsMock.mockRejectedValue(new Error('disk'));
    await openEditor();
    expect(container.textContent).toMatch(/could not be read/i);
    expect(container.textContent).toMatch(/retry/i);
    // "No verified findings yet" is a fact about the position; "we could not
    // read your reviews" is a fact about the app, and they must not look
    // alike. UNTESTED here would be the app inventing the first.
    expect(container.textContent).not.toMatch(/untested/i);
  });

  it('recovers when the retry succeeds', async () => {
    // A persistent rejection, not `…Once`: the matters list's own
    // review-count load runs on mount and would eat a one-shot queue.
    listReviewsMock.mockRejectedValue(new Error('disk'));
    await openEditor();
    expect(container.textContent).toMatch(/could not be read/i);

    listReviewsMock.mockImplementation(async (matterId: string) => [reviewAgainst('v1', matterId)]);
    const retry = Array.from(container.querySelectorAll('button'))
      .find(b => /^retry$/i.test((b.textContent || '').trim())) as HTMLButtonElement;
    act(() => { retry.click(); });
    await flush();
    await flush();
    expect(container.textContent).not.toMatch(/could not be read/i);
    expect(container.textContent).toContain('HELD 2 of 2');
  });

  it('says UNTESTED when the scan succeeded and found no verified findings', async () => {
    await openEditor();
    expect(container.textContent).toContain('UNTESTED');
  });

  // Spec 8's "link to version history" (review M3). The author could
  // publish v4 from this screen with no way from it to see what v1-v3 said.
  it('opens the version history from the editor', async () => {
    listVersionsMock.mockResolvedValue([
      { ...v1, id: 'v2', version: 2, changeSummary: 'Added a break-notice position' },
      v1,
    ]);
    await openEditor();
    const link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(link.disabled).toBe(false);
    act(() => { link.click(); });
    await flush();

    expect(container.textContent).toContain('Added a break-notice position');
    expect(container.textContent).toContain('v2');
  });

  it('says the versions could not be read rather than showing an empty history', async () => {
    listVersionsMock.mockResolvedValueOnce([v1]).mockRejectedValue(new Error('disk'));
    await openEditor();
    const link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { link.click(); });
    await flush();

    expect(container.textContent).toMatch(/versions could not be read/i);
    expect(container.textContent).not.toMatch(/nothing published yet/i);
  });

  // Task 10 / spec §8 / DoD #6: "the matters that used each" version. Reuses
  // the exact `reviewAgainst` fixture the position-health tests above use —
  // same cross-matter shape, different question (which matters, not how
  // many verified findings).
  it('names the matters that used each version from Version History', async () => {
    listVersionsMock.mockResolvedValue([v1]);
    listReviewsMock.mockImplementation(async (matterId: string) =>
      matterId === 'm1' ? [reviewAgainst('v1', matterId)] : []);
    await openEditor();
    const link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { link.click(); });
    await flush();

    expect(container.textContent).toContain('Acme HQ lease');
    // The OTHER matter never ran against v1, so it must not be credited.
    expect(container.textContent).not.toContain('Beta sublease');
  });

  it('says plainly when a version has not been used by any review yet', async () => {
    listVersionsMock.mockResolvedValue([v1]);
    listReviewsMock.mockResolvedValue([]);
    await openEditor();
    const link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { link.click(); });
    await flush();

    expect(container.textContent).toMatch(/not used|no reviews/i);
  });
});
