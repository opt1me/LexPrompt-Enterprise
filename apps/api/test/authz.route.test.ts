import { describe, it, expect } from 'vitest';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ROLES, type Role } from '@lexprompt/core';
import { buildTestApi, collectRoutes, WORKSPACE_ID } from './helpers/apiHarness.ts';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';
import { registerRoleGate } from '../src/auth/requireRole.ts';
import { ROUTE_POLICY, routeKey, type RoutePolicyTable } from '../src/auth/routeTable.ts';
import { registerErrorEnvelope } from '../src/server.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/config.ts';
import type { Actor } from '../src/auth/actor.ts';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-1',
  groups: ['reviewers'],
};

/**
 * The routes the REAL server registers, asked of Fastify itself.
 *
 * Deduplicated through `routeKey`, which folds Fastify's synthesised HEAD
 * routes onto the GET they shadow — see `routeTable.ts` for why that is a
 * security property rather than a convenience.
 */
async function registeredKeys(): Promise<string[]> {
  const { app } = buildTestApi({ principal: PRINCIPAL });
  await app.ready();
  const keys = [...new Set(collectRoutes(app).map(r => routeKey(r.method, r.url)))].sort();
  await app.close();
  return keys;
}

describe('every route has a declared minimum role', () => {
  it('finds a realistic number of routes (a scanner that matches nothing passes vacuously)', async () => {
    // Stage 1 shipped a scanner that matched nothing and read as coverage.
    // This assertion is what stops the two checks below being decoration —
    // and it is also what fails if `registerRoleGate` is ever moved BELOW the
    // route registrations in `buildServer`, since its `onRoute` hook would
    // then see none of them.
    const keys = await registeredKeys();
    expect(keys.length).toBeGreaterThan(3);
    // Named, so "found some routes" cannot pass while the one route a change
    // broke is missing.
    expect(keys).toContain('GET /v1/me');
    expect(keys).toContain('POST /v1/infer/stream');
  });

  it('has a policy entry for every registered route', async () => {
    const missing = (await registeredKeys()).filter(k => !(k in ROUTE_POLICY));
    // A new route with no entry FAILS THE BUILD. That is the whole mechanism:
    // the default is not "reviewer", it is "you have not decided yet".
    expect(missing).toEqual([]);
  });

  it('has no policy entry for a route that does not exist', async () => {
    // The other direction, and not symmetry for its own sake: a stale entry
    // is how a reader comes to believe a policy is in force for something
    // that is no longer there.
    const keys = new Set(await registeredKeys());
    expect(Object.keys(ROUTE_POLICY).filter(k => !keys.has(k)).sort()).toEqual([]);
  });

  it('folds HEAD onto GET, so a synthesised HEAD route cannot be a lower bar', () => {
    expect(routeKey('HEAD', '/v1/me')).toBe('GET /v1/me');
    expect(routeKey('head', '/v1/me')).toBe('GET /v1/me');
    expect(routeKey('post', '/v1/infer')).toBe('POST /v1/infer');
  });

  it('the only public route is /healthz, and the two exemption lists agree', async () => {
    // `buildServer`'s authentication hook exempts `/healthz` by URL; this
    // table exempts it by policy. Two lists that must agree is exactly the
    // shape that drifts, so the agreement is asserted rather than assumed.
    const publicKeys = Object.entries(ROUTE_POLICY)
      .filter(([, policy]) => policy === 'public').map(([key]) => key);
    expect(publicKeys).toEqual(['GET /healthz']);

    const { app, calls } = buildTestApi({ principal: null });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    // …and with a query string (Part 2A m11). The hook matched the whole
    // `req.url`, so a probe with a cache-buster needed a token: fail-closed,
    // but the two lists then agreed only on one exact string.
    expect((await app.inject({ method: 'GET', url: '/healthz?probe=1' })).statusCode).toBe(200);
    expect(calls.infer).toHaveLength(0);
    await app.close();
  });
});

