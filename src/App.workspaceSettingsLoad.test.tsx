import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelError } from '@lexprompt/core';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';
import type { Matter, PlaybookVersion } from './types';

/**
 * Part 2A M1 — a failed `GET /v1/workspace/settings` is a LOAD FAILURE, not
 * "no model has been chosen".
 *
 * `getWorkspaceSettings` rejects on any failure and mints no default; App
 * used to throw that rejection away, leaving `modelChoiceId: ''`, which
 * `isConfigured` reads as "nothing chosen". One 503 at boot then refused
 * every run, every drafted playbook and every redline session for the rest
 * of the tab's life with "Choose a model in Settings to get started." — a
 * specific, wrong reason, routing a reviewer to a screen whose own
 * independent fetch usually succeeds and tells them a model IS configured
 * and is an administrator's to change.
 *
 * The empty-versus-broken rule, at the one load path in the HTTP move that
 * had missed it.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const listDocumentsMock = vi.fn();
const getProfileMock = vi.fn();


vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: vi.fn(),
  getPlaybookContent: async (id: string) => (await listPlaybooksMock())
    .find((p: { id: string }) => p.id === id) ?? null,
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
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

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({ getDocumentBlob: vi.fn() }));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: vi.fn(),
  saveReview: vi.fn().mockResolvedValue(undefined),
  createDebouncedReviewSaver: () => ({
    scheduleSave: vi.fn(), saveNow: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
  }),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  getCachedRole: () => undefined,
}));

const getWorkspaceSettingsMock = vi.fn();
vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: (...args: unknown[]) => getWorkspaceSettingsMock(...args),
  saveWorkspaceSettings: vi.fn(),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([TEST_ALLOWED_MODEL]),
  },
}));

vi.mock('./features/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ templates, onRun }: { templates: PlaybookVersion[]; onRun: (t: PlaybookVersion) => void }) => (
    <div>{templates.map(t => <button key={t.id} onClick={() => onRun(t)}>{`Run ${t.name}`}</button>)}</div>
  ),
}));

// Auto-picks the one matter, so the click on Run reaches `requestView('run')`
// — which is where `ensureConfigured` actually decides. Without this the
// flow stops at the picker and BOTH assertions below pass vacuously.
vi.mock('./features/matters/MatterPickerModal', () => ({
  MatterPickerModal: ({ isOpen, onPick }: { isOpen: boolean; onPick: (matterId: string) => void }) => {
    React.useEffect(() => {
      if (isOpen) onPick('m1');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);
    return null;
  },
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
  if (!button) throw new Error(`No button found matching ${String(text)}`);
  act(() => { (button as HTMLButtonElement).click(); });
}

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1', name: 'Basic Contract Review', contractType: 'NDA',
    systemPrompt: '', formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: '' }],
    playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 1,
    publishedByUserId: '', schemaVersion: 6,
  };
}

const MATTER: Matter = { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };

/** The message the server's own envelope carries — a `ModelError`, which
 *  `describeLoadError` passes through verbatim rather than replacing. */
const SERVER_MESSAGE = 'LexPrompt could not reach your firm’s service.';

describe('App — a failed workspace-settings load is broken, not empty (Part 2A M1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    listPlaybooksMock.mockReset().mockResolvedValue([makeTemplate()]);
    listMattersMock.mockReset().mockResolvedValue([MATTER]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    getWorkspaceSettingsMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('renders the failure with a Retry instead of behaving as "nothing chosen"', async () => {
    getWorkspaceSettingsMock.mockRejectedValue(
      new ModelError(SERVER_MESSAGE, 'service_misconfigured', 503));
    await act(async () => { root.render(<App />); });
    await flush();

    // The `ModelError`'s own sentence, passed through by `describeLoadError`
    // exactly as every other load path in this file does it.
    expect(container.textContent).toContain(SERVER_MESSAGE);
    // And a way back in — never a dead end.
    expect(Array.from(container.querySelectorAll('button'))
      .some(b => /^Retry$/.test((b.textContent || '').trim()))).toBe(true);
  });

  it('refuses a run with the load failure, NOT with "Choose a model in Settings"', async () => {
    getWorkspaceSettingsMock.mockRejectedValue(
      new ModelError(SERVER_MESSAGE, 'service_misconfigured', 503));
    await act(async () => { root.render(<App />); });
    await flush();

    clickNav(container, 'Playbooks');
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(SERVER_MESSAGE);
    // THE WRONG REASON. A reviewer told this is sent to a screen they cannot
    // act on, which then contradicts the sentence that sent them there.
    expect(container.textContent).not.toContain('Choose a model in Settings to get started.');
  });

  it('Retry re-fetches, and a success clears the banner and configures the app', async () => {
    getWorkspaceSettingsMock.mockRejectedValueOnce(
      new ModelError(SERVER_MESSAGE, 'service_misconfigured', 503));
    await act(async () => { root.render(<App />); });
    await flush();
    expect(container.textContent).toContain(SERVER_MESSAGE);

    getWorkspaceSettingsMock.mockResolvedValue({
      modelChoiceId: TEST_ALLOWED_MODEL.id, concurrency: 5, version: 1, updatedAt: 1,
    });
    clickByText(container, /^Retry$/);
    await flush();

    expect(getWorkspaceSettingsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain(SERVER_MESSAGE);
  });

  it('still says "Choose a model" when the fetch SUCCEEDS and nothing is chosen', async () => {
    // The other half: the third state must not swallow the real empty one.
    getWorkspaceSettingsMock.mockResolvedValue(
      { modelChoiceId: '', concurrency: 5, version: 1, updatedAt: 1 });
    await act(async () => { root.render(<App />); });
    await flush();

    expect(container.textContent).not.toContain(SERVER_MESSAGE);
    clickNav(container, 'Playbooks');
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();
    expect(container.textContent).toContain('Choose a model in Settings to get started.');
  });
});
