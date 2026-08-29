import React from 'react';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlaybookVersion, Review, DocumentRecord } from './types';
import { ModelError, SERVICE_CONFIG_HINT } from '@lexprompt/core';

// No @testing-library/react in this project — see Toast.test.tsx /
// App.test.tsx for the precedent this follows: drive a real react-dom root
// directly, mocking App.tsx's repository/module boundaries.
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
const getProfileMock = vi.fn();
const migrateIfNeededMock = vi.fn();

// App's startup migration gate (Task 14) runs before any of the mocks
// below are ever reached; mocking it keeps this file's mount sequence
// deterministic instead of depending on a real (fake-indexeddb) round
// trip. The migration's own three outcomes are covered separately in
// App.migration.test.tsx.
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
  saveReview: vi.fn().mockResolvedValue(undefined),
  createDebouncedReviewSaver: vi.fn(() => ({
    scheduleSave: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

// listModels would otherwise attempt a real network fetch from the
// settings.modelChoiceId-watching effect; stubbed out since it's unrelated to
// what these tests exercise.
vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([TEST_ALLOWED_MODEL]),
  },
}));

// extractClause is runReview.ts's only external dependency (both are v1
// code this sub-project does not touch) — mocking it lets a "live" run be
// driven deterministically to an auth-rejected finding without a real
// network call or a real API key.
const extractClauseMock = vi.fn();
vi.mock('./features/review/extractClause', () => ({
  extractClause: (...args: unknown[]) => extractClauseMock(...args),
}));

// Stubs for the two screens whose OWN rendering/upload mechanics are
// covered elsewhere (RunPanel.test.tsx; TemplateLibrary has no dedicated
// test file but its rendering is not what's under test here). This test
// file is about App.tsx's auth-error wiring specifically: does a live
// auth error redirect to Settings, and does a reopened review's stale one
// NOT. Fighting jsdom's file-input upload just to reach that assertion
// would test RunPanel's upload plumbing a second time, not this.
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
  // Auto-runs with one fake document the instant it mounts — this is what
  // "a run is now live" means for this test file's purposes.
  RunPanel: ({ onRun }: { onRun: (docs: unknown[]) => void }) => {
    React.useEffect(() => {
      onRun([{ id: 'live-doc', name: 'live.txt', text: 'hello', file: new File(['hello'], 'live.txt'), kind: 'txt' }]);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>run-panel-stub</div>;
  },
  RunProgressBar: () => null,
  RunCancelledBanner: () => null,
  RunEmptyFindingsBanner: () => null,
  RunInterruptedBanner: () => null,
}));

