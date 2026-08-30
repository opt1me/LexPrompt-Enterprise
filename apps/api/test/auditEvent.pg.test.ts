import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, withPg, workerDb } from './helpers/pgHarness.ts';
import { appendAudit } from '../src/audit/write.ts';
import { AUDIT_ACTIONS } from '../src/audit/actions.ts';
import { ensureAuditPartitions } from '../src/audit/partitions.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * `audit_event` IS APPEND-ONLY BY GRANT, NOT BY CONVENTION (§6.5, S11).
 *
 * §6.5: *"a mistaken audit row cannot be corrected, only annotated by a
 * later row — which is what append-only means and why it is evidence."*
 *
 * Stage 3 proved this pattern works and also proved how it fails: the
 * obvious behavioural test stayed green with and without the grant, and
 * R-S3B1's `revoke update (column)` was a silent no-op because Postgres
 * keeps column privileges in `attacl` and table privileges in `relacl`. So
 * this suite attempts every verb as the role a request actually runs as AND
 * asks the catalogue, and does both for the partitions as well as for the
 * parent.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const ACTOR = '00000000-0000-0000-0000-0000000000d1';

async function anActor(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 's-audit', 'A Auditor', 'AA', 'reviewer', 'active')
     on conflict (id) do nothing`, [ACTOR, WS]);
}


/**
 * Runs a statement expected to be refused, INSIDE ITS OWN SAVEPOINT.
 *
 * A failed statement aborts a Postgres transaction: every statement after it
 * answers "current transaction is aborted" until a rollback, so a test that
 * attempts three refusals in one transaction proves the first one and then
 * asserts against a generic abort message twice. `Tx.tx` opens a SAVEPOINT
 * and rolls back to it on failure (`pool.ts`), which is exactly what lets a
 * suite attempt several refusals in one rolled-back transaction and have
 * each of them mean something.
 */
async function refusal(t: Tx, sql: string, params?: unknown[]): Promise<Error & { code?: string }> {
  try {
    await t.tx(async s => { await s.query(sql, params); });
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error(`This statement was ACCEPTED and should not have been: ${sql}`);
}

const INSERT = `insert into audit_event
    (workspace_id, actor_user_id, action, subject_type, subject_id, detail)
  values ($1, $2, 'matter.created', 'matter', 'm-1', '{}'::jsonb)`;

describe('audit_event is insert-only by grant', () => {
  it('lets the app role INSERT and SELECT', async () => {
    // The positive half, first. Without it the two refusals below would pass
    // just as well against a role with no grants at all, or against a table
    // that does not exist — which is the shape three green tests proving
    // nothing takes.
    await withPg(async t => {
      await anActor(t);
      await t.query(INSERT, [WS, ACTOR]);
      const rows = await t.query<{ n: string }>(
        "select count(*)::text n from audit_event where subject_id = 'm-1'");
      expect(rows[0].n).toBe('1');
    }, appDb());
  });

  it('refuses the app role an UPDATE, a DELETE and a TRUNCATE', async () => {
    for (const statement of [
      "update audit_event set action = 'matter.deleted'",
      'delete from audit_event',
      'truncate audit_event',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await withPg(async t => {
        await expect(t.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }, appDb());
    }
  });

  it('refuses those verbs on a PARTITION named directly, not only on the parent', async () => {
    // A grant on a partitioned parent covers a statement routed THROUGH the
    // parent and does not reach a partition named by hand — verified
    // directly against this database. So a `delete from audit_event_2026_08`
    // is its own question, and it is asked here rather than assumed from the
    // parent's answer.
    await withPg(async t => {
      const parts = await partitions(t);
      expect(parts.length, 'no partitions exist to check').toBeGreaterThan(0);
      for (const part of parts.slice(0, 3)) {
        // eslint-disable-next-line no-await-in-loop
        expect(await refusal(t, `delete from ${part}`), part)
          .toMatchObject({ code: '42501' });
      }
    }, appDb());
  });

  it('has not been handed those grants by anything outside the migrations', async () => {
    // THE CATALOGUE READ, not the behaviour. This is the one that notices a
    // grant made to a role the app role inherits from, or one made by hand
    // against the live database — the check that caught Stage 3's missing
    // `finding_disposition` coverage.
    const db = migratorDb();
    const rows = await db.query<{ relname: string; grantee: string; privilege: string }>(
      `select c.relname, pg_get_userbyid(a.grantee) as grantee, a.privilege_type as privilege
         from pg_class c, aclexplode(c.relacl) a
        where c.relname = 'audit_event' or c.relname like 'audit_event\\_%'`);
    expect(rows.length, 'the catalogue read found nothing at all').toBeGreaterThan(0);
    const app = rows.filter(r => r.grantee === 'lexprompt_app');
    expect(app.length, 'the app role holds no grant on audit_event at all').toBeGreaterThan(0);
    expect(app.filter(r => /UPDATE|DELETE|TRUNCATE/.test(r.privilege))).toEqual([]);
    // The positive half of the catalogue read: it CAN see a privilege, so an
    // empty list above is a fact about the grants and not about the query.
    expect(new Set(app.map(r => r.privilege))).toEqual(new Set(['INSERT', 'SELECT']));
    // And the worker holds nothing, on the parent or on any partition.
    expect(rows.filter(r => r.grantee === 'lexprompt_worker')).toEqual([]);
  });

  it('refuses the run worker everything, including SELECT', async () => {
    // §6.5's reasoning, and 006's: the worker performs no act that belongs
    // in an audit log, and a grant it does not need is a grant nobody will
    // notice becoming load-bearing.
    await withPg(async t => {
      expect(await refusal(t, 'select 1 from audit_event limit 1'))
        .toMatchObject({ code: '42501' });
      expect(await refusal(t, INSERT, [WS, ACTOR])).toMatchObject({ code: '42501' });
    }, workerDb());
  });

  it('…and the migrator CAN update it, which is what makes the refusals about the ROLE', async () => {
    // Without this, a table that did not exist would produce failures of
    // roughly the right shape and every case above would prove nothing.
    await withPg(async t => {
      await anActor(t);
      await t.query(INSERT, [WS, ACTOR]);
      await expect(t.query("update audit_event set subject_id = 'm-2' where subject_id = 'm-1'"))
        .resolves.toBeDefined();
    }, migratorDb());
  });
});

describe('audit_event fails loudly rather than quietly', () => {
  it('refuses a write with no partition covering its instant', async () => {
    // An audit log that silently discards rows is worse than no audit log,
    // because it looks like one. Postgres refuses the row by name, which is
    // a page rather than a silence — and is why retention is a DETACH.
    await withPg(async t => {
      await anActor(t);
      expect((await refusal(t,
        `insert into audit_event
           (workspace_id, actor_user_id, at, action, subject_type, subject_id)
         values ($1, $2, '2999-01-01T00:00:00Z', 'matter.created', 'matter', 'm-far')`,
        [WS, ACTOR])).message).toMatch(/no partition of relation/i);
    }, appDb());
  });

  /*
   * …AND THE HORIZON IS ROLLED FORWARD, so "loudly" never has to happen (M2).
   *
   * `012_audit_event.sql` created twelve partitions ONCE and said the routine
   * keeping the horizon rolling was "a deployment concern named in the
   * README". It was not named in the README and no such routine existed —
   * so twelve months after a deployment's first migration, the refusal above
   * stops being a safety property and becomes an outage: `appendAudit` runs
   * in the CALLER'S transaction, so the failure rolls back the matter, the
   * document, the run or the assignment that produced it. Verified live
   * against the running stack, where the last partition ended 2027-08-01.
   */
  it('creates every missing monthly partition out to the horizon, and is idempotent', async () => {
    await withPg(async t => {
      const before = (await partitions(t)).length;
      const made = await ensureAuditPartitions(t, 30);
      expect(before + made).toBe((await partitions(t)).length);
      // Idempotent: the second call creates nothing, so a startup on every
      // replica of every deploy is free.
      expect(await ensureAuditPartitions(t, 30)).toBe(0);
    }, migratorDb());
  });

  it('makes a write beyond the ORIGINAL twelve months land instead of rolling an act back', async () => {
    // Two halves, and the first is what makes the second mean anything: the
    // instant is genuinely outside what the migration created once.
    await withPg(async t => {
      await anActor(t);
      const far = new Date();
      far.setUTCMonth(far.getUTCMonth() + 20);
      const insert = `insert into audit_event
           (workspace_id, actor_user_id, at, action, subject_type, subject_id)
         values ($1, $2, $3, 'matter.created', 'matter', 'm-horizon')`;
      expect((await refusal(t, insert, [WS, ACTOR, far])).message)
        .toMatch(/no partition of relation/i);
      await ensureAuditPartitions(t, 30);
      await expect(t.query(insert, [WS, ACTOR, far])).resolves.toBeDefined();
    }, migratorDb());
  });

  it('refuses a horizon of nothing rather than silently making no partitions', async () => {
    // A caller that passed 0 would get a green "did nothing" and a database
    // that stops accepting audit rows next month.
    await withPg(async t => {
      await expect(t.tx(async s => {
        await ensureAuditPartitions(s, 0);
      })).rejects.toThrow(/at least one month/i);
    }, migratorDb());
  });

  it('refuses a detail that is not an object', async () => {
    await withPg(async t => {
      await anActor(t);
      for (const bad of ['"a string"', '[1,2]', 'null', '3']) {
        // eslint-disable-next-line no-await-in-loop
        expect((await refusal(t,
          `insert into audit_event
             (workspace_id, actor_user_id, action, subject_type, subject_id, detail)
           values ($1, $2, 'matter.created', 'matter', 'm-1', $3::jsonb)`,
          [WS, ACTOR, bad])).message, bad).toMatch(/violates check constraint/i);
      }
    }, appDb());
  });

  it('refuses a blank action or subject', async () => {
    await withPg(async t => {
      await anActor(t);
      expect((await refusal(t,
        `insert into audit_event (workspace_id, actor_user_id, action, subject_type, subject_id)
         values ($1, $2, '  ', 'matter', 'm-1')`, [WS, ACTOR])).message)
        .toMatch(/audit_action_not_blank/);
      expect((await refusal(t,
        `insert into audit_event (workspace_id, actor_user_id, action, subject_type, subject_id)
         values ($1, $2, 'matter.created', 'matter', '')`, [WS, ACTOR])).message)
        .toMatch(/audit_subject_not_blank/);
    }, appDb());
  });
});

describe('appendAudit, the one writer', () => {
  it('writes exactly what it was given, inside the caller s transaction', async () => {
    await withPg(async t => {
      await anActor(t);
      await appendAudit(t, {
        workspaceId: WS,
        actorUserId: ACTOR,
        action: 'playbook.published',
        subjectType: 'playbook_version',
        subjectId: 'v-9',
        matterId: 'm-7',
        detail: { versionNumber: 3 },
      });
      const rows = await t.query<{
        action: string; subject_id: string; matter_id: string | null;
        review_id: string | null; detail: unknown;
      }>("select action, subject_id, matter_id, review_id, detail from audit_event where subject_id = 'v-9'");
      expect(rows[0]).toMatchObject({
        action: 'playbook.published', subject_id: 'v-9', matter_id: 'm-7', review_id: null,
      });
      expect(rows[0].detail).toEqual({ versionNumber: 3 });
    }, appDb());
  });

  it('leaves NOTHING behind when the act it records rolls back', async () => {
    /*
     * The reason the signature takes a `Tx` and not a `Db`. An audit row
     * committed while the act it records rolled back is a log that says
     * something happened which did not — the confidently-wrong failure this
     * project is organised around, arriving in the one place a firm would
     * treat as evidence.
     *
     * `withPg` always rolls back, so the assertion is made from OUTSIDE it,
     * on a separate connection, after the rollback has happened.
     */
    await withPg(async t => {
      await anActor(t);
      await appendAudit(t, {
        workspaceId: WS, actorUserId: ACTOR, action: 'matter.deleted',
        subjectType: 'matter', subjectId: 'm-rolled-back',
      });
      const inside = await t.query<{ n: string }>(
        "select count(*)::text n from audit_event where subject_id = 'm-rolled-back'");
      expect(inside[0].n, 'the write did not happen at all').toBe('1');
    }, appDb());

    const after = await migratorDb().query<{ n: string }>(
      "select count(*)::text n from audit_event where subject_id = 'm-rolled-back'");
    expect(after[0].n).toBe('0');
  });

  it('names a closed set of actions, and no disposition among them (S22)', () => {
    // Two append-only records of one fact is this project's most repeated
    // defect, placed where a divergence would be least likely to be noticed:
    // between what a lawyer reads on the card and what the firm exports as
    // evidence.
    expect(AUDIT_ACTIONS.some(a => /finding|disposition|verif|reject|flag/i.test(a))).toBe(false);
    // The sanity check: the list is not empty and does hold what it should.
    expect(AUDIT_ACTIONS).toContain('playbook.published');
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(10);
  });
});

async function partitions(t: Tx): Promise<string[]> {
  const rows = await t.query<{ part: string }>(
    `select inhrelid::regclass::text as part from pg_inherits
      where inhparent = 'audit_event'::regclass order by part`);
  return rows.map(r => r.part);
}
