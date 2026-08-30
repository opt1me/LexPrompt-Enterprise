import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES, RUN_EVENT_TYPES, isEventType, type EventPage,
} from '@lexprompt/core';
import { appendEvent, pruneEvents, readEvents } from '../src/run/events.ts';
import { appDb, dbOn, migratorDb, withPg } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Db, Tx } from '../src/db/pool.ts';

/**
 * Task 12: the outbox, its retention, and the cursor Stage 4 inherits.
 *
 * Two claims that nothing else in this system can make:
 *
 *  1. `appendEvent` writes in the CALLER'S transaction. An event committed
 *     while the row it describes rolled back is a client told about a finding
 *     that does not exist — and, unlike every defect on `CLAUDE.md`'s list,
 *     the client has no way to find out.
 *  2. A cursor past retention gets `{ resyncRequired: true }`, never a
 *     silently short page. A client that asked for everything after 400 and
 *     received everything after 900 has a hole it cannot see.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt', subject: 'sub-events', groups: ['reviewers'],
};

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

async function aRun(t: Tx, id: string, reviewId = 'ev-r1'): Promise<string> {
  const userId = await aUser(t);
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('ev-m1', $1, 'M', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, 'ev-m1', '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb,
             '{}'::jsonb, 'm', now())
     on conflict (id) do nothing`, [reviewId, WS]);
  await t.query(
    `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
     values ($1, $2, $3, 'running', $4, 5)`, [id, reviewId, WS, userId]);
  return userId;
}

describe('the five payload types are the shared vocabulary', () => {
  it('names exactly the five §9 lists, in core rather than in apps/api', () => {
    // Declared in `packages/core` because both sides read them and Stage 4's
    // socket will send exactly these — one payload vocabulary, two
    // transports (P22). A sixth type arriving in `apps/api` alone would be
    // an event every client silently drops.
    expect([...RUN_EVENT_TYPES]).toEqual([
      'run.started', 'finding.running', 'finding.done', 'finding.error', 'run.finished',
    ]);
  });

  it('refuses to hand a client an event type nothing reads', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-run-x');
      await t.query(
        `insert into event (workspace_id, review_id, run_id, type, payload)
         values ($1, 'ev-r1', 'ev-run-x', 'finding.invented', '{}'::jsonb)`, [WS]);
      await expect(readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-run-x' }, after: 0, limit: 10,
      })).rejects.toThrow(/not one of the nine/);
    });
  });
});

describe('appendEvent writes in the caller s transaction and nowhere else', () => {
  it('leaves no event behind when the transaction that wrote it rolls back', async () => {
    // The one property a same-transaction outbox has that a separate write
    // does not. Proved across SESSIONS: the rollback happens on one
    // connection and the count is read on another, so a transaction-local
    // read cannot make this pass by accident.
    const migrator = migratorDb();
    const app: Db = appDb();
    const runId = `ev-rollback-${Date.now()}`;
    await migrator.query(
      `insert into matter (id, workspace_id, name, created_at, updated_at)
       values ('ev-m2', $1, 'M', now(), now()) on conflict (id) do nothing`, [WS]);
    await migrator.query(
      `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                           model_id, started_at)
       values ('ev-r2', $1, 'ev-m2', '{}'::jsonb,
               '{"kind":"documents","documentIds":[]}'::jsonb, '{}'::jsonb, 'm', now())
       on conflict (id) do nothing`, [WS]);
    const users = await migrator.query<{ id: string }>(
      `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
       values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
       returning id`, [WS]);
    await migrator.query(
      `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
       values ($1, 'ev-r2', $2, 'running', $3, 5)`, [runId, WS, users[0].id]);

    try {
      await expect(app.tx(async t => {
        await appendEvent(t, {
          workspaceId: WS, type: 'finding.done', reviewId: 'ev-r2', runId,
          payload: { runId, reviewId: 'ev-r2', findingsKey: 'd1', clauseId: 'c1', version: 2 },
        });
        // The worker's write fails AFTER the event was appended — a
        // constraint violation, a lost connection, a bug.
        throw new Error('the write this event describes failed');
      })).rejects.toThrow('the write this event describes failed');

      const survived = await app.query<{ id: string }>(
        'select id from event where run_id = $1', [runId]);
      expect(survived).toEqual([]);

      // …and the same append, committed, DOES survive. Without this the
      // assertion above would pass against an `appendEvent` that writes
      // nothing at all.
      await app.tx(async t => {
        await appendEvent(t, {
          workspaceId: WS, type: 'finding.done', reviewId: 'ev-r2', runId,
          payload: { runId, reviewId: 'ev-r2', findingsKey: 'd1', clauseId: 'c1', version: 2 },
        });
      });
      expect(await app.query('select id from event where run_id = $1', [runId])).toHaveLength(1);
    } finally {
      await migrator.query('delete from event where run_id = $1', [runId]);
      await migrator.query('delete from run where id = $1', [runId]);
      await migrator.query("delete from review where id = 'ev-r2'");
      await migrator.query("delete from matter where id = 'ev-m2'");
    }
  });
});

describe('the cursor', () => {
  async function seed(t: Tx, runId: string, n: number, reviewId = 'ev-r1'): Promise<number[]> {
    await aRun(t, runId, reviewId);
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      ids.push(await appendEvent(t, {
        workspaceId: WS, type: 'finding.done', reviewId: 'ev-r1', runId,
        payload: { runId, reviewId: 'ev-r1', findingsKey: 'd1', clauseId: `c${i}`, version: i },
      }));
    }
    return ids;
  }

  it('returns events in id order, with a cursor that resumes exactly where it stopped', async () => {
    await withPg(async t => {
      const ids = await seed(t, 'ev-cursor', 5);
      const first = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-cursor' }, after: 0, limit: 2,
      });
      expect(first.events.map(e => e.id)).toEqual(ids.slice(0, 2));
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe(ids[1]);
      expect('resyncRequired' in first).toBe(false);

      const second = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-cursor' }, after: first.nextCursor, limit: 10,
      });
      // No overlap and no gap. A page that repeated its last event would
      // make an at-least-once client apply it twice; one that skipped an
      // event would make a run's last finding invisible.
      expect(second.events.map(e => e.id)).toEqual(ids.slice(2));
      expect(second.hasMore).toBe(false);
    });
  });

  it('reports hasMore from a row it did not return, not from a full page', async () => {
    // `limit + 1`. A page that returned exactly `limit` rows and said
    // `hasMore: false` would stop a client one page short of `run.finished`.
    await withPg(async t => {
      await seed(t, 'ev-exact', 4);
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-exact' }, after: 0, limit: 4,
      });
      expect(page.events).toHaveLength(4);
      expect(page.hasMore).toBe(false);
      const short = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-exact' }, after: 0, limit: 3,
      });
      expect(short.hasMore).toBe(true);
    });
  });

  it('carries the version of the row each event describes', async () => {
    // §8's idempotence rule, which is what makes replay safe: a client
    // applies an event only when its version is newer than what it holds.
    await withPg(async t => {
      await seed(t, 'ev-version', 3);
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-version' }, after: 0, limit: 10,
      });
      expect(page.events.map(e => (e.payload as { version: number }).version)).toEqual([1, 2, 3]);
    });
  });

  it('scopes to the run AND the workspace', async () => {
    await withPg(async t => {
      // TWO REVIEWS, because 008's `run_one_live_per_review` refuses two live
      // runs over one review — which is the constraint this stage exists to
      // have, so the fixture bends and not the schema.
      await seed(t, 'ev-mine', 2, 'ev-r-mine');
      await seed(t, 'ev-theirs', 2, 'ev-r-theirs');
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-mine' }, after: 0, limit: 10,
      });
      expect(page.events.every(e => e.runId === 'ev-mine')).toBe(true);
      const other = await readEvents(dbOn(t), {
        workspaceId: '00000000-0000-0000-0000-0000000000ff', subscription: { run: 'ev-mine' },
        after: 0, limit: 10,
      });
      expect(other.events).toEqual([]);
    });
  });
});

describe('retention, and the honest answer past it', () => {
  it('answers resyncRequired for a cursor older than the oldest surviving event', async () => {
    // SILENTLY SHORT IS THE FAILURE. The alternative — returning the events
    // that do survive — hands the client a list it cannot tell from a
    // complete one.
    await withPg(async t => {
      await seed(t);
      const oldest = (await t.query<{ oldest: string }>(
        'select min(id)::text as oldest from event'))[0].oldest;
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-retain' }, after: Number(oldest) - 5, limit: 10,
      });
      expect(page.resyncRequired).toBe(true);
      expect(page.events).toEqual([]);
      /*
       * THIS ASSERTION CHANGED DIRECTION (Stage 3 final review, M2).
       *
       * It used to require the cursor to come back UNCHANGED, *"so a client
       * that ignores the flag does not silently advance past the gap"*. The
       * client does not ignore the flag — and with the cursor standing
       * still, and `oldest` only ever increasing, a watch that entered this
       * state re-entered it on every poll for ever: a poll a second,
       * `run.finished` never delivered, the banner saying the review is
       * still running for the life of the page, and `completedAt` never
       * written.
       *
       * The cursor moves to the WATERMARK — one below the oldest surviving
       * event — which is the same continuity test this branch is written
       * from: everything at or above `oldest` survives, so `oldest - 1` is
       * provably continuous with the whole of what is left. The gap is not
       * skipped silently; it is skipped with `resyncRequired` set in the
       * same page, which is what sends the client to re-read the state
       * those events described.
       */
      expect(page.nextCursor).toBe(Number(oldest) - 1);

      // …and the NEXT poll, from that cursor, is an ordinary page: it
      // delivers the surviving events and does not ask for a resync again.
      const next = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-retain' }, after: page.nextCursor, limit: 10,
      });
      expect('resyncRequired' in next).toBe(false);
      expect(next.events).toHaveLength(1);
      expect(next.nextCursor).toBeGreaterThan(page.nextCursor);
    });

    async function seed(t: Tx): Promise<void> {
      await aRun(t, 'ev-retain');
      await appendEvent(t, {
        workspaceId: WS, type: 'run.started', reviewId: 'ev-r1', runId: 'ev-retain',
        payload: { runId: 'ev-retain', reviewId: 'ev-r1', cells: 1, version: 1 },
      });
    }
  });

  it('does NOT ask a fresh client to resync — after=0 has nothing to miss', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-fresh');
      await appendEvent(t, {
        workspaceId: WS, type: 'run.started', reviewId: 'ev-r1', runId: 'ev-fresh',
        payload: { runId: 'ev-fresh', reviewId: 'ev-r1', cells: 1, version: 1 },
      });
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { run: 'ev-fresh' }, after: 0, limit: 10,
      });
      expect('resyncRequired' in page).toBe(false);
      expect(page.events).toHaveLength(1);
    });
  });

  it('prunes what is older than the retention window and reports how many', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-prune');
      // Inserted with an explicit `at` rather than UPDATEd afterwards: the
      // app role holds `select, insert, delete` on `event` and NO update, on
      // purpose — an outbox is appended to and pruned, never rewritten — so
      // the tidier fixture is one the grant correctly refuses.
      await t.query(
        `insert into event (workspace_id, review_id, run_id, type, payload, at)
         values ($1, 'ev-r1', 'ev-prune', 'finding.done', $2::jsonb, now() - interval '30 days')`,
        [WS, JSON.stringify({
          runId: 'ev-prune', reviewId: 'ev-r1', findingsKey: 'd1', clauseId: 'c0', version: 1,
        })]);
      const fresh = await appendEvent(t, {
        workspaceId: WS, type: 'run.finished', reviewId: 'ev-r1', runId: 'ev-prune',
        payload: {
          runId: 'ev-prune', reviewId: 'ev-r1', state: 'succeeded',
          cells: 1, done: 1, errored: 0, cancelled: 0, version: 2,
        },
      });

      const pruned = await pruneEvents(dbOn(t), 7);
      expect(pruned).toBeGreaterThanOrEqual(1);
      const left = await t.query<{ id: string }>(
        'select id from event where run_id = $1', ['ev-prune']);
      expect(left.map(r => Number(r.id))).toEqual([fresh]);
    });
  });
});

