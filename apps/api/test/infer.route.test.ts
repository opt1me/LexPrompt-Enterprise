import { describe, it, expect } from 'vitest';
import { buildTestApi, WORKSPACE_ID } from './helpers/apiHarness.ts';
import { GatewayUnreadableError } from '../src/gatewayClient.ts';

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

  // Task 6: `actorUserId` goes ALONGSIDE the (issuer, subject) pair, never
  // in place of it — the whole of Stage 1's interface note 3 (§6.5).
  it('sends the actor id from the token-derived actor, overwriting anything the client sent', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL,
      actor: { id: 'server-side-id', displayName: 'A', initials: 'A', role: 'reviewer', workspaceId: WORKSPACE_ID } });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi',
                 actorUserId: 'i-am-someone-else', actorSubject: 'also-not-me' } });
    expect(calls.infer[0].actorUserId).toBe('server-side-id');
    expect(calls.infer[0].actorSubject).toBe('sub-real');
    expect(calls.infer[0].actorIssuer).toBe(ISSUER);
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

// ===================================================================
// M6: a gateway 401 is about THIS SERVICE's credentials, never the user's.
//
// `apps/gateway/src/callerAuth.ts` answers 401 `not_permitted` in five
// places when `apps/api` fails to prove its own identity — an absent or
// unrecognised client-certificate subject, a missing or invalid Entra token.
// Those were forwarded verbatim, so a lawyer was told to sign in again over
// a mismatch between two services' configuration. `not_permitted` is in the
// browser's SIGN_IN_CODES, so it routes straight to the sign-in action.
//
// The gateway has no other 401: a provider rejecting the firm's credential
// becomes a 503 `service_misconfigured` inside `modelErrorFor` before it
// ever leaves that service. So 401 from the gateway is unambiguous.
// ===================================================================
describe('a gateway caller-auth refusal is not the user\'s problem (M6)', () => {
  it('turns the gateway\'s 401 into a 503 service_misconfigured', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 401, json: { error: {
        code: 'not_permitted', message: 'This gateway is reachable only by the LexPrompt API.',
      } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
  });

  it('says the user\'s sign-in is not the problem', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 401, json: { error: { code: 'not_permitted', message: 'no' } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.json().error.message).toMatch(/not the problem/i);
    expect(res.json().error.message).not.toMatch(/sign in again/i);
  });

  it('does the same on /v1/models', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      modelsResponse: { status: 401, json: { error: { code: 'not_permitted', message: 'no' } } } });
    const res = await app.inject({ method: 'GET', url: '/v1/models',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
  });

  // The half that must NOT change. Verbatim pass-through is right for every
  // refusal that is about the request rather than about this hop's identity.
  it('still forwards 400, 403 and 413 verbatim', async () => {
    for (const [status, code] of [[400, 'model_not_allowed'], [403, 'jurisdiction_not_allowed'],
      [413, 'prompt_too_large']] as const) {
      const { app } = buildTestApi({ principal: PRINCIPAL,
        inferResponse: { status, json: { error: { code, message: 'no' } } } });
      const res = await app.inject({ method: 'POST', url: '/v1/infer',
        headers: { authorization: 'Bearer t' },
        payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
      expect(res.statusCode, code).toBe(status);
      expect(res.json(), code).toMatchObject({ error: { code } });
    }
  });
});

// m7: "could not reach it" and "reached it and could not read the reply" are
// different diagnoses, and the second is the one an administrator acts on.
describe('an unreadable gateway reply is not an unreachable gateway (m7)', () => {
  it('says LexPrompt REACHED the service when the reply was not JSON', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferThrows: new GatewayUnreadableError(502, 'Unexpected token < in JSON at position 0') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/reached the firm's AI service/i);
    expect(res.json().error.message).not.toMatch(/could not reach/i);
    expect(res.json().error.message).toContain('502');
  });

  it('still says COULD NOT REACH for a connection failure', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferThrows: new Error('connect ECONNREFUSED 10.1.2.3:8081') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.json().error.message).toMatch(/could not reach/i);
    // m8, deliberately: the underlying cause is kept. Every reader of this
    // body has passed `requireUser`, and a bare "could not reach" is a
    // sentence nobody can act on.
    expect(res.json().error.message).toContain('ECONNREFUSED');
  });
});

// ===================================================================
// M5 / m6: what this hop refuses, and in whose envelope.
// ===================================================================
describe('Fastify\'s own refusals arrive in LexPrompt\'s envelope', () => {
  it('answers an over-large body with a 413 naming the limit, not FST_ERR_CTP_BODY_TOO_LARGE', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL, maxBodyBytes: 512 });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'x'.repeat(2000) } });
    expect(res.statusCode).toBe(413);
    // The shape `gatewayModelClient` reads. Fastify's own envelope
    // (`{statusCode, error, message, code}`) has no `error.code` at all, so
    // the browser rendered the bare string "HTTP 413" to a lawyer.
    expect(res.json()).toMatchObject({ error: { code: 'prompt_too_large' } });
    expect(res.json().error.message).toContain('512');
    expect(res.json().error.message).toMatch(/scanned document/i);
    expect(calls.infer).toHaveLength(0);
  });

  it('accepts a body the gateway would accept — the middle hop is not the tightest', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    // Larger than Fastify's undeclared 1 MiB default, which is what this hop
    // silently enforced before `bodyLimit` was declared.
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'x'.repeat(1_200_000) } });
    expect(res.statusCode).toBe(200);
    expect(calls.infer).toHaveLength(1);
  });

  it('answers an unknown path in LexPrompt\'s envelope', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({ method: 'GET', url: '/v1/nope',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'unknown' } });
  });

  it('answers malformed JSON in LexPrompt\'s envelope', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: '{ not json' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'unknown' } });
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
