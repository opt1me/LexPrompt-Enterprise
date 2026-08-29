import React from 'react';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, PlaybookVersion } from './types';

// No @testing-library/react in this project — see Toast.test.tsx for the
// precedent this follows: drive a real react-dom root directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const listDocumentsMock = vi.fn();
const saveMatterMock = vi.fn();
const newMatterMock = vi.fn();
const getProfileMock = vi.fn();
const migrateIfNeededMock = vi.fn();
const listModelsMock = vi.fn();

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
  getMatter: vi.fn(),
  saveMatter: (...args: unknown[]) => saveMatterMock(...args),
  newMatter: (...args: unknown[]) => newMatterMock(...args),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({
  getDocumentBlob: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: vi.fn(),
  saveReview: vi.fn().mockResolvedValue(undefined),
  createDebouncedReviewSaver: vi.fn(() => ({
    scheduleSave: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  // See App.authoring.test.tsx's copy of this comment: keeps `useRole()`'s
  // App-level gate in its harmless `unknown` state for this file's purposes.
  getCachedRole: () => undefined,
}));

// Task 18: see App.authoring.test.tsx's copy of this comment — the model
// choice is fetched from the server now, not read from `localStorage`.
const getWorkspaceSettingsMock = vi.fn().mockResolvedValue({ modelChoiceId: '', concurrency: 5, version: 1, updatedAt: 1 });
vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: (...args: unknown[]) => getWorkspaceSettingsMock(...args),
  saveWorkspaceSettings: vi.fn(),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: (...args: unknown[]) => listModelsMock(...args),
  },
}));

vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: PlaybookVersion[]; onRun: (t: PlaybookVersion) => void }) => (
    <div>
      {templates.map(t => (
        <button key={t.id} onClick={() => onRun(t)}>{`Run ${t.name}`}</button>
      ))}
    </div>
  ),
}));

vi.mock('./features/review/RunPanel', () => ({
  RunPanel: ({ template }: { template: PlaybookVersion }) => <div>run-panel-stub: {template.name}</div>,
  RunProgressBar: () => null,
  RunCancelledBanner: () => null,
  RunEmptyFindingsBanner: () => null,
  RunInterruptedBanner: () => null,
}));

import App from './App';

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

function clickNav(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find(b => new RegExp(`^${label}$`, 'i').test((b.textContent || '').trim()));
  if (!button) throw new Error(`No nav button found for "${label}"`);
  act(() => { (button as HTMLButtonElement).click(); });
}

function clickByText(container: HTMLDivElement, text: string | RegExp) {
  const re = typeof text === 'string' ? new RegExp(text) : text;
  const button = Array.from(container.querySelectorAll('button')).find(b => re.test(b.textContent || ''));
  if (!button) throw new Error(`No button found matching ${text}`);
  act(() => { (button as HTMLButtonElement).click(); });
}

// Bypasses React's tracked-value shortcut (setting `.value` directly is a
// no-op from React's perspective) so the subsequent 'input' event is seen
// as a genuine change — mirrors App.test.tsx's own `setInputValue` helper.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1',
    name: 'Basic Contract Review',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' }],
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: '',
    schemaVersion: 6,
  };
}

