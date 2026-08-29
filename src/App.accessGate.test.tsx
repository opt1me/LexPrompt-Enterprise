import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelError } from '@lexprompt/core';

// No @testing-library/react in this project — see App.notFound.test.tsx for
// the minimal-mocks precedent this file follows.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const migrateIfNeededMock = vi.fn();
const getProfileMock = vi.fn();

vi.mock('./lib/db/migrate', () => ({
  migrateIfNeeded: (...args: unknown[]) => migrateIfNeededMock(...args),
}));

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: vi.fn().mockResolvedValue([]),
  getPlaybook: vi.fn(),
  getPlaybookContent: vi.fn().mockResolvedValue(null),
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: vi.fn().mockResolvedValue([]),
  getMatter: vi.fn(),
  saveMatter: vi.fn(),
  newMatter: vi.fn(),
  deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: vi.fn().mockResolvedValue([]),
  getReview: vi.fn(),
  saveReview: vi.fn(),
  createDebouncedReviewSaver: vi.fn(),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  },
}));

// Task 17's own gate: `getProfile()` is what `useRole()` calls, and its
// failure is what drives the gate in every test below. `getCachedRole`
// still has to exist on the mock — `useRole()`'s OWN initial `useState`
// reads it once on mount, before the rejection has even happened — but it
// answers `undefined` here, matching `getProfile()` never having resolved.
vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  getCachedRole: () => undefined,
}));

vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: vi.fn().mockRejectedValue(new Error('irrelevant to this file')),
  saveWorkspaceSettings: vi.fn(),
}));

import App from './App';

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  migrateIfNeededMock.mockReset().mockResolvedValue({ status: 'not-needed', count: 0 });
  getProfileMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

/**
 * Task 17's App-level gate, end to end: `GET /v1/me` failing with each of
 * the three "told plainly" codes routes to `AccessRefusedPanel`; the fourth
 * (`service_misconfigured`) routes to the EXISTING `ServiceConfigError`
 * instead (Stage 1's Task 23 split, not reopened here); anything else
 * (a boot-time network blip) falls through and lets the ordinary app mount.
 *
 * `AccessRefusedPanel.test.tsx` and `ServiceConfigError.test.tsx` each
 * cover their own rendering in isolation; this file is the one place that
 * proves `App.tsx` actually WIRES the failed `useRole()` state to the right
 * one of them; a wiring bug (right panel, wrong trigger, or vice versa)
 * would pass both of those in isolation and only show up here.
 */
describe('App — the role gate beside the sign-in gate (Task 17)', () => {
  it('no_role renders AccessRefusedPanel, never the app shell', async () => {
    getProfileMock.mockRejectedValue(new ModelError(
      'Your account is not in any group that LexPrompt maps to a role. Your sign-in carries '
      + 'these groups: all-staff.',
      'no_role', 403,
    ));
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toMatch(/do not have access to LexPrompt/i);
    expect(container.textContent).toContain('all-staff');
    expect(container.textContent).not.toMatch(/no matters yet/i);
  });

  it('account_disabled renders its own AccessRefusedPanel message, not the no_role one', async () => {
    getProfileMock.mockRejectedValue(new ModelError(
      'Your LexPrompt account has been disabled by an administrator.',
      'account_disabled', 403,
    ));
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toMatch(/has been disabled/i);
    expect(container.textContent).not.toMatch(/no matters yet/i);
  });

  it('group_overage renders its own AccessRefusedPanel message too', async () => {
    getProfileMock.mockRejectedValue(new ModelError(
      'Your account is in too many groups for LexPrompt to read them from your sign-in.',
      'group_overage', 403,
    ));
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toMatch(/too many groups/i);
    expect(container.textContent).not.toMatch(/no matters yet/i);
  });

  it('service_misconfigured routes to ServiceConfigError, NOT AccessRefusedPanel', async () => {
    getProfileMock.mockRejectedValue(new ModelError(
      'LexPrompt could not establish who is calling. This is a deployment fault.',
      'service_misconfigured', 503,
    ));
    act(() => { root.render(<App />); });
    await flush();
    expect(container.querySelector('[data-service-config-error]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/do not have access to LexPrompt/i);
    expect(container.textContent).not.toMatch(/no matters yet/i);
  });

  it('an ordinary network failure falls through and still mounts the app shell', async () => {
    // A boot-time network blip is not evidence the account has no access —
    // blocking the whole app on it would be the confidently-wrong failure
    // this gate exists NOT to produce.
    getProfileMock.mockRejectedValue(new ModelError('offline', 'network', 0));
    act(() => { root.render(<App />); });
    await flush();
    expect(container.textContent).toMatch(/no matters yet/i);
    expect(container.textContent).not.toMatch(/do not have access to LexPrompt/i);
    expect(container.querySelector('[data-service-config-error]')).toBeNull();
  });
});
