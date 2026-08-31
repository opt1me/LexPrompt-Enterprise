import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditExport } from '@lexprompt/core';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';

/**
 * THE WORKSPACE AUDIT EXTRACT, against the real three tables.
 *
 * Everything here is about what the FILE SAYS ABOUT ITSELF. The rows are the
 * easy part; the claim worth testing is that the manifest names every source
 * including the empty ones, states when it was taken as distinct from the
 * end of its range, counts exactly what it delivered, and that an extract
 * too large to carry is REFUSED rather than quietly cut short.
 *
 * ## This suite COMMITS, in its OWN workspace
 *
 * The route reads three tables the running stack is also writing, so an
 * assertion about counts has to be scoped to rows this file planted. Its own
 * workspace does that; `identity.pg.test.ts` asserts §6 seeds exactly one,
 * so the workspace row is swept after every test — the same discipline
 * `roleMappingLockout.pg.test.ts` records the reason for.
 */

const WS = '00000000-0000-0000-0000-00000000ae01';
const ADMIN = '00000000-0000-0000-0000-0000000000f1';
const OTHER_WS = '00000000-0000-0000-0000-00000000ae02';
const MATTER = 'audit-export-m1';
const REVIEW = 'audit-export-r1';

/**
 * A window in the RECENT PAST, not a fixed calendar date.
 *
 * `audit_event` is RANGE-PARTITIONED on `at` (migration 014) and only the
 * partitions around today exist — planting a row dated 2024 fails with *"no
 * partition of relation audit_event found for row"*, which is the schema
 * working correctly and a fixture that had not read it. The window ends
 * BEFORE now so `takenAt > to` is a real assertion rather than an accident
 * of ordering, and every row this file plants is inside a partition that
 * exists.
 */
const NOW = Date.now();
const TO = NOW - 60 * 60 * 1000;
const FROM = TO - 60 * 60 * 1000;
const INSIDE = new Date(FROM + 30 * 60 * 1000);
const BEFORE = new Date(FROM - 30 * 60 * 1000);
const AFTER = new Date(TO + 5 * 60 * 1000);

const seed = migratorDb();

function adminApi(maxRows?: number): FastifyInstance {
  const { app } = buildTestApi({
    principal: { issuer: 'i', subject: 's-admin-export', groups: ['admins'] },
    db: appDb(),
    actor: {
      id: ADMIN, displayName: 'An Admin', initials: 'AA', role: 'admin', workspaceId: WS,
    },
    ...(maxRows === undefined ? {} : { auditExportMaxRows: maxRows }),
  });
  return app;
}

async function plantWorkspace(id: string, name: string): Promise<void> {
  await seed.query(
    'insert into workspace (id, name) values ($1, $2) on conflict (id) do nothing', [id, name]);
}

async function plant(): Promise<void> {
  await plantWorkspace(WS, 'Audit export');
  await plantWorkspace(OTHER_WS, 'Somebody else');
  await seed.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 's-admin-export', 'An Admin', 'AA', 'admin', 'active')
     on conflict (id) do nothing`, [ADMIN, WS]);
  await seed.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Ashcroft', now(), now()) on conflict (id) do nothing`, [MATTER, WS]);
  await seed.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, '{"name":"Lease review"}'::jsonb,
             '{"kind":"documents","documentIds":["d1"]}'::jsonb, '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [REVIEW, WS, MATTER]);
  await seed.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ($1, 'd1', 'c1', $2, 'done') on conflict do nothing`, [REVIEW, WS]);
}

/** One audited act, at an explicit instant. */
async function anAudit(at: Date, action = 'matter.created'): Promise<void> {
  await seed.query(
    `insert into audit_event
       (workspace_id, actor_user_id, action, subject_type, subject_id, matter_id, at, detail)
     values ($1, $2, $3, 'matter', $4, $4, $5, '{}'::jsonb)`,
    [WS, ADMIN, action, MATTER, at]);
}

/** One disposition change, at an explicit instant. */
async function aDisposition(at: Date, to = 'verified'): Promise<void> {
  await seed.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, by_user_id, at,
        cause)
     values ($1, 'd1', 'c1', $2, 'unchecked', $3, $4, $5, 'human')`,
    [REVIEW, WS, to, ADMIN, at]);
}