// ===================================================================
// The registration-time refusal — the mechanism that makes "a new route
// cannot escape the table" structural rather than a list somebody keeps.
// ===================================================================
describe('a route with no policy entry cannot be registered at all', () => {
  it('throws at the registration itself, naming the route and what to do about it', async () => {
    // Fastify runs `onRoute` synchronously inside `app.post(...)` (checked
    // against fastify 5.12, not assumed), so the module that registers an
    // undeclared route cannot even finish — this does not wait for
    // `ready()`. Every test that builds a server fails, not only this suite.
    const app = Fastify({ logger: false });
    registerRoleGate(app, { 'GET /v1/known': 'reviewer' });
    app.get('/v1/known', async () => ({ ok: true }));
    expect(() => app.post('/v1/undeclared', async () => ({ ok: true })))
      .toThrow(/POST \/v1\/undeclared/);
    expect(() => app.put('/v1/undeclared', async () => ({ ok: true })))
      .toThrow(/ROUTE_POLICY/);
    await app.close();
  });

  it('starts when every route is declared', async () => {
    const app = Fastify({ logger: false });
    registerRoleGate(app, { 'GET /v1/known': 'reviewer' });
    app.get('/v1/known', async () => ({ ok: true }));
    await expect(app.ready()).resolves.toBeTruthy();
    await app.close();
  });
});

// ===================================================================
// §18 item 3: the web app hides what a role cannot do, because a dead button
// is bad design; the API REFUSES it, because a hidden button is not a
// security control.
//
// The RANKING is exercised on a server built from the REAL gate, the REAL
// error envelope and the REAL Actor type, over three stand-in routes — so
// the three levels are covered whatever the shipped table happens to hold.
// Everything under test here is production code; only the URLs are the
// test's.
//
// The SHIPPED table's own partner and admin entries are checked separately,
// below ("a reviewer is refused at every route the shipped table puts above
// them"). That second case exists because this fixture cannot catch a
// shipped route being downgraded: found by mutation — changing
// `POST /v1/playbooks/:id/versions` to `reviewer` in `routeTable.ts` left
// every case in this file green.
// ===================================================================
const TEST_POLICY: RoutePolicyTable = {
  'GET /v1/anyone': 'reviewer',
  'POST /v1/playbooks/:id/versions': 'partner',
  'PUT /v1/workspace/settings': 'admin',
};

function serverWithRole(role: Role): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorEnvelope(app, DEFAULT_MAX_BODY_BYTES);
  const actor: Actor = {
    id: 'actor-1', issuer: PRINCIPAL.issuer, subject: PRINCIPAL.subject,
    displayName: 'Test Person', initials: 'TP', role, workspaceId: WORKSPACE_ID,
  };
  app.addHook('preHandler', async req => { req.actor = actor; });
  registerRoleGate(app, TEST_POLICY);
  for (const key of Object.keys(TEST_POLICY)) {
    const [method, url] = key.split(' ');
    app.route({ method: method as 'GET', url, handler: async () => ({ reached: key }) });
  }
  return app;
}

