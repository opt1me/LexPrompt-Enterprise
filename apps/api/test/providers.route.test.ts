import { describe, it, expect } from 'vitest';
import { buildTestApi } from './helpers/apiHarness.ts';

/**
 * WHAT `GET /v1/admin/providers` DOES WHEN THE GATEWAY IS NOT THERE.
 *
 * Against a fake, deliberately: the compose suite proves the happy path over
 * real HTTP through the real gateway, and reproducing THIS case there would
 * mean shipping a deliberately broken gateway into an image.
 *
 * The claim is one sentence and it is the whole of the file: an empty
 * provider list reads as *"this deployment has no providers configured"*,
 * which is a statement about the firm's own configuration that this API is
 * in no position to make.
 */

const ADMIN = {
  id: '00000000-0000-0000-0000-0000000000e1',
  displayName: 'An Admin', initials: 'AA', role: 'admin' as const,
  workspaceId: 'ws-configured',
};

const PRINCIPAL = { issuer: 'i', subject: 's-admin-providers', groups: ['admins'] };

const get = (app: ReturnType<typeof buildTestApi>['app']) => app.inject({
  method: 'GET', url: '/v1/admin/providers', headers: { authorization: 'Bearer t' },
});

describe('the providers read, when the gateway will not answer', () => {
  it('answers a loud 503 when the gateway is unreachable, and NEVER an empty provider list',
    async () => {
      const { app } = buildTestApi({
        principal: PRINCIPAL, actor: ADMIN,
        credentialsThrows: new Error('ECONNREFUSED'),
        modelsResponse: { status: 200, json: { models: [] } },
      });
      // `modelsResponse` answers, so the failure has to come from the
      // CREDENTIAL hop — which is what this route added.
      const res = await get(app);
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('service_misconfigured');
      const body = res.json() as Record<string, unknown>;
      expect('providers' in body).toBe(false);
      expect('models' in body).toBe(false);
      await app.close();
    });

  it('answers 503 when the gateway REFUSES the credential read, naming what it could not read',
    async () => {
      const { app } = buildTestApi({
        principal: PRINCIPAL, actor: ADMIN,
        modelsResponse: { status: 200, json: { models: [] } },
        credentialsResponse: { status: 503, json: { error: { code: 'service_misconfigured' } } },
      });
      const res = await get(app);
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('service_misconfigured');
      expect(body.error.message).toContain('credential status');
      // The upstream body is NOT passed through: a proxy that forwards an
      // upstream error body is how a redaction one hop up gets undone.
      expect(res.body).not.toContain('"error":{"code":"service_misconfigured"}}}');
      expect('providers' in (body as unknown as object)).toBe(false);
      await app.close();
    });

  it('joins the two answers when both come back', async () => {
    // The positive half. Without it, a route that refused unconditionally
    // would pass both cases above.
    const { app } = buildTestApi({
      principal: PRINCIPAL, actor: ADMIN,
      modelsResponse: { status: 200, json: { models: [{ id: 'm', provider: 'openai' }] } },
      credentialsResponse: {
        status: 200,
        json: {
          providers: [{ provider: 'openai', auth: 'key', configured: true, modelCount: 1 }],
          declaredJurisdictions: ['UK'],
        },
      },
    });
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      models: { id: string }[];
      providers: { provider: string }[];
      declaredJurisdictions: string[];
    };
    expect(body.models.map(m => m.id)).toEqual(['m']);
    expect(body.providers.map(p => p.provider)).toEqual(['openai']);
    expect(body.declaredJurisdictions).toEqual(['UK']);
    await app.close();
  });
});
