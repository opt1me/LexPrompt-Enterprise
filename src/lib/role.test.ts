import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushUntil } from '../test/mount';

const apiGet = vi.fn();

vi.mock('./api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiSend: vi.fn(),
}));

const { currentRole, useRole, canPublish } = await import('./role');
const { forgetProfile, getProfile } = await import('./db/profile');

const ME = {
  id: 'uuid-1', issuer: 'iss', subject: 'sub', displayName: 'Ada',
  initials: 'A', role: 'partner' as const, workspaceId: 'ws-1',
};

beforeEach(() => {
  apiGet.mockReset();
  forgetProfile();
});

describe('currentRole', () => {
  it('is undefined before /v1/me has answered, and NOT "reviewer"', () => {
    // A default role is a permission granted by a loading state. The UI
    // must render "not yet known" rather than the lowest role, or a partner
    // sees Publish disabled for a moment and clicks something else.
    expect(currentRole()).toBeUndefined();
  });

  it('is the resolved role once getProfile has answered', async () => {
    apiGet.mockResolvedValue(ME);
    await getProfile();
    expect(currentRole()).toBe('partner');
  });
});

/** No JSX in this file (it is `.ts`, not `.tsx`) — a plain function
 *  component built with `createElement`, which is all `useRole()`'s own
 *  hook rules need to exercise it inside a real render. */
function Probe({ onState }: { onState: (s: ReturnType<typeof useRole>) => void }) {
  const state = useRole();
  onState(state);
  return React.createElement('span', { 'data-testid': 'role-state' }, state.status);
}

describe('useRole', () => {
  it('starts unknown, then resolves known once /v1/me answers', async () => {
    apiGet.mockResolvedValue(ME);
    let last: ReturnType<typeof useRole> = { status: 'unknown' };
    const container = mount(React.createElement(Probe, { onState: (s) => { last = s; } }));
    await flushUntil(() => last.status === 'known', 'the role to resolve');
    expect(container.querySelector('[data-testid="role-state"]')?.textContent).toBe('known');
  });

  it('resolves to failed, carrying the error, when the check cannot complete', async () => {
    const { ModelError } = await import('@lexprompt/core');
    const boom = new ModelError('Your account is not in any group…', 'no_role', 403);
    apiGet.mockRejectedValue(boom);
    let last: ReturnType<typeof useRole> = { status: 'unknown' };
    // A plain `let` read directly in this function body — rather than inside
    // a closure like `flushUntil`'s own callback — keeps TypeScript's
    // control-flow narrowing pinned to the DECLARATION's literal type
    // (`{status:'unknown'}`) even after `last` is reassigned by the `onState`
    // closure below; going through a function call instead reads the
    // variable's actual DECLARED (wide) type fresh, every time.
    const current = (): ReturnType<typeof useRole> => last;
    mount(React.createElement(Probe, { onState: (s) => { last = s; } }));
    await flushUntil(() => current().status === 'failed', 'the role check to fail');
    const finalState = current();
    if (finalState.status !== 'failed') throw new Error('expected the role state to have failed');
    expect(finalState.error).toBe(boom);
  });

  it('never reports a role while unknown — three states, not two', async () => {
    let resolveMe!: (v: typeof ME) => void;
    apiGet.mockReturnValue(new Promise((res) => { resolveMe = res; }));
    let last: ReturnType<typeof useRole> = { status: 'unknown' };
    mount(React.createElement(Probe, { onState: (s) => { last = s; } }));
    expect(last.status).toBe('unknown');
    resolveMe(ME);
    await flushUntil(() => last.status === 'known', 'the role to resolve');
  });
});

describe('canPublish', () => {
  it('is true for partner and admin, false for reviewer and unknown', () => {
    expect(canPublish('partner')).toBe(true);
    expect(canPublish('admin')).toBe(true);
    expect(canPublish('reviewer')).toBe(false);
    expect(canPublish(undefined)).toBe(false);
  });
});