async function uproot(): Promise<void> {
  await seed.query('delete from audit_event where workspace_id = any($1::uuid[])',
    [[WS, OTHER_WS]]);
  await seed.query('delete from review where workspace_id = any($1::uuid[])', [[WS, OTHER_WS]]);
  await seed.query('delete from matter where workspace_id = any($1::uuid[])', [[WS, OTHER_WS]]);
  await seed.query('delete from app_user where workspace_id = any($1::uuid[])', [[WS, OTHER_WS]]);
  await seed.query('delete from workspace where id = any($1::uuid[])', [[WS, OTHER_WS]]);
}

beforeAll(uproot);
afterAll(uproot);

async function exportRange(
  app: FastifyInstance, from = FROM, to = TO,
): Promise<{ status: number; body: AuditExport }> {
  const res = await app.inject({
    method: 'GET', url: `/v1/admin/audit-export?from=${from}&to=${to}`,
    headers: { authorization: 'Bearer t' },
  });
  return { status: res.statusCode, body: res.json() as AuditExport };
}

describe('the workspace audit extract', () => {
  it('lists every source, including one with no rows in the range', async () => {
    await uproot();
    await plant();
    await anAudit(INSIDE);
    await aDisposition(INSIDE);
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      expect(body.manifest.sources.map(s => s.source).sort())
        .toEqual(['audit_event', 'finding_disposition_event', 'run']);
      // ZERO IS LISTED. An omitted source reads as a source that was not
      // covered, which is the blank-CSV-cell defect on an evidence file.
      expect(body.manifest.sources.find(s => s.source === 'run')!.rows).toBe(0);
      expect(body.manifest.complete).toBe(true);
    } finally { await app.close(); await uproot(); }
  });

  it('states when it was taken, distinctly from the end of its range', async () => {
    await plant();
    await anAudit(INSIDE);
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      expect(body.manifest.takenAt).toBeGreaterThan(body.manifest.to);
      expect(body.manifest.from).toBe(FROM);
      expect(body.manifest.to).toBe(TO);
      expect(body.manifest.timeZone.length).toBeGreaterThan(0);
      expect(body.manifest.takenByUserId).toBe(ADMIN);
      expect(body.manifest.workspaceId).toBe(WS);
    } finally { await app.close(); await uproot(); }
  });

  it('counts EXACTLY what it delivers', async () => {
    await plant();
    await anAudit(INSIDE);
    await anAudit(INSIDE, 'review.created');
    await aDisposition(INSIDE);
    // ROWS OUTSIDE THE RANGE, deliberately, in two of the three sources.
    //
    // Without them this case cannot tell "counted what it delivered" from
    // "counted everything": a manifest count taken by a second query that
    // dropped one of the range predicates would agree with the rows it
    // shipped, and the assertion below would pass against exactly the
    // implementation it exists to catch.
    await anAudit(BEFORE);
    await anAudit(AFTER);
    await aDisposition(AFTER, 'flagged');
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      for (const s of body.manifest.sources) {
        // The mutation this kills: a manifest count from a `count(*)` and
        // rows from a second, differently-scoped query. Two statements, one
        // claim.
        expect(body.rows.filter(r => r.source === s.source), s.source).toHaveLength(s.rows);
      }
      expect(body.rows).toHaveLength(3);
      expect(body.manifest.sources).toEqual([
        { source: 'audit_event', rows: 2 },
        { source: 'finding_disposition_event', rows: 1 },
        { source: 'run', rows: 0 },
      ]);
    } finally { await app.close(); await uproot(); }
  });

  it('is INCLUSIVE of `from` and EXCLUSIVE of `to`, so two adjacent extracts agree', async () => {
    await plant();
    await anAudit(new Date(FROM));         // exactly the start — included
    await anAudit(new Date(TO));           // exactly the end — excluded
    await anAudit(BEFORE);
    await anAudit(AFTER);
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      expect(body.rows.map(r => r.at)).toEqual([FROM]);
      // …and the adjacent window picks up the boundary row exactly once.
      const next = await exportRange(app, TO, TO + 30 * 60 * 1000);
      expect(next.body.rows.map(r => r.at)).toEqual([TO, AFTER.getTime()]);
    } finally { await app.close(); await uproot(); }
  });

  it('REFUSES rather than truncating when a source would exceed the ceiling (P57)', async () => {
    await plant();
    for (let i = 0; i < 4; i++) await anAudit(new Date(INSIDE.getTime() + i));
    const app = adminApi(3);
    try {
      const res = await app.inject({
        method: 'GET', url: `/v1/admin/audit-export?from=${FROM}&to=${TO}`,
        headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode).toBe(413);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('export_too_large');
      // NAMES THE SOURCE, so an administrator knows which one to narrow.
      expect(body.error.message).toMatch(/audit_event/);
      expect(body.error.message).toMatch(/narrow the range/i);
      // No rows at all — a partial extract is not delivered under any name.
      expect('rows' in (body as unknown as object)).toBe(false);
    } finally { await app.close(); await uproot(); }
  });

  it('DELIVERS exactly at the ceiling, which makes the refusal about the extra row', async () => {
    // Without this, a route that refused whenever the ceiling was set would
    // pass the case above.
    await plant();
    for (let i = 0; i < 3; i++) await anAudit(new Date(INSIDE.getTime() + i));
    const app = adminApi(3);
    try {
      const { status, body } = await exportRange(app);
      expect(status).toBe(200);
      expect(body.rows).toHaveLength(3);
      expect(body.manifest.complete).toBe(true);
    } finally { await app.close(); await uproot(); }
  });

  it('refuses an unbounded range rather than defaulting to everything', async () => {
    await plant();
    const app = adminApi();
    try {
      for (const url of [
        '/v1/admin/audit-export',
        `/v1/admin/audit-export?from=${FROM}`,
        `/v1/admin/audit-export?to=${TO}`,
        `/v1/admin/audit-export?from=${TO}&to=${FROM}`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer t' } });
        expect(res.statusCode, url).toBe(400);
        expect(res.body, url).not.toContain('"rows"');
      }
    } finally { await app.close(); await uproot(); }
  });

  it('carries no disposition act from audit_event (S22), and each record exactly once', async () => {
    await plant();
    await aDisposition(INSIDE, 'verified');
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      // The same act appears in `finding_disposition_event` and NOT in
      // `audit_event` — an auditor reconciling two logs must not find a
      // discrepancy that is really a duplicate.
      expect(body.rows.filter(r => r.source === 'finding_disposition_event')).toHaveLength(1);
      expect(body.rows.filter(r => r.source === 'audit_event')).toHaveLength(0);
      const one = body.rows[0];
      expect(one.kind).toBe('verified');
      expect(one.cause).toBe('human');
      expect(one.byUserId).toBe(ADMIN);
      // It names WHICH matter and WHICH review, because a row that named
      // only ids is a row a reader months later cannot place.
      expect(one.matterName).toBe('Ashcroft');
      expect(one.reviewName).toBe('Lease review');
    } finally { await app.close(); await uproot(); }
  });

  it('scopes to the workspace in every arm', async () => {
    await plant();
    await anAudit(INSIDE);
    // A second workspace's audited act, at the same instant, in range.
    await seed.query(
      `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role,
                             status)
       values ($1, $2, 'i', 's-other', 'Other', 'OO', 'admin', 'active')
       on conflict (id) do nothing`,
      ['00000000-0000-0000-0000-0000000000f2', OTHER_WS]);
    await seed.query(
      `insert into audit_event
         (workspace_id, actor_user_id, action, subject_type, subject_id, at, detail)
       values ($1, $2, 'matter.created', 'matter', 'other-m', $3, '{}'::jsonb)`,
      [OTHER_WS, '00000000-0000-0000-0000-0000000000f2', INSIDE]);
    const app = adminApi();
    try {
      const { body } = await exportRange(app);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].byUserId).toBe(ADMIN);
      expect(body.manifest.sources.find(s => s.source === 'audit_event')!.rows).toBe(1);
    } finally { await app.close(); await uproot(); }
  });
});
