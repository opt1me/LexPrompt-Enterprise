import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@lexprompt/core';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi, type GatewayResponse } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * `workspace_setting` end to end — Task 18's route, over the real table
 * `001_identity.sql` already ships and the real gateway-allowlist check.
 *
 * §6.6: the workspace's model choice is admin configuration now, not a
 * per-browser preference. This file proves the four things that make that
 * true rather than merely intended — GET is everyone's, PUT is admin's, the
 * choice is checked against the gateway's OWN allowlist rather than a second
 * copy of it, and a stale write is refused (P9) — plus the one thing easiest
 * to get wrong silently: omitting a field on a PUT must not reset it.
 */

const WS = '00000000-0000-0000-0000-000000000001';

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-workspace-settings',
  groups: ['reviewers'],
};

async function aUser(t: Tx, role: Role, workspaceId: string = WS): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', $2, 'active')
     returning id`, [workspaceId, role]);
  return rows[0].id;
}

const ALLOWLIST: GatewayResponse = {
  status: 200,
  json: {
    models: [
      {
        id: 'uk-gpt', provider: 'azure-openai', model: 'gpt-4o', label: 'UK GPT-4o',
        jurisdiction: 'uk', contextLength: 128_000, supportsImages: true,
        supportsStructuredOutput: true, isDefault: true,
      },
      {
        id: 'us-claude', provider: 'anthropic', model: 'claude-3', label: 'US Claude',
        jurisdiction: 'us', contextLength: 200_000, supportsImages: true,
        supportsStructuredOutput: true, isDefault: false,
      },
    ],
  },
};

interface Harness {
  app: FastifyInstance;
  get(): Promise<Record<string, unknown>>;
  raw(method: 'GET' | 'PUT', body?: unknown): Promise<{ statusCode: number; body: string; json(): any }>;
}

function harness(t: Tx, actorId: string, role: Role, modelsResponse: GatewayResponse = ALLOWLIST): Harness {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: { id: actorId, displayName: 'Test', initials: 'TT', role, workspaceId: WS },
    modelsResponse,
  });
  const inject = (method: 'GET' | 'PUT', body?: unknown) =>
    app.inject({
      method, url: '/v1/workspace/settings',
      headers: { authorization: 'Bearer t' }, payload: body as never,
    });
  return {
    app,
    async get() {
      const res = await inject('GET');
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    },
    raw: (method, body) => inject(method, body),
  };
}

describe('workspace settings over a real Postgres', () => {
  it('answers the workspace model choice to any signed-in role, creating the row lazily', async () => {
    await withPg(async t => {
      const reviewer = await aUser(t, 'reviewer');
      const settings = await harness(t, reviewer, 'reviewer').get();
      // No admin has ever set one — '' is "not configured", the same
      // convention `Settings.modelChoiceId` used, not a second shape (null).
      expect(settings.modelChoiceId).toBe('');
      expect(settings.concurrency).toBe(5);
      expect(typeof settings.version).toBe('number');
    });
  });

  it('refuses a PUT from a reviewer and from a partner, and accepts one from an admin', async () => {
    await withPg(async t => {
      for (const role of ['reviewer', 'partner'] as const) {
        const user = await aUser(t, role);
        const h = harness(t, user, role);
        const res = await h.raw('PUT', { modelChoiceId: 'uk-gpt', version: 1 });
        expect(res.statusCode, `${role} PUT`).toBe(403);
        expect(res.json().error.code).toBe('not_permitted');
        await h.app.close();
      }
      const admin = await aUser(t, 'admin');
      const h = harness(t, admin, 'admin');
      // Read first, exactly as a real settings screen would, so the PUT
      // states the version it read.
      const before = await h.get();
      const res = await h.raw('PUT', { modelChoiceId: 'uk-gpt', version: before.version });
      expect(res.statusCode, res.body).toBeLessThan(400);
      expect(res.json().modelChoiceId).toBe('uk-gpt');
    });
  });

  it('records WHO changed it and when', async () => {
    await withPg(async t => {
      const admin = await aUser(t, 'admin');
      const h = harness(t, admin, 'admin');
      const before = await h.get();
      const res = await h.raw('PUT', { modelChoiceId: 'uk-gpt', version: before.version });
      const saved = res.json();
      expect(saved.updatedByUserId).toBe(admin);
      expect(saved.updatedAt).toBeGreaterThan(0);
      expect(saved.updatedAt).toBeGreaterThanOrEqual(before.updatedAt as number);
    });
  });

  it('refuses a model choice the gateway allowlist does not contain', async () => {
    await withPg(async t => {
      const admin = await aUser(t, 'admin');
      const h = harness(t, admin, 'admin');
      const before = await h.get();
      const res = await h.raw('PUT', { modelChoiceId: 'not-on-the-list', version: before.version });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('model_not_allowed');
    });
  });

  it('refuses a stale write with 409 (P9)', async () => {
    await withPg(async t => {
      const admin = await aUser(t, 'admin');
      const h = harness(t, admin, 'admin');
      const before = await h.get();
      const first = await h.raw('PUT', { modelChoiceId: 'uk-gpt', version: before.version });
      expect(first.statusCode).toBeLessThan(400);
      // Same (now stale) version again.
      const stale = await h.raw('PUT', { modelChoiceId: 'us-claude', version: before.version });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('conflict');
      // Nothing was saved: the current row still names the FIRST write's
      // model, not the stale one's.
      const after = await h.get();
      expect(after.modelChoiceId).toBe('uk-gpt');
    });
  });

  it('omitting concurrency on a PUT PRESERVES it, rather than resetting to the table default', async () => {
    // The easiest field in this route to get silently wrong: an admin
    // changing only the model must not also revert a concurrency limit a
    // previous admin set, just because this request did not mention it.
    await withPg(async t => {
      const admin = await aUser(t, 'admin');
      const h = harness(t, admin, 'admin');
      const before = await h.get();
      const withConcurrency = await h.raw(
        'PUT', { modelChoiceId: 'uk-gpt', concurrency: 9, version: before.version });
      expect(withConcurrency.json().concurrency).toBe(9);

      const withoutConcurrency = await h.raw(
        'PUT', { modelChoiceId: 'us-claude', version: withConcurrency.json().version });
      expect(withoutConcurrency.statusCode, withoutConcurrency.body).toBeLessThan(400);
      expect(withoutConcurrency.json().concurrency).toBe(9);
    });
  });

  it('two workspaces do not see or affect each other\'s settings', async () => {
    // The app role holds only SELECT on `workspace` (001_identity.sql,
    // confirmed directly against this database: an app-role INSERT into
    // `workspace` fails with exactly this test's own "permission denied"
    // before this fix). The foreign workspace has to be created on the
    // MIGRATOR connection — which is NOT the transaction `withPg` rolls
    // back, so it is deleted again in `finally`, on the same connection,
    // rather than left behind for the next run to collide with.
    const otherWs = '00000000-0000-0000-0000-0000000000ff';
    await migratorDb().query('insert into workspace (id, name) values ($1, $2) on conflict (id) do nothing',
      [otherWs, 'Other Workspace']);
    try {
      await withPg(async t => {
        const admin1 = await aUser(t, 'admin');
        await harness(t, admin1, 'admin').get(); // creates WS's row

        const admin2 = await aUser(t, 'admin', otherWs);
        const { app: app2 } = buildTestApi({
          principal: PRINCIPAL, db: dbOn(t),
          actor: { id: admin2, displayName: 'A2', initials: 'A2', role: 'admin', workspaceId: otherWs },
          modelsResponse: ALLOWLIST,
        });
        const res = await app2.inject({
          method: 'PUT', url: '/v1/workspace/settings',
          headers: { authorization: 'Bearer t' },
          payload: { modelChoiceId: 'us-claude', version: 1 },
        });
        expect(res.statusCode, res.body).toBeLessThan(400);

        const wsSettings = await harness(t, admin1, 'admin').get();
        // WS's row is untouched by the other workspace's write.
        expect(wsSettings.modelChoiceId).toBe('');
      });
    } finally {
      await migratorDb().query('delete from workspace where id = $1', [otherWs]);
    }
  });
});