function makeMatter(id: string, name: string): Matter {
  return { id, name, ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

describe('App — running a playbook from the Library goes through a matter picker (Important 3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    // `requestView('run')` (which `handlePickMatterForRun`/
    // `handleCreateMatterForRun` both end in) gates on `ensureConfigured()`
    // exactly as the pre-existing Library flow did — an API key is needed
    // here purely to get past that gate, not something this file is testing.
    getWorkspaceSettingsMock.mockReset().mockResolvedValue({
      modelChoiceId: 'test/model', concurrency: 5, version: 1, updatedAt: 1,
    });
    listModelsMock.mockReset().mockResolvedValue([TEST_ALLOWED_MODEL]);
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([makeTemplate()]);
    listMattersMock.mockReset().mockResolvedValue([makeMatter('m1', 'Acme v Bolt')]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listDocumentsMock.mockReset().mockResolvedValue([]);
    // `saveMatter` is declared `Promise<Matter>` and always was; this mock
    // used to resolve `undefined`, which only went unnoticed while
    // `createMatter` threw the returned record away. Since Stage 2 the
    // record the STORE confirmed is the one the caller uses — the server
    // sets `updatedAt`, mints a `version` and records the authenticated
    // owner — so a mock that answers nothing is a mock that does not
    // implement the function it stands in for.
    saveMatterMock.mockReset().mockImplementation(
      (m: { id: string }) => Promise.resolve({ ...m, updatedAt: 2, version: 1 }),
    );
    newMatterMock.mockReset().mockImplementation((name: string, ownerId: string) => ({
      id: 'new-matter-id', name, ownerId, createdAt: 1, updatedAt: 1,
    }));
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  it('does not enter the run panel until a matter is chosen', async () => {
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).not.toContain('run-panel-stub');
    expect(container.textContent).toContain('Run "Basic Contract Review" against a matter');
    expect(container.textContent).toContain('Acme v Bolt');
  });

  it('picking an existing matter enters the run panel scoped to it', async () => {
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    clickByText(container, /^Acme v Bolt$/);
    await flush();

    expect(container.textContent).toContain('run-panel-stub: Basic Contract Review');
    expect(container.textContent).not.toContain('against a matter');
  });

  it('creating a new matter from the picker also enters the run panel, scoped to the new matter', async () => {
    listMattersMock.mockResolvedValue([]); // no existing matters
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    clickByText(container, /New matter/);
    await flush();

    const nameInput = Array.from(container.querySelectorAll('input'))[0] as HTMLInputElement;
    act(() => { setInputValue(nameInput, 'Brand New Matter'); });
    await flush();

    clickByText(container, /Create and run/);
    await flush();

    expect(newMatterMock).toHaveBeenCalledWith('Brand New Matter', 'u1');
    expect(saveMatterMock).toHaveBeenCalled();
    expect(container.textContent).toContain('run-panel-stub: Basic Contract Review');
  });

  it('Cancel closes the picker without starting a run', async () => {
    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    clickByText(container, /^Cancel$/);
    await flush();

    expect(container.textContent).not.toContain('run-panel-stub');
    expect(container.textContent).not.toContain('against a matter');
  });

  /**
   * Final review M4. `ModelPicker` already refused to resolve a stored
   * choice that is no longer on the allowlist and told the user "nothing is
   * selected" — but `isConfigured` read the stored id alone, so this shell
   * went on waving the same user into a run that would fail on every clause
   * with the gateway's `model_not_allowed`. The guard that exists to stop
   * "a flow that can only fail with an obscure error" did not fire, in the
   * one case it was written for.
   */
  describe('a model choice the allowlist no longer serves', () => {
    it('stops the run at the gate and says which of the two things is wrong', async () => {
      listModelsMock.mockResolvedValue([{ ...TEST_ALLOWED_MODEL, id: 'some-other-model' }]);
      act(() => { root.render(<App />); });
      await flush();
      clickNav(container, 'Playbooks');
      await flush();
      clickByText(container, /^Run Basic Contract Review$/);
      await flush();
      clickByText(container, /^Acme v Bolt$/);
      await flush();

      // `ensureConfigured` is what stands between the matter picker and the
      // run panel; the run must not start.
      expect(container.textContent).not.toContain('run-panel-stub');
      expect(container.textContent).toContain('is no longer on the list for this workspace');
    });

    // Task 18 retired this file's own "drops the retired capability flags…"
    // case: the capability fields (`modelSupportsImages` etc.) are never
    // PERSISTED anywhere any more — not in `localStorage` (Task 18 removed
    // that write entirely) and not on the server (`WorkspaceSettings`'s own
    // docstring: `apps/api` never reads or writes them). There is nothing
    // left for a "drops the stale flags from storage" test to observe; the
    // behaviour it protected — a scanned PDF must not be sent as images to a
    // retired model — is still covered by the sibling test above, which
    // proves the run gate stops the flow before any capability flag would
    // ever be read. (`ModelPicker`'s own "the id stays, visibly unresolvable"
    // behaviour is covered directly in `ModelPicker.test.tsx`.)

    it('does not lock a working user out when the allowlist read merely FAILED', async () => {
      listModelsMock.mockRejectedValue(new Error('offline'));
      act(() => { root.render(<App />); });
      await flush();
      clickNav(container, 'Playbooks');
      await flush();
      clickByText(container, /^Run Basic Contract Review$/);
      await flush();
      clickByText(container, /^Acme v Bolt$/);
      await flush();

      // A network blip is not evidence that a model was retired.
      expect(container.textContent).toContain('run-panel-stub');
      expect(container.textContent).not.toContain('is no longer on the list for this workspace');
    });
  });
});
