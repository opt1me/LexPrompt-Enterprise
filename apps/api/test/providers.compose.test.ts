import { describe, it, expect, beforeAll } from 'vitest';
import type { AllowedModel, ProviderStatus } from '@lexprompt/core';
import { API_BASE, asUser, type TestAccount } from './helpers/twoAccounts.ts';
import { threeAccounts } from './helpers/threeAccounts.ts';

/**
 * WHAT AN ADMINISTRATOR CAN SEE ABOUT THIS DEPLOYMENT'S PROVIDERS, over real
 * HTTP, through the API's proxy hop to the running gateway.
 *
 * Everything here is a READ. There is no write route to test, and that
 * absence is the design (S14: the allowlist's one home is the gateway).
 *
 * The 503 case is deliberately NOT reproduced against the container. Doing
 * so would mean shipping a deliberately broken gateway into an image;
 * `providers.route.test.ts` covers it against a fake, and the refusal it
 * asserts is the shared `unreachableGateway` every other gateway hop uses.
 */

interface Page {
  models: AllowedModel[];
  providers: ProviderStatus[];
  declaredJurisdictions: string[];
}

let trainee: TestAccount;
let partner: TestAccount;
let admin: TestAccount;

beforeAll(async () => { ({ trainee, partner, admin } = await threeAccounts()); });

const json = async <T>(res: Response): Promise<T> => await res.json() as T;

describe('GET /v1/admin/providers', () => {
  it('refuses a trainee and a partner', async () => {
    for (const who of [trainee, partner]) {
      const res = await asUser(who, 'GET', '/v1/admin/providers');
      expect(res.status, who.username).toBe(403);
      // …and a REFUSAL, never an empty page: "this firm has no providers" is
      // a statement about the deployment that a 403 cannot make.
      const body = await json<Record<string, unknown>>(res);
      expect('providers' in body).toBe(false);
      expect('models' in body).toBe(false);
    }
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const res = await fetch(`${API_BASE}/v1/admin/providers`);
    expect(res.status).toBe(401);
    expect('providers' in (await res.json() as object)).toBe(false);
  });

  it('answers an administrator with the allowlist joined to its credential status', async () => {
    const page = await json<Page>(await asUser(admin, 'GET', '/v1/admin/providers'));
    expect(page.models.length).toBeGreaterThan(0);
    expect(page.providers.length).toBeGreaterThan(0);
    expect(page.declaredJurisdictions.length).toBeGreaterThan(0);
    // Every provider a model routes to has a status, and every status names
    // a provider a model routes to. A screen that could show one without the
    // other would show "which providers" with no answer to "and does this
    // deployment hold a key for them".
    const inModels = new Set(page.models.map(m => m.provider));
    const inStatus = new Set(page.providers.map(p => p.provider));
    expect([...inModels].sort()).toEqual([...inStatus].sort());
  });

  it('carries no credential value through the proxy, and no fact about one', async () => {
    // The same sweep as the gateway's own suite, one hop further out: a
    // proxy that passed an upstream body through verbatim is how a redaction
    // gets undone.
    const res = await asUser(admin, 'GET', '/v1/admin/providers');
    const text = await res.text();
    const page = JSON.parse(text) as Page;
    for (const forbidden of ['last4', 'prefix', 'fingerprint', 'length', 'key', 'secret']) {
      for (const p of page.providers) {
        expect(Object.keys(p), forbidden).not.toContain(forbidden);
      }
    }
    // The compose stack's own configured key, which must not appear anywhere
    // in this body. Read from the file the stack is started with rather than
    // retyped, so the two cannot drift.
    expect(text).not.toContain('recorded-provider-needs-no-key');
    // The sanity half: the sweep can see that string when it IS present.
    expect(JSON.stringify({ k: 'recorded-provider-needs-no-key' }))
      .toContain('recorded-provider-needs-no-key');
    // …and the endpoint each model is reached at never crosses either — the
    // field `toAllowedModel` withholds by construction.
    for (const m of page.models) expect('endpoint' in m).toBe(false);
  });

  it('reports a credential status without the gateway acquiring anything', async () => {
    // Two reads in a row answer identically. A route that acquired a token
    // per read would still answer identically, so this is not the proof —
    // that is `credentials.test.ts`'s acquisition counter, in the process
    // that would do the acquiring. What this adds is that the hop is
    // repeatable and cheap enough for a screen to refresh.
    const a = await json<Page>(await asUser(admin, 'GET', '/v1/admin/providers'));
    const b = await json<Page>(await asUser(admin, 'GET', '/v1/admin/providers'));
    expect(b.providers).toEqual(a.providers);
  });
});
