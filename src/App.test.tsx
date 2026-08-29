import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DbBlockedError } from './lib/db/open';
import { ModelError } from '@lexprompt/core';

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

// Task 16: `profile.ts` is an HTTP client now — every write path
// (`handlePublishTemplate` chief among the flows this file exercises)
// awaits `getProfile()` for real, so a file that never mocked it before
// (profile used to be a synchronous local IndexedDB read that never failed)
// now sends every one of those calls at the global `fetch` stub, which
// always throws. A resolved default here is what every OTHER App-mounting
// test file in this project already has.
// `getCachedRole` resolves to `'admin'` (not `undefined`, unlike most other
// App-mounting test files) — this file is the primary suite that exercises
// PUBLISHING end to end, and Task 17's role gate hides the Publish control
// entirely while unresolved. An admin can always publish (§7), so this
// keeps every existing publish-flow assertion here testing what it always
// tested, rather than a permission check this file was never about.
vi.mock('./lib/db/profile', () => ({
  getProfile: async () => ({ id: 'u1', initials: 'AB', name: 'A B' }),
  getCachedRole: () => 'admin' as const,
}));

// Task 18: see the note above — `WorkspaceSettings` is fetched from the
// server now too. Failing this quietly (App.tsx's own `.catch(() => {})`)
// would be enough on its own, but a resolved default avoids leaving
// `isConfigured` permanently false for every test in this file.
vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: async () => (
    { modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1 }
  ),
  saveWorkspaceSettings: vi.fn(),
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

  it('surfaces a refusal from the firm s service with its own message, never an empty matters list', async () => {
    // Stage 2: the matters list is an HTTP read now, so "empty is not broken"
    // has a new set of ways to go wrong — a 401, a 403, a 503, a network
    // failure, a timeout, a body that would not parse. Every one of them
    // arrives as a `ModelError`, which `describeLoadError` passes through
    // BECAUSE it already carries a specific, actionable message; folding it
    // into the generic fallback would leave a reader retrying something that
    // will keep failing, and rendering it as `[]` would tell a firm with a
    // hundred matters that they have none.
    listMattersMock.mockRejectedValue(new ModelError(
      'This needs a LexPrompt role, and your account has none.', 'not_permitted', 403,
    ));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('needs a LexPrompt role');
    expect(container.textContent).not.toContain('No matters yet');
  });

  it('surfaces an unreachable service as its own message, never an empty matters list', async () => {
    listMattersMock.mockRejectedValue(new ModelError(
      "LexPrompt could not reach your firm's service (Failed to fetch).", 'network', 0,
    ));
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).toContain('could not reach');
    expect(container.textContent).not.toContain('No matters yet');
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
    clickNav(container, 'Playbooks');
    await flush();

    expect(container.textContent).toContain('another tab');
    expect(container.textContent).not.toContain('No templates yet');
  });

  it('surfaces a generic load failure with a retry, never an empty library', async () => {
    listPlaybooksMock.mockRejectedValue(new Error('boom'));
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
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
    clickNav(container, 'Playbooks');
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
    clickNav(container, 'Playbooks');
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
    clickNav(container, 'Playbooks');
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

  // Minor 4 (integrity review), PLAUSIBLE in the review, settled here.
  // `loadPlaybookForEdit` had no staleness guard: navigating from playbook A
  // to playbook B before A's `getTemplate` resolves let A's LATE answer land
  // after B's, overwriting the editor with A's name and clauses while the
  // URL and Version History/Position Health already agree on B.
  it('a slow load for one playbook does not overwrite the editor after navigating to another (Minor 4)', async () => {
    const playbookA = {
      id: 'pb-a', name: 'Alpha', contractType: 'NDA', systemPrompt: 's', formatPrompt: 'f',
      clauses: [], playbookId: 'pb-a', version: 1, changeSummary: '', publishedAt: 1,
      publishedByUserId: '', schemaVersion: 6,
    };
    const playbookB = {
      id: 'pb-b', name: 'Beta', contractType: 'NDA', systemPrompt: 's', formatPrompt: 'f',
      clauses: [], playbookId: 'pb-b', version: 1, changeSummary: '', publishedAt: 1,
      publishedByUserId: '', schemaVersion: 6,
    };

    let resolveA!: (value: unknown) => void;
    const pendingA = new Promise((resolve) => { resolveA = resolve; });
    getPlaybookMock.mockReset().mockImplementation(async (id: string) => {
      if (id === 'pb-a') return pendingA; // never resolves until we say so
      if (id === 'pb-b') return playbookB;
      return null;
    });
    // Called once per successful `getTemplate` resolution, in that order:
    // B's load completes in full (including this call) before A's
    // `getTemplate` is ever allowed to resolve, so the first call here is
    // for B and the (late) second is for A.
    getPlaybookContentMock
      .mockImplementationOnce(async () => playbookB)
      .mockImplementationOnce(async () => playbookA);

    window.history.replaceState(null, '', '/playbooks/pb-a');
    act(() => { root.render(<App />); });
    await flush();

    // Switch to B — a browser Back to a fresh URL, exactly as the failure
    // scenario describes — before A's load has resolved.
    window.history.pushState(null, '', '/playbooks/pb-b');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await flush();

    let nameInput = container.querySelector('input') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('Beta');

    // Now let A's stale load resolve.
    await act(async () => { resolveA(playbookA); });
    await flush();

    // A's late arrival must not clobber the editor now showing B.
    nameInput = container.querySelector('input') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('Beta');
    expect(window.location.pathname).toBe('/playbooks/pb-b');
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

  // Minor 6 (integrity review). `isTemplateDirty` used to latch true
  // forever after the FIRST keystroke on a published playbook with no
  // stored draft: `loadPlaybookForEdit` snapshotted `draft` itself (`null`
  // there) rather than what the editor actually DISPLAYS, so once typing
  // replaced `activeDraft` with a real object, `JSON.stringify(activeDraft)`
  // could never again equal that snapshot — not even after the edit was
  // undone back to the exact published text. Left uncaught, this test's
  // Back would trigger the keep/discard prompt over an edit that no longer
  // exists, "Save draft" below would stay enabled, and clicking it would
  // persist a content-identical draft the library's badge (keyed on the
  // draft's mere presence) could never stop calling "Unpublished changes".
  it('typing an edit and reverting it back to the published text leaves nothing unsaved (Minor 6)', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    const original = nameInput.value;
    act(() => { setInputValue(nameInput, `${original}X`); });
    act(() => { setInputValue(container.querySelector('input') as HTMLInputElement, original); });

    const saveDraftButton = Array.from(container.querySelectorAll('button'))
      .find(b => /save draft/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(saveDraftButton).toBeTruthy();
    expect(saveDraftButton.disabled).toBe(true);

    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(saveDraftMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/playbooks');
  });

  // Integrity re-review, Item 1 (Minor 6, second route). The route above
  // fixed the DANGLING-BASELINE mechanism, but an edit-SAVE-revert-save
  // cycle reaches the same unclearable badge a different way:
  // `isTemplateDirty` answers "is there something new since the last save
  // THIS SESSION" (deliberately different from `hasUnpublishedContent` —
  // see `TemplateEditor`'s own docstring on `unsavedChanges`), so once a
  // real edit has been saved once, `savedTemplateSnapshot` is the EDITED
  // content, and reverting the field makes `isTemplateDirty` true again
  // even though `hasUnpublishedContent` is now false. Saving AGAIN in that
  // state used to persist a `Playbook.draft` content-identical to the
  // published version — undetectable by `isTemplateDirty` from then on, so
  // Close/Back never runs `discardDraft`, and the library card (keyed on
  // the draft's bare presence) shows "Unpublished changes" forever with no
  // control left able to clear it, disagreeing with the editor's own
  // `hasUnpublishedContent`-gated Publish button and banner. The fix routes
  // every draft-persisting write through `hasUnpublishedContent` and
  // discards instead of saving when it says false.
  it('a Save-draft that reverts to the published content clears the stored draft rather than leaving a stale one (Item 1 / Minor 6)', async () => {
    let stored: typeof playbook & { draft?: unknown } = { ...playbook };
    listPlaybooksMock.mockReset().mockImplementation(async () => [stored]);
    getPlaybookMock.mockReset().mockImplementation(async () => stored);
    saveDraftMock.mockReset().mockImplementation(async (pb: typeof playbook, draft: unknown) => {
      stored = { ...pb, draft };
      return stored;
    });
    discardDraftMock.mockReset().mockImplementation(async () => {
      const { draft: _draft, ...rest } = stored;
      stored = rest as typeof playbook;
    });

    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    const original = nameInput.value;
    const saveDraftButton = () => Array.from(container.querySelectorAll('button'))
      .find(b => /save draft/i.test(b.textContent || '')) as HTMLButtonElement;
    const publishButton = () => Array.from(container.querySelectorAll('button'))
      .find(b => /^publish$/i.test((b.textContent || '').trim())) as HTMLButtonElement;

    // A real edit, saved for real — `savedTemplateSnapshot` becomes the
    // EDITED content, and the stored draft genuinely differs from v1.
    act(() => { setInputValue(nameInput, `${original} EDITED`); });
    await flush();
    act(() => { saveDraftButton().click(); });
    await flush();
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    expect(publishButton().disabled).toBe(false);

    // Revert the field back to the published text. The editor correctly
    // says there is nothing to publish...
    act(() => { setInputValue(container.querySelector('input') as HTMLInputElement, original); });
    await flush();
    expect(publishButton().disabled).toBe(true);
    // ...but Save draft re-enables, because `isTemplateDirty` compares
    // against the EDITED snapshot from the save above, not the published
    // version.
    expect(saveDraftButton().disabled).toBe(false);

    // Saving now must NOT persist a content-identical draft.
    act(() => { saveDraftButton().click(); });
    await flush();
    expect(discardDraftMock).toHaveBeenCalledTimes(1);
    expect(saveDraftMock).toHaveBeenCalledTimes(1); // not called a second time
    expect('draft' in stored).toBe(false);

    // Close: nothing left unsaved, so no prompt, and the library card must
    // agree with the editor that there is nothing unpublished.
    const closeButton = Array.from(container.querySelectorAll('button'))
      .find(b => /^close$/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { closeButton.click(); });
    await flush();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/playbooks');
    expect(container.textContent).not.toMatch(/unpublished changes/i);
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

  // Re-review N3 (test-coverage gap on Minor 4's fix): `versionHistoryRequestRef`
  // and `positionHealthRequestRef` are the two other "latest request wins"
  // guards named alongside `playbookForEditRequestRef` above, and neither had
  // a test. `positionHealthRequestRef`'s own doc comment calls its unguarded
  // failure the worst of the three: it does not just show stale TEXT, it can
  // report a false "HELD n of n" for a clause the open playbook shares an id
  // and standard-position wording with (e.g. a freshly re-imported copy) —
  // reproduced exactly below, with pb2 sharing pb1's clause id and wording.
  it('a stale position-health scan for one playbook does not produce a false HELD for another after navigating away (N3)', async () => {
    // pb2: a fresh import of the same playbook shape as pb1 — same clause id
    // and standard-position wording, never itself run.
    const v2 = { ...v1, id: 'v2', playbookId: 'pb2' };
    const identity2 = {
      id: 'pb2', name: 'Fresh Import', createdAt: 1, updatedAt: 2,
      currentVersionId: 'v2', schemaVersion: 6,
    };

    getPlaybookMock.mockReset().mockImplementation(async (id: string) =>
      (id === 'pb1' ? identity : id === 'pb2' ? identity2 : null));
    getPlaybookContentMock.mockImplementation(async (id: string) =>
      (id === 'pb1' ? v1 : id === 'pb2' ? v2 : null));

    let resolveVersionsA!: (value: unknown) => void;
    const pendingVersionsA = new Promise((resolve) => { resolveVersionsA = resolve; });
    listVersionsMock.mockReset().mockImplementation(async (playbookId: string) => {
      if (playbookId === 'pb1') return pendingVersionsA; // held open
      if (playbookId === 'pb2') return [v2];
      return [];
    });
    // Every matter has a verified `meets` against pb1's v1 — pb2 has never
    // been run, but shares matters (reviews are matter-scoped, not
    // playbook-scoped, so both scans see the same rows).
    listReviewsMock.mockReset().mockImplementation(async (matterId: string) => [reviewAgainst('v1', matterId)]);

    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();
    // pb1's automatic position-health scan is now stuck awaiting
    // `listVersions('pb1')`.

    window.history.pushState(null, '', '/playbooks/pb2');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await flush();
    await flush();

    // pb2's own scan resolved immediately and correctly: it has never been
    // run, so its shared clause/position is UNTESTED.
    expect(container.textContent).toContain('UNTESTED');
    expect(container.textContent).not.toMatch(/HELD/);

    // Now let pb1's stale scan resolve. Unguarded, this overwrites the
    // health map — built from pb2's clauses but pb1's versions/reviews —
    // with a false "HELD 2 of 2" for a position pb2 was never tested
    // against.
    await act(async () => { resolveVersionsA([v1]); });
    await flush();

    expect(container.textContent).toContain('UNTESTED');
    expect(container.textContent).not.toMatch(/HELD/);
    expect(window.location.pathname).toBe('/playbooks/pb2');
  });

  // The other half of `positionHealthRequestRef`'s guard: the catch branch
  // has its own copy of the check (`App.tsx`'s `loadPositionHealth`). A
  // stale REJECTION landing after navigating away must not stamp the
  // screen now showing a different, healthy playbook with an error that
  // belongs to the one just left.
  it('a stale position-health rejection for one playbook does not clobber a healthy scan for another after navigating away (N3, catch branch)', async () => {
    const v2 = { ...v1, id: 'v2', playbookId: 'pb2' };
    const identity2 = {
      id: 'pb2', name: 'Fresh Import', createdAt: 1, updatedAt: 2,
      currentVersionId: 'v2', schemaVersion: 6,
    };

    getPlaybookMock.mockReset().mockImplementation(async (id: string) =>
      (id === 'pb1' ? identity : id === 'pb2' ? identity2 : null));
    getPlaybookContentMock.mockImplementation(async (id: string) =>
      (id === 'pb1' ? v1 : id === 'pb2' ? v2 : null));

    let rejectVersionsA!: (reason: unknown) => void;
    const pendingVersionsA = new Promise((_resolve, reject) => { rejectVersionsA = reject; });
    // Swallow the "unhandled rejection" Node would otherwise report before
    // the app's own `.catch()` has a chance to attach — mirrors the
    // resolve-based version above, just for the rejecting case.
    pendingVersionsA.catch(() => {});
    listVersionsMock.mockReset().mockImplementation(async (playbookId: string) => {
      if (playbookId === 'pb1') return pendingVersionsA; // held open, will reject
      if (playbookId === 'pb2') return [v2];
      return [];
    });
    listReviewsMock.mockReset().mockResolvedValue([]);

    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();
    // pb1's automatic position-health scan is now stuck awaiting
    // `listVersions('pb1')`.

    window.history.pushState(null, '', '/playbooks/pb2');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await flush();
    await flush();

    // pb2's own scan resolved cleanly.
    expect(container.textContent).toContain('UNTESTED');
    expect(container.textContent).not.toMatch(/could not be read/i);

    // Now let pb1's stale scan REJECT. Unguarded, the catch branch would
    // stamp pb2's screen — the one actually on view — with an error that
    // belongs to the playbook the reader already left.
    await act(async () => { rejectVersionsA(new Error('disk')); });
    await flush();

    expect(container.textContent).toContain('UNTESTED');
    expect(container.textContent).not.toMatch(/could not be read/i);
    expect(window.location.pathname).toBe('/playbooks/pb2');
  });

  it('a stale version-history scan for one playbook does not overwrite another playbook\'s history after navigating away (N3)', async () => {
    const v2 = { ...v1, id: 'v2', playbookId: 'pb2' };
    const identity2 = {
      id: 'pb2', name: 'Fresh Import', createdAt: 1, updatedAt: 2,
      currentVersionId: 'v2', schemaVersion: 6,
    };

    getPlaybookMock.mockReset().mockImplementation(async (id: string) =>
      (id === 'pb1' ? identity : id === 'pb2' ? identity2 : null));
    getPlaybookContentMock.mockImplementation(async (id: string) =>
      (id === 'pb1' ? v1 : id === 'pb2' ? v2 : null));
    listReviewsMock.mockReset().mockResolvedValue([]);

    let resolveVersionsA!: (value: unknown) => void;
    const pendingVersionsA = new Promise((resolve) => { resolveVersionsA = resolve; });
    const alphaHistory = [{ ...v1, changeSummary: 'Alpha history marker' }];
    const betaHistory = [{ ...v2, changeSummary: 'Beta history marker' }];
    listVersionsMock.mockReset().mockImplementation(async (playbookId: string) => {
      if (playbookId === 'pb1') return pendingVersionsA; // held open
      if (playbookId === 'pb2') return betaHistory;
      return [];
    });

    window.history.replaceState(null, '', '/playbooks/pb1');
    act(() => { root.render(<App />); });
    await flush();
    await flush();

    let link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { link.click(); });
    await flush();
    // pb1's version-history scan is now stuck awaiting `listVersions('pb1')`.

    window.history.pushState(null, '', '/playbooks/pb2');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await flush();
    await flush();

    link = Array.from(container.querySelectorAll('button'))
      .find(b => /version history/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { link.click(); });
    await flush();

    expect(container.textContent).toContain('Beta history marker');
    expect(container.textContent).not.toContain('Alpha history marker');

    // Now let pb1's stale scan resolve. Unguarded, this overwrites the modal
    // — now showing pb2's history — with pb1's.
    await act(async () => { resolveVersionsA(alphaHistory); });
    await flush();

    expect(container.textContent).toContain('Beta history marker');
    expect(container.textContent).not.toContain('Alpha history marker');
  });
});

// The `Standard positions` tab used to initialise its rows to `[]` and hand
// them straight to a view with only three branches — error, empty,
// populated. So the FIRST click rendered "No standard positions yet" for the
// whole duration of the read (`listTemplates` + a `listVersions` per
// playbook + `listMatters` + a `listReviews` per matter, serialised), which
// told a firm it has no house positions when the truth was that the app had
// not finished looking. That is CLAUDE.md's failed-migration shape on the
// one screen whose entire job is "which of our house rules are drifting?".
//
// Driven from the nav button rather than by mounting the view with props,
// because the initial `[]` was App's, not the view's.
describe('App — the standard positions tab does not answer before it has read (Major 1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    getPlaybookMock.mockReset();
    listVersionsMock.mockReset().mockResolvedValue([]);
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

  it('says it is still reading, not that the firm has none, while the read is in flight', async () => {
    // Held open deliberately: this is the window the user actually sees, and
    // on a real IndexedDB it is proportional to how much data they have.
    let releaseTemplates: (rows: unknown[]) => void = () => {};
    listPlaybooksMock.mockReset().mockImplementation(
      () => new Promise<unknown[]>((resolve) => { releaseTemplates = resolve; }),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Standard positions');

    expect(container.textContent).toContain('Loading standard positions');
    expect(container.textContent).not.toContain('No standard positions yet');

    // And it is a transient state, not a spinner that never resolves: once
    // the read finishes and genuinely finds nothing, the empty state is the
    // honest answer and it appears.
    await act(async () => { releaseTemplates([]); });
    await flush();

    expect(container.textContent).toContain('No standard positions yet');
    expect(container.textContent).not.toContain('Loading standard positions');
  });

  it('reports a failed read as a failure, never as an empty firm', async () => {
    listPlaybooksMock.mockReset().mockRejectedValue(new Error('disk'));

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Standard positions');
    await flush();

    expect(container.textContent).toMatch(/could not be loaded/i);
    expect(container.textContent).not.toContain('No standard positions yet');
    expect(container.textContent).not.toContain('Loading standard positions');
  });
});
