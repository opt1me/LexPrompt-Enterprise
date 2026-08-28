import { describe, it, expect } from 'vitest';
import { buildTestApi } from './helpers/apiHarness.ts';

const ISSUER = 'http://keycloak:8080/realms/lexprompt';
const PRINCIPAL = {
  issuer: ISSUER, subject: 'sub-real', groups: ['/reviewers'],
  name: 'A. Gray', email: 'a@firm.com',
};

describe('POST /v1/infer', () => {
  it('forwards the request and returns the gateway\'s response verbatim', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 200, json: { content: 'A.', usage: { promptTokens: 1, completionTokens: 1 },
        callId: 'c1', provider: 'openai',
        jurisdiction: { bloc: 'US', region: 'us', label: 'United States' } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: 'A.', callId: 'c1' });
    expect(calls.infer[0]).toMatchObject({ modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' });
  });

  it('sets the actor as (issuer, subject) from the token', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(calls.infer[0].actorIssuer).toBe(ISSUER);
    expect(calls.infer[0].actorSubject).toBe('sub-real');
  });

  // THE rule of this task.
  it('OVERWRITES a client-supplied actor rather than trusting it', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi',
                 actorSubject: 'sub-a-colleague', actorIssuer: 'https://evil.example',
                 workspaceId: 'another-firm' } });
    expect(calls.infer[0].actorSubject).toBe('sub-real');
    expect(calls.infer[0].actorIssuer).toBe(ISSUER);
    expect(calls.infer[0].workspaceId).toBe('ws-configured');
  });

  // The identity is issuer-scoped, and nothing anywhere assumes Entra's
  // shape. The same test with an Entra-shaped principal must pass unchanged.
  it('carries an Entra principal identically, with oid as the subject', async () => {
    const entra = { issuer: 'https://login.microsoftonline.com/t/v2.0', subject: 'oid-1', groups: [] };
    const { app, calls } = buildTestApi({ principal: entra });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(calls.infer[0].actorIssuer).toBe('https://login.microsoftonline.com/t/v2.0');
    expect(calls.infer[0].actorSubject).toBe('oid-1');
  });

  it('passes a group_overage refusal through as 403, not as 401', async () => {
    const { app, calls } = buildTestApi({ principal: null, principalError: {
      code: 'group_overage', status: 403,
      message: 'Your account is in too many groups…',
    } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'group_overage' } });
    expect(calls.infer).toHaveLength(0);
  });

  it('refuses with 401 and never calls the gateway when there is no token', async () => {
    const { app, calls } = buildTestApi({ principal: null });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'sign_in_required' } });
    expect(calls.infer).toHaveLength(0);
  });

  it('passes the gateway\'s status and error code through unchanged', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 400, json: { error: { code: 'model_not_allowed', message: 'no' } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'nope', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('turns an unreachable gateway into a service_misconfigured 503, not a 500', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, inferThrows: new Error('ECONNREFUSED') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
  });
});

describe('GET /v1/models', () => {
  it('proxies the gateway\'s list rather than holding a copy (S14)', async () => {
    const models = [{ id: 'm', provider: 'openai', model: 'gpt-4o', label: 'GPT-4o',
      jurisdiction: { bloc: 'US', region: 'us', label: 'United States' }, contextLength: 1,
      supportsImages: false, supportsStructuredOutput: true, isDefault: true }];
    const { app } = buildTestApi({ principal: PRINCIPAL, modelsResponse: { status: 200, json: { models } } });
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer t' } });
    expect(res.json()).toEqual({ models });
  });

  it('returns an EMPTY list as an empty list, not as an error', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, modelsResponse: { status: 200, json: { models: [] } } });
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: [] });
  });

  it('requires a token', async () => {
    const { app } = buildTestApi({ principal: null });
    expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
  });
});