describe('the API refuses, rather than the UI hiding', () => {
  const cases: { key: string; allowed: Role[] }[] = [
    { key: 'GET /v1/anyone', allowed: ['reviewer', 'partner', 'admin'] },
    { key: 'POST /v1/playbooks/:id/versions', allowed: ['partner', 'admin'] },
    { key: 'PUT /v1/workspace/settings', allowed: ['admin'] },
  ];

  for (const { key, allowed } of cases) {
    for (const role of ROLES) {
      const should = allowed.includes(role) ? 'allows' : 'refuses';
      it(`${should} a ${role} at ${key}`, async () => {
        const [method, url] = key.split(' ');
        const app = serverWithRole(role);
        const res = await app.inject({
          method: method as 'GET', url: url.replace(':id', 'x'), payload: {},
        });
        if (allowed.includes(role)) {
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ reached: key });
        } else {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('not_permitted');
          // The message must NAME what is needed. "Forbidden" sends a
          // trainee to a support queue with nothing to say.
          expect(res.json().error.message).toMatch(/partner|administrator/i);
          expect(res.json().error.message).toContain(role);
        }
        await app.close();
      });
    }
  }

  it('a reviewer forging headers that claim a higher role is still refused', async () => {
    // The one property that makes this a security control and not a
    // rendering decision: the role comes from the token the API validated,
    // and nothing a caller sends can name a different one.
    const app = serverWithRole('reviewer');
    const res = await app.inject({
      method: 'PUT', url: '/v1/workspace/settings', payload: { role: 'admin' },
      headers: {
        'x-lexprompt-role': 'admin', 'x-role': 'admin', 'x-user-role': 'admin',
        'x-lexprompt-actor': 'someone-else', 'x-forwarded-user': 'an-admin',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_permitted');
    await app.close();
  });

  it('a route that reached the router with no policy entry is REFUSED, not allowed', async () => {
    // Layer 2. `onRoute` only sees routes registered after the gate, so a
    // route registered before it escapes the registration check — and this
    // is what happens to it then. Refusing everything is the safe direction;
    // the alternative default is "ships open".
    const app = Fastify({ logger: false });
    registerErrorEnvelope(app, DEFAULT_MAX_BODY_BYTES);
    let reached = false;
    app.get('/v1/registered-too-early', async () => { reached = true; return { ok: true }; });
    app.addHook('preHandler', async req => {
      req.actor = {
        id: 'a', issuer: PRINCIPAL.issuer, subject: PRINCIPAL.subject,
        displayName: 'A', initials: 'A', role: 'admin', workspaceId: WORKSPACE_ID,
      };
    });
    registerRoleGate(app, TEST_POLICY);
    const res = await app.inject({ method: 'GET', url: '/v1/registered-too-early' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('service_misconfigured');
    // …and an ADMIN is refused too, so this is not a role check that a high
    // enough role walks through.
    expect(reached).toBe(false);
    await app.close();
  });

  it('a URL no route matches is still a 404, not a 503', async () => {
    // Fastify runs global preHandler hooks for the not-found path too, with
    // `routeOptions.url` undefined. Reading `req.url` there instead would
    // turn every mistyped address into "LexPrompt has no authorisation
    // policy for GET /v1/mattres — this is a deployment fault", which is a
    // confident wrong answer about the deployment.
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({
      method: 'GET', url: '/v1/mattres', headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/no GET \/v1\/mattres endpoint/);
    await app.close();
  });
});

describe('a reviewer is refused at every route the shipped table puts above them', () => {
  it('gets 403 at each partner and admin route, on the real server', async () => {
    // The mirror of the case below, and the one the fixture-based matrix
    // above cannot provide: it proves the SHIPPED table, so downgrading a
    // partner route to `reviewer` fails HERE as well as in the route suite
    // that exercises the behaviour. Two failures is the right number — the
    // table and the behaviour are checked separately.
    const above = Object.keys(ROUTE_POLICY)
      .filter(k => ROUTE_POLICY[k] !== 'reviewer' && ROUTE_POLICY[k] !== 'public').sort();
    // The LIST, not a count. A loop over "whatever is above reviewer" cannot
    // see a route LEAVING that set — downgrade one and the loop simply skips
    // it, which is how the first version of this case stayed green under
    // exactly the mutation it was written to catch. Naming them means a
    // route dropping out of the set has to be a deliberate edit here.
    expect(above).toEqual([
      'GET /v1/admin/blob-orphans',
      'POST /v1/admin/blob-orphans/delete',
      // Stage 5 Part 5C. All five at `admin`, and a PARTNER is refused at
      // each of them too — §7's "an admin is not a super-reviewer" read in
      // the other direction.
      'GET /v1/admin/role-mappings',
      'POST /v1/admin/role-mappings',
      'POST /v1/admin/role-mappings/preview',
      'PUT /v1/admin/role-mappings/:id',
      'DELETE /v1/admin/role-mappings/:id',
      // Stage 5 Task 12: turning an account off, and retiring a name.
      'POST /v1/admin/users/:id/disable',
      'POST /v1/admin/users/:id/enable',
      'POST /v1/admin/users/:id/pseudonymise',
      // Stage 5 Task 14: the providers an administrator can see. A READ, and
      // there is no write route to pair it with.
      'GET /v1/admin/providers',
      // Stage 5 Task 15: the workspace audit extract — the widest read in the
      // application, and the artefact that leaves the building.
      'GET /v1/admin/audit-export',
      'POST /v1/playbooks/import',
      'POST /v1/playbooks/:id/versions',
      'POST /v1/changesets/:id/publish',
      'PUT /v1/workspace/settings',
    ].sort());
    for (const key of above) {
      const [method, url] = key.split(' ');
      const { app } = buildTestApi({ principal: PRINCIPAL });
      const res = await app.inject({
        method: method as 'GET', url,
        headers: { authorization: 'Bearer t' },
        ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
      });
      expect(res.statusCode, key).toBe(403);
      await app.close();
    }
  });
});

describe('a reviewer reaches every route the shipped table says they may', () => {
  it('is not refused at any reviewer route on the real server', async () => {
    for (const key of Object.keys(ROUTE_POLICY)) {
      if (ROUTE_POLICY[key] !== 'reviewer') continue;
      const [method, url] = key.split(' ');
      const { app } = buildTestApi({ principal: PRINCIPAL });
      const res = await app.inject({
        method: method as 'GET', url,
        headers: { authorization: 'Bearer t' },
        ...(method === 'POST' || method === 'PUT'
          ? { payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi', displayName: 'A Name' } }
          : {}),
      });
      expect(res.statusCode, key).not.toBe(403);
      await app.close();
    }
  });
});

// ===================================================================
// S29's absence, one layer up from `oidc.test.ts`'s: there is no way to turn
// AUTHORISATION off either, and no key that names a role for a caller.
// ===================================================================
describe('there is no way to turn authorisation off (S29)', () => {
  const SOURCES = [...walk(path.join(ROOT, 'apps/api/src')), ...walk(path.join(ROOT, 'src'))];

  it('no environment key anywhere disables auth or overrides a role', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (/SKIP_AUTH|DISABLE_AUTH|AUTH_BYPASS|ALLOW_ANONYMOUS|FORCE_ROLE|ROLE_OVERRIDE/i
        .test(codeOf(file))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
    // The scanner must be able to find something, or this assertion is
    // decoration. Stage 1 shipped a scanner that matched nothing.
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it('the gate is installed in exactly ONE place, with no policy of its own', () => {
    // Structural, in the shape of `oidc.test.ts`'s "req.principal is written
    // in exactly ONE place". `registerRoleGate` takes a policy parameter so
    // the suite above can stand up routes this stage does not have yet; that
    // parameter must never be used in production, where the table is the one
    // in `routeTable.ts` and nothing else.
    const calls: string[] = [];
    for (const file of walk(path.join(ROOT, 'apps/api/src'))) {
      // The DECLARATION is skipped by matching `function` in front of it —
      // not by filtering on what its argument list looks like. Filtering on
      // shape is how this check first went wrong: excluding any match
      // containing a colon skipped the declaration AND every injected policy
      // object, so the one thing it exists to catch was invisible to it.
      for (const m of codeOf(file).matchAll(/(function\s+)?registerRoleGate\(([^)]*)\)/g)) {
        if (m[1]) continue;
        calls.push(`${rel(file)}: registerRoleGate(${m[2]})`);
      }
    }
    expect(calls).toEqual(['apps/api/src/server.ts: registerRoleGate(app)']);
  });

  it('the role a request runs under is read from the actor, never from the request', () => {
    // `req.actor` is written in exactly one place (`server.ts`'s hook, from
    // `resolveActor`), so a header cannot become a role however it is
    // spelled — the same guard shape that caught an impersonation header
    // slipping past a five-word denylist in Stage 1.
    const writes: string[] = [];
    for (const file of walk(path.join(ROOT, 'apps/api/src'))) {
      for (const line of codeOf(file).split(/\r?\n/)) {
        if (/\.actor\s*=[^=]/.test(line)) writes.push(`${rel(file)}: ${line.trim()}`);
      }
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^apps\/api\/src\/server\.ts: /);
    expect(writes[0]).toContain('deps.resolveActor(');
  });
});
