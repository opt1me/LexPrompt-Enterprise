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
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();

// App.tsx talks to the playbook repository only through these named
// exports; mocking the module lets the mount effect's very first await
// reject deterministically, without needing a real (or fake) IndexedDB
// failure mode.
vi.mock('./lib/db/playbooks', () => ({
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: (...args: unknown[]) => getPlaybookMock(...args),
  savePlaybook: vi.fn(),
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

import App from './App';

async function flush() {
  // Two microtask turns: one for the mocked repository call's
  // resolution/rejection to reach the .then/.catch, one for the resulting
  // setState to flush through React.
  await act(async () => {
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
    mode: 'extraction' as const,
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
  };

  beforeEach(() => {
    localStorage.clear();
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listPlaybooksMock.mockReset().mockResolvedValue([playbook]);
    getPlaybookMock.mockReset();
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
    mode: 'extraction' as const,
    systemPrompt: 'You are an expert.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
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
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listPlaybooksMock.mockReset().mockResolvedValue([playbook]);
    getPlaybookMock.mockReset().mockResolvedValue(playbook);
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

  it('blocks Back and restores the URL when the editor is dirty and confirm() is declined', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValue(false);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'NDA Review EDITED'); });

    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Vetoed: the address bar must be restored to the editor's own URL...
    expect(window.location.pathname).toBe('/playbooks/pb1');
    // ...and the unsaved edit must still be showing, not discarded.
    const stillThere = container.querySelector('input') as HTMLInputElement | null;
    expect(stillThere?.value).toBe('NDA Review EDITED');
  });

  it('allows Back and discards the unsaved edit when the editor is dirty and confirm() is accepted', async () => {
    window.history.replaceState(null, '', '/playbooks/pb1');
    confirmSpy.mockReturnValue(true);
    act(() => { root.render(<App />); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'NDA Review EDITED'); });

    simulateBrowserBack('/playbooks');
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/playbooks');
    // Navigated away from the editor entirely — the edited input is gone,
    // not merely reverted in place.
    expect(container.textContent).toContain('NDA Review');
    expect(container.textContent).not.toContain('NDA Review EDITED');
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
