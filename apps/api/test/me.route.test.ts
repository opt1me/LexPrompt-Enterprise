import { describe, it, expect } from 'vitest';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Principal } from '../src/oidc.ts';

const PRINCIPAL: Principal = {
  issuer: 'https://issuer.test', subject: 'sub-1', groups: [],
  name: 'Ada Lovelace', email: 'ada@lexprompt.local',
};

describe('GET /v1/me', () => {
  it('with no bearer token, refuses with 401 sign_in_required from the hook, not the route', async () => {
    const { app } = buildTestApi({ principal: null });
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('sign_in_required');
  });

  it('signed in, answers 200 with the TOKEN\'s issuer/subject, ignoring a body-supplied subject', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: 'Bearer t' },
      payload: { subject: 'someone-else', issuer: 'https://not-this.test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issuer).toBe(PRINCIPAL.issuer);
    expect(body.subject).toBe(PRINCIPAL.subject);
  });
});

describe('PUT /v1/me', () => {
  it('trims a display name and recomputes initials', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({
      method: 'PUT', url: '/v1/me',
      headers: { authorization: 'Bearer t' },
      payload: { displayName: '  Ada Lovelace  ' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayName).toBe('Ada Lovelace');
    expect(body.initials).toBe('AL');
  });

  it('refuses an empty display name with 400, and never reaches the database', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({
      method: 'PUT', url: '/v1/me',
      headers: { authorization: 'Bearer t' },
      payload: { displayName: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.dbQueries).toEqual([]);
  });

  it('changes the display name and ignores a body-supplied role', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, actor: { id: 'a1', displayName: 'Old Name', initials: 'ON', role: 'reviewer', workspaceId: 'ws-configured' } });
    const res = await app.inject({
      method: 'PUT', url: '/v1/me',
      headers: { authorization: 'Bearer t' },
      payload: { displayName: 'Ada Lovelace', role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The role did NOT change (still the actor's original 'reviewer') —
    // this is what stops the first assertion passing because the route
    // ignored the whole body rather than reading displayName and rejecting role.
    expect(body.role).toBe('reviewer');
    expect(body.displayName).toBe('Ada Lovelace');
  });

  it('a ModelError thrown by resolveActor reaches the client as its own status/code, not a 500', async () => {
    const { app } = buildTestApi({
      principal: PRINCIPAL,
      actorError: {
        code: 'account_disabled', status: 403,
        message: 'Your LexPrompt account has been disabled by an administrator.',
      },
    });
    const res = await app.inject({
      method: 'GET', url: '/v1/me',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_disabled');
  });
});