describe('the events route', () => {
  it('answers the page shape, bounded by the declared page size', async () => {
    await withPg(async t => {
      const userId = await aRun(t, 'ev-route');
      for (let i = 1; i <= 4; i++) {
        await appendEvent(t, {
          workspaceId: WS, type: 'finding.done', reviewId: 'ev-r1', runId: 'ev-route',
          payload: {
            runId: 'ev-route', reviewId: 'ev-r1', findingsKey: 'd1', clauseId: `c${i}`, version: i,
          },
        });
      }
      const { app } = buildTestApi({
        principal: PRINCIPAL,
        db: dbOn(t),
        eventPageMax: 2,
        actor: {
          id: userId, displayName: 'T', initials: 'T', role: 'reviewer', workspaceId: WS,
        },
      });
      // A caller asking for more than the declared page size gets the cap,
      // never an unbounded read.
      const res = await app.inject({
        method: 'GET', url: '/v1/runs/ev-route/events?after=0&limit=1000',
        headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as EventPage;
      expect(page.events).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    });
  });

  it('answers 404 for a run this workspace cannot see, not an empty page', async () => {
    // An empty page is indistinguishable from a run that has not started —
    // the empty-versus-broken confusion this codebase has a rule about.
    await withPg(async t => {
      const { app } = buildTestApi({
        principal: PRINCIPAL,
        db: dbOn(t),
        actor: {
          id: await aUser(t), displayName: 'T', initials: 'T',
          role: 'reviewer', workspaceId: WS,
        },
      });
      const res = await app.inject({
        method: 'GET', url: '/v1/runs/ev-nothing/events',
        headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

/**
 * n3: the route's own query has an index.
 *
 * `readEvents` filters `where workspace_id = $1 and run_id = $2 and id > $3`,
 * and `event` carried only `event_review_idx (workspace_id, review_id, id)`,
 * `event_at_idx (at)` and the primary key — so every poll of a live run
 * scanned the workspace's whole seven-day buffer. Stage 4's socket polls this
 * harder than the HTTP route does. Migration 009 adds `event_run_idx`.
 *
 * Asserted against the DATABASE rather than by reading the migration text: an
 * index is a property of the schema that is actually deployed, and a text
 * scan cannot see one that was never applied.
 */
describe('the events route has an index that matches its predicate', () => {
  it('has (workspace_id, run_id, id), in that order', async () => {
    await withPg(async t => {
      const rows = await t.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = 'event' and indexname = 'event_run_idx'");
      expect(rows, 'event_run_idx is missing; migration 009 has not been applied').toHaveLength(1);
      // Column ORDER matters: the two equalities first, the range last, so
      // `id > $3` scans the tail of a matching prefix rather than filtering
      // after one.
      expect(rows[0].indexdef).toMatch(/\(workspace_id,\s*run_id,\s*id\)/);
    });
  });
});

/**
 * STAGE 4 TASK 15: one outbox, nine types, three subscriptions.
 *
 * The five run types are unchanged and unrenamed; what is new is that a
 * change made by a PERSON goes into the same table, read through the same
 * cursor. That is P39's whole argument — the outbox is the delivery and the
 * socket is only a doorbell — and it is why there is no second table here.
 */
describe('the outbox carries what people decide, not only what the engine did', () => {
  it('names nine types, and the five Stage 3 shipped are the first five of them', () => {
    expect([...EVENT_TYPES]).toEqual([
      'run.started', 'finding.running', 'finding.done', 'finding.error', 'run.finished',
      'finding.disposition_changed', 'note.added', 'assignment.created', 'assignment.resolved',
    ]);
    // The five are still their own predicate: "is this about a run" is a
    // question the browser asks on every frame.
    expect([...RUN_EVENT_TYPES]).toEqual([...EVENT_TYPES].slice(0, 5));
    expect(isEventType('finding.disposition_changed')).toBe(true);
    expect(isEventType('finding.exploded')).toBe(false);
  });

  it('appends a disposition change with no run, and reads it back with no runId key', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-nrun', 'ev-sub-r');
      await appendEvent(t, {
        workspaceId: WS, type: 'finding.disposition_changed', reviewId: 'ev-sub-r',
        payload: {
          reviewId: 'ev-sub-r', findingsKey: 'd1', clauseId: 'c1', version: 2,
          disposition: {
            reviewId: 'ev-sub-r', findingsKey: 'd1', clauseId: 'c1', state: 'rejected',
            changedCount: 2, version: 2,
          },
          event: {
            id: 1, fromState: 'verified', toState: 'rejected', cause: 'human',
            byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
          },
        },
      });
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-sub-r' }, after: 0, limit: 10,
      });
      const e = page.events.find(x => x.type === 'finding.disposition_changed')!;
      expect(e, 'the disposition change was not read back').toBeDefined();
      // ABSENT, not `''` and not `undefined`. `toEqual` cannot tell an absent
      // key from an undefined one, and `structuredClone` — how a payload
      // crosses a worker boundary — preserves an undefined-valued key, so
      // `in` is the only assertion that means what this test is about.
      expect('runId' in e).toBe(false);
      // …and the sanity check that the `in` guard can find a key that IS
      // there, so the assertion above is about the shape rather than about
      // `in` never finding anything.
      expect('reviewId' in e).toBe(true);
      // Populated by `appendEvent`'s own subselect, with no `matterId:` at
      // this call site at all.
      expect(e.matterId).toBe('ev-m1');
      expect(e.workspaceId).toBe(WS);
    });
  });

  it('still refuses a type nobody registered, after the widening', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-closed', 'ev-closed-r');
      await t.query(
        `insert into event (workspace_id, review_id, type, payload)
         values ($1, 'ev-closed-r', 'finding.exploded', '{}'::jsonb)`, [WS]);
      await expect(readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-closed-r' }, after: 0, limit: 10,
      })).rejects.toThrow(/not one of the nine/);
      // The closed set SURVIVES the widening. An event nothing reads is a
      // hole a client cannot see, and the refusal is what makes it visible.
    });
  });

  it('serves a review subscription every event of that review, run events included', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-mixed', 'ev-mixed-r');
      await appendEvent(t, {
        workspaceId: WS, type: 'finding.done', reviewId: 'ev-mixed-r', runId: 'ev-mixed',
        payload: {
          runId: 'ev-mixed', reviewId: 'ev-mixed-r', findingsKey: 'd1', clauseId: 'c1',
          version: 1,
        },
      });
      await appendEvent(t, {
        workspaceId: WS, type: 'note.added', reviewId: 'ev-mixed-r',
        payload: {
          reviewId: 'ev-mixed-r', findingsKey: 'd1', clauseId: 'c1',
          note: {
            id: 'n1', findingId: 'd1::c1', text: 'Ask the partner.',
            byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
          },
        },
      });
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-mixed-r' }, after: 0, limit: 100,
      });
      const types = page.events.map(e => e.type);
      expect(types).toContain('finding.done');
      expect(types).toContain('note.added');
    });
  });

  it('serves a matter subscription every review in that matter, and no other', async () => {
    await withPg(async t => {
      // Two reviews under ONE matter, and a third review under another.
      await aRun(t, 'ev-mat-a', 'ev-mat-r1');
      await aRun(t, 'ev-mat-b', 'ev-mat-r2');
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at)
         values ('ev-m2', $1, 'Other', now(), now()) on conflict (id) do nothing`, [WS]);
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                             model_id, started_at)
         values ('ev-mat-r3', $1, 'ev-m2', '{}'::jsonb,
                 '{"kind":"documents","documentIds":[]}'::jsonb, '{}'::jsonb, 'm', now())
         on conflict (id) do nothing`, [WS]);

      for (const [reviewId, clauseId] of [
        ['ev-mat-r1', 'c1'], ['ev-mat-r2', 'c2'], ['ev-mat-r3', 'c3'],
      ]) {
        await appendEvent(t, {
          workspaceId: WS, type: 'note.added', reviewId,
          payload: {
            reviewId, findingsKey: 'd1', clauseId,
            note: {
              id: `n-${clauseId}`, findingId: `d1::${clauseId}`, text: 't',
              byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
            },
          },
        });
      }

      const mine = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { matter: 'ev-m1' }, after: 0, limit: 100,
      });
      const reviews = new Set(mine.events.map(e => e.reviewId));
      expect(reviews.has('ev-mat-r1')).toBe(true);
      expect(reviews.has('ev-mat-r2')).toBe(true);
      // The half that matters: the OTHER matter's review is not in it. A
      // subscription that answered with a neighbouring matter's changes
      // would be a screen showing another engagement's judgements.
      expect(reviews.has('ev-mat-r3')).toBe(false);

      // …and the other matter's subscription finds its own, so the exclusion
      // above is about the predicate rather than about the row not existing.
      const other = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { matter: 'ev-m2' }, after: 0, limit: 100,
      });
      expect(other.events.map(e => e.reviewId)).toContain('ev-mat-r3');
    });
  });

  it('refuses another workspace the events of this one, on every subscription shape', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-scope', 'ev-scope-r');
      await appendEvent(t, {
        workspaceId: WS, type: 'note.added', reviewId: 'ev-scope-r',
        payload: {
          reviewId: 'ev-scope-r', findingsKey: 'd1', clauseId: 'c1',
          note: {
            id: 'n-scope', findingId: 'd1::c1', text: 't',
            byUserId: '00000000-0000-0000-0000-0000000000aa', at: Date.now(),
          },
        },
      });
      const ELSEWHERE = '00000000-0000-0000-0000-0000000000ff';
      for (const subscription of [
        { review: 'ev-scope-r' }, { matter: 'ev-m1' }, { run: 'ev-scope' },
      ] as const) {
        const theirs = await readEvents(dbOn(t), {
          workspaceId: ELSEWHERE, subscription, after: 0, limit: 100,
        });
        expect(theirs.events, JSON.stringify(subscription)).toEqual([]);
      }
      // The sanity check: the same reads in the right workspace find
      // something, so the empty lists above are the predicate biting rather
      // than a review with nothing in it.
      const ours = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-scope-r' }, after: 0, limit: 100,
      });
      expect(ours.events.length).toBeGreaterThan(0);
    });
  });

  it('populates matter_id on every event a run writes', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-matid', 'ev-matid-r');
      for (const type of ['run.started', 'finding.running', 'finding.done'] as const) {
        await appendEvent(t, {
          workspaceId: WS, type, reviewId: 'ev-matid-r', runId: 'ev-matid',
          payload: type === 'run.started'
            ? { runId: 'ev-matid', reviewId: 'ev-matid-r', cells: 1, version: 1 }
            : {
              runId: 'ev-matid', reviewId: 'ev-matid-r', findingsKey: 'd1', clauseId: 'c1',
              version: 1,
            },
        });
      }
      const nulls = await t.query<{ type: string }>(
        "select type from event where run_id = 'ev-matid' and matter_id is null");
      expect(nulls).toEqual([]);
      // The sanity check for that empty list: the rows are there at all.
      const all = await t.query<{ n: string }>(
        "select count(*)::text as n from event where run_id = 'ev-matid'");
      expect(Number(all[0].n)).toBe(3);
    });
  });

  it('keeps resyncRequired measured against the whole table, not this subscription', async () => {
    await withPg(async t => {
      await aRun(t, 'ev-resync', 'ev-resync-r');
      await appendEvent(t, {
        workspaceId: WS, type: 'run.started', reviewId: 'ev-resync-r', runId: 'ev-resync',
        payload: { runId: 'ev-resync', reviewId: 'ev-resync-r', cells: 1, version: 1 },
      });
      const oldest = Number((await t.query<{ oldest: string | null }>(
        'select min(id)::text as oldest from event'))[0].oldest);
      // A cursor BELOW the table's watermark: the events between it and now
      // are gone whatever subscription is asking.
      const page = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-resync-r' },
        after: Math.max(1, oldest - 5), limit: 10,
      });
      expect(page.resyncRequired).toBe(true);
      // Comparing against THIS subscription's own oldest event would report
      // a resync to every client that connected before its first event —
      // which is every client. A cursor AT the table's watermark is provably
      // continuous with everything that survives, whatever this particular
      // review's own first id happens to be.
      const atWatermark = await readEvents(dbOn(t), {
        workspaceId: WS, subscription: { review: 'ev-resync-r' },
        after: oldest, limit: 10,
      });
      expect('resyncRequired' in atWatermark).toBe(false);
    });
  });
});