// Important 3 (fix wave): running a playbook from the Library now opens a
// matter picker before it ever reaches RunPanel. That flow's own mechanics
// have dedicated coverage elsewhere; here it would only add steps to a file
// about auth-error wiring specifically, so it's stubbed to auto-pick a
// fixed matter id the instant it opens — mirroring how RunPanel above is
// stubbed to auto-run the instant IT mounts.
vi.mock('./features/matters/MatterPickerModal', () => ({
  MatterPickerModal: ({ isOpen, onPick }: { isOpen: boolean; onPick: (matterId: string) => void }) => {
    React.useEffect(() => {
      if (isOpen) onPick('m-picked');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);
    return null;
  },
}));

import App from './App';

async function flush(times = 6) {
  // Several microtask turns: extractClause's mocked promise, runReview's
  // internal await chain (mapWithConcurrency), the resulting onUpdate ->
  // setRun, and the auth-error effect it triggers, each need at least one.
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

// Task 23: `AUTH_ERROR_MESSAGE`/`handleAuthError` are retired — a per-clause
// live failure (`Finding.authError`, carrying only a boolean and the
// model's own message text, never a `ModelError.code`) can no longer be
// told which of the split's two audiences it's for, so the "Important 4"
// effect stays deliberately generic and never navigates. Genuine dispatch
// by code (`handleModelError`) is exercised separately below, through a
// thrown `ModelError` rather than a resolved `Finding`.
const STALE_TOAST = 'This review stopped: a clause failed for a reason a retry will not fix. '
  + 'See the affected finding below for what the model reported.';
// The Settings screen's own subtitle, used here purely as "we are on
// Settings". Task 22 rewrote it when the API-key section was deleted:
// there is no OpenRouter account to connect any more, only a model to
// choose off the firm's allowlist.
const ON_SETTINGS = 'Choose the model your firm has configured for reviews.';
const STALE_FINDING_ERROR = 'Your OpenRouter API key was rejected: User not found.';
// A stale, already-persisted finding shaped like the NEW `service_misconfigured`
// wording (real gateway text names itself this way on purpose — see
// `ResultsView.namesConfigurationFault`) — used to prove the reopened-review
// guard suppresses ANY live-redirect handling regardless of what the old
// finding's text says, while `ResultsView` still renders it as
// `<ServiceConfigError>` rather than a plain card.
const STALE_CONFIG_FINDING_ERROR =
  "The AI provider rejected LexPrompt's credentials. This is a configuration problem in the "
  + `firm's deployment, ${SERVICE_CONFIG_HINT}.`;

// The exact sentences `handleModelError` shows for each code (Task 23's
// copy table) — mirrored here, not imported, so a change to App.tsx's own
// strings that silently drifts from the table is caught by these tests
// rather than by both sides moving in lockstep.
const SIGN_IN_TOAST = 'Your sign-in has expired. Sign in again to continue.';
const NOT_PERMITTED_TOAST = 'Your account does not have access to LexPrompt. Ask your IT team to add you.';
const GROUP_OVERAGE_TOAST = 'Your account is in too many groups for LexPrompt to read them from your sign-in.';

function makePlaybook(): PlaybookVersion {
  return {
    id: 'p1',
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

function makeStaleReview(errorText: string = STALE_FINDING_ERROR): Review {
  return {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: makePlaybook(),
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: {
      d1: {
        c1: { clauseId: 'c1', status: 'error', citations: [], error: errorText, authError: true, verification: { state: 'unchecked' }, notes: [] },
      },
    },
    modelId: 'test/model',
    startedAt: 1,
    completedAt: 2,
    createdByUserId: 'u1',
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
    role: 'standalone',
  };
}

describe('App — auth-error redirect vs. a reopened review\'s stale authError finding (Task 11 fix round 1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset();
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset();
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset();
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'Test User', initials: 'TU' });
    extractClauseMock.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    window.history.pushState(null, '', '/');
  });

  it('opening a review whose only finding already has authError (from its original run) does NOT redirect to Settings, and its findings still render', async () => {
    getMatterMock.mockResolvedValue({ id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 });
    getReviewMock.mockResolvedValue(makeStaleReview());
    getDocumentMock.mockResolvedValue(makeDocumentRecord());

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    // The historical finding's own error text is real work and must still
    // be visible...
    expect(container.textContent).toContain(STALE_FINDING_ERROR);
    // ...but it must NOT have been (mis)treated as a fresh rejection: no
    // redirect to Settings, no generic "this review stopped" toast either.
    expect(container.textContent).not.toContain(ON_SETTINGS);
    expect(container.textContent).not.toContain(STALE_TOAST);
  });

  it('a genuine live per-clause auth failure while a run is in flight stops the run with a generic notice, never Settings', async () => {
    // Task 23: `extractClause.ts` is unchanged by this task and stores only
    // a boolean (`authError`) plus the model's own message text on a
    // `Finding` — never a `ModelError.code` — so the "Important 4" effect
    // that watches a LIVE run's findings can no longer tell which of the
    // split's two audiences a per-clause failure is for. It must not guess
    // "Settings": that would be exactly wrong for a configuration-class
    // failure, which is the one thing this whole task exists to stop.
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockResolvedValue({
      clauseId: 'c1', status: 'error', citations: [], error: STALE_FINDING_ERROR, authError: true,
    });

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(STALE_TOAST);
    expect(container.textContent).not.toContain(ON_SETTINGS);
  });

  it('does not let a reopened review\'s already-handled authError silence a genuinely new one from a later run', async () => {
    // First: open the stale review (as in the first test) — this is what
    // sets the "already handled" guard.
    getMatterMock.mockResolvedValue({ id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 });
    getReviewMock.mockResolvedValue(makeStaleReview());
    getDocumentMock.mockResolvedValue(makeDocumentRecord());
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).not.toContain(STALE_TOAST); // sanity: guard is armed

    // Then: start a brand new run (Library flow) whose own live call also
    // fails. Despite the earlier suppression, THIS failure must still be
    // noticed — proving the guard resets between runs rather than
    // permanently silencing every future auth-class failure for the rest of
    // the session.
    extractClauseMock.mockResolvedValue({
      clauseId: 'c1', status: 'error', citations: [], error: STALE_FINDING_ERROR, authError: true,
    });
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(STALE_TOAST);
    expect(container.textContent).not.toContain(ON_SETTINGS);
  });

  // --- Task 23: the copy split, dispatched by `handleModelError` --------
  //
  // These five exercise `handleStartRun`'s `runReview(...).catch(...)`
  // safety net: `extractClause.ts` itself never rejects (it always resolves
  // to an error `Finding`, proven by the three tests above), but a REAL
  // `ModelError` — carrying a `code` and, where the gateway sends one, a
  // `callId` — is exactly what the safety net exists to route correctly
  // wherever it originates. Mocking `extractClause` to reject is the only
  // way, in this file's existing harness, to hand that real error through
  // to `handleModelError` without inventing a second mocking seam.
  it('a live sign_in_required during a run shows the sign-in message and does not navigate to Settings', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockRejectedValue(
      new ModelError('Your sign-in could not be verified. Sign in again.', 'sign_in_required', 401),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(SIGN_IN_TOAST);
    expect(container.textContent).not.toContain(ON_SETTINGS);
  });

  it('a live service_misconfigured during a run shows the configuration message in place, does not navigate to Settings, and shows the callId', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockRejectedValue(
      new ModelError(
        "The AI provider rejected LexPrompt's credentials. This is a configuration problem in "
        + `the firm's deployment, ${SERVICE_CONFIG_HINT}.`,
        'service_misconfigured', 503, 'call-svc-9',
      ),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).not.toContain(ON_SETTINGS);
    expect(container.textContent).toContain(SERVICE_CONFIG_HINT);
    expect(container.textContent).toContain('call-svc-9');
  });

  it('a live model_not_allowed does navigate to Settings', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockRejectedValue(
      new ModelError("The model is not on this workspace's allowlist.", 'model_not_allowed', 400),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(ON_SETTINGS);
  });

  it('a live jurisdiction_not_allowed navigates to Settings, shows the jurisdiction, and shows that nothing was sent', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockRejectedValue(
      new ModelError(
        'This model is processed in EU · Sweden Central, which your firm\'s deployment does not '
        + 'permit. Nothing was sent. Choose another model, or ask your IT team to reconcile the '
        + 'model list with the permitted jurisdictions.',
        'jurisdiction_not_allowed', 403, 'call-jur-1',
      ),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(ON_SETTINGS);
    expect(container.textContent).toContain('EU · Sweden Central');
    expect(container.textContent).toContain('Nothing was sent');
  });

  it('a live group_overage shows the overage message, does not navigate to Settings, does not offer sign-in, and does not show the not_permitted wording', async () => {
    localStorage.setItem('lexprompt.settings', JSON.stringify({ modelChoiceId: 'test/model', concurrency: 5 }));
    listPlaybooksMock.mockResolvedValue([makePlaybook()]);
    extractClauseMock.mockRejectedValue(
      new ModelError(
        'Your account is in too many groups for LexPrompt to read them from your sign-in '
        + '(group overage). This is not a problem you can fix by signing in again — ask your '
        + 'administrator to grant LexPrompt directory read access, or to reduce your group '
        + 'memberships.',
        'group_overage', 403,
      ),
    );

    act(() => { root.render(<App />); });
    await flush();
    clickNav(container, 'Playbooks');
    await flush();
    clickByText(container, /^Run Basic Contract Review$/);
    await flush();

    expect(container.textContent).toContain(GROUP_OVERAGE_TOAST);
    expect(container.textContent).not.toContain(ON_SETTINGS);
    expect(container.textContent).not.toContain(NOT_PERMITTED_TOAST);
    // The literal negative test: this would trivially pass if the app simply
    // never showed ANY of `not_permitted`'s wording, which is not what this
    // guards. `NOT_PERMITTED_TOAST` above already proves the exact sentence
    // is absent; this proves even its most reusable fragment is too.
    expect(container.textContent).not.toContain('does not have access');
  });

  it('reopening a review whose only finding already has authError still does not redirect anywhere and still renders its findings, even when that finding\'s own text names a configuration fault', async () => {
    // Re-asserts the reopened-review guard against the NEW routing: a stale
    // finding shaped like the new `service_misconfigured` wording must
    // still (a) trigger no App-level redirect at all (the guard doesn't
    // read the finding's text, only whether it's fresh) and (b) still
    // render — now specifically as `<ServiceConfigError>`, proving
    // `ResultsView`'s own inline classification runs for a reopened review
    // exactly as it would for a live one.
    getMatterMock.mockResolvedValue({ id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 });
    getReviewMock.mockResolvedValue(makeStaleReview(STALE_CONFIG_FINDING_ERROR));
    getDocumentMock.mockResolvedValue(makeDocumentRecord());

    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flush();

    expect(container.textContent).not.toContain(ON_SETTINGS);
    expect(container.textContent).not.toContain(STALE_TOAST);
    // Rendered as `<ServiceConfigError>`, not a plain error card carrying
    // the raw finding text verbatim.
    expect(container.querySelector('[data-service-config-error]')).toBeTruthy();
    expect(container.textContent).toContain(SERVICE_CONFIG_HINT);
  });
});
