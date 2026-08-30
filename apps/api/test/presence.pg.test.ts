import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ServerFrame } from '@lexprompt/core';
import { ROOT, codeOf, walk } from './sourceScan.ts';
import { appDb, dbOn, withPg } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import {
  createPresenceRegistry, decodePresence, encodePresence,
  type PresenceRegistry, type PresenceScope,
} from '../src/realtime/presence.ts';

/**
 * PRESENCE: EPHEMERAL BY CONSTRUCTION, ADVISORY BY RULE (§8, S6, Task 22).
 *
 * Three claims, and each is a different kind of test:
 *
 *  1. **It expires.** A roster entry outliving its TTL is the one lie this
 *     feature can tell — *"a stale presence indicator that claims someone is
 *     there is worse than no indicator"*, because a reviewer might defer to a
 *     colleague who left ten minutes ago. Driven through the shipped
 *     registry with an injected TTL, because the mutation this suite turns on
 *     is raising that TTL to `Infinity`.
 *  2. **It is written nowhere.** Asserted over the module's own source AND
 *     over the real database's catalogue, because a comment saying "never
 *     persisted" is exactly what a table called `presence` would sit under.
 *  3. **It gates no write.** The disposition route succeeds while somebody
 *     else is present on that clause. Somebody will eventually propose
 *     "warn before overwriting while another person is on this clause", and
 *     the day that warning becomes a REFUSAL is the day presence stops being
 *     advisory. This test is what makes that a deliberate change.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const HUMAN = '00000000-0000-0000-0000-0000000000a1';
const PRIYA = '00000000-0000-0000-0000-0000000000a2';
const SUB = { review: 'pr1' } as const;
const SCOPE: PresenceScope = { workspaceId: WS, sub: SUB };
const TTL = 15_000;
const T0 = 1_800_000_000_000;

interface Recorded {
  registry: PresenceRegistry;
  frames: { scope: PresenceScope; frame: ServerFrame }[];
  rosters(): unknown[];
}

/** The shipped registry, publishing into an array. `PresenceDeps.publish`
 *  exists exactly so this is possible with no socket in the process. */
function recording(ttlMs = TTL): Recorded {
  const frames: { scope: PresenceScope; frame: ServerFrame }[] = [];
  const registry = createPresenceRegistry({
    ttlMs,
    publish: (scope, frame) => { frames.push({ scope, frame }); },
  });
  return {
    registry,
    frames,
    rosters: () => frames.map(f => (f.frame as { members?: unknown }).members),
  };
}

const beatOf = (connectionId: string, userId: string, at: number, clauseId?: string) => ({
  connectionId, userId, screen: 'review' as const, at,
  ...(clauseId === undefined ? {} : { clauseId }),
});

describe('a roster entry does not outlive its TTL', () => {
  it('drops a member whose last beat is older than the TTL, and broadcasts the change', () => {
    const { registry, frames } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0, 'c14'));
    expect(registry.roster(SCOPE)).toEqual([{ userId: PRIYA, screen: 'review', clauseId: 'c14' }]);

    registry.sweep(T0 + TTL + 1);

    /*
     * THE MUTATION THIS TEST EXISTS FOR: build the registry with
     * `ttlMs: Infinity` and confirm this goes red. A roster that never
     * expires claims a colleague is present forever, and it looks completely
     * normal — every screen renders, every frame arrives, and the only thing
     * wrong is that the name on the clause belongs to somebody who closed
     * their laptop.
     */
    expect(registry.roster(SCOPE)).toEqual([]);
    expect(frames.at(-1)?.frame).toEqual({ t: 'presence', sub: SUB, members: [] });
    // …and the EMPTY frame is sent, not swallowed. It is the frame that
    // takes a face off a clause; "there is nobody to tell about nobody"
    // would leave the last thing every reader was told standing.
    expect(frames).toHaveLength(2);
  });

  it('keeps a member whose beat is exactly one TTL old, and drops them a tick later', () => {
    const { registry } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0));
    registry.sweep(T0 + TTL);
    expect(registry.roster(SCOPE)).toHaveLength(1);
    registry.sweep(T0 + TTL + 1);
    expect(registry.roster(SCOPE)).toEqual([]);
  });

  it('a beat arriving before the TTL keeps the person, and broadcasts nothing new', () => {
    const { registry, frames } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0));
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0 + 10_000));
    registry.sweep(T0 + 20_000);
    expect(registry.roster(SCOPE)).toHaveLength(1);
    // ONE frame, from the arrival. A broadcast per heartbeat would be a
    // frame every ten seconds per reader per subscription carrying no
    // information at all (§8: "broadcast on change").
    expect(frames).toHaveLength(1);
  });

  it('broadcasts when the clause changes, because that IS the information', () => {
    const { registry, rosters } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0, 'c1'));
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0 + 1_000, 'c14'));
    expect(rosters()).toEqual([
      [{ userId: PRIYA, screen: 'review', clauseId: 'c1' }],
      [{ userId: PRIYA, screen: 'review', clauseId: 'c14' }],
    ]);
  });

  it('is gone from the roster the moment a connection leaves, not one TTL later', () => {
    const { registry, frames } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0));
    registry.leave('conn-1');
    expect(registry.roster(SCOPE)).toEqual([]);
    expect(frames.at(-1)?.frame).toEqual({ t: 'presence', sub: SUB, members: [] });
  });

  it('counts a person with two tabs once, and does not drop them when one closes', () => {
    // Keyed by CONNECTION and deduplicated by person. Keyed by user, the
    // first tab's departure would remove somebody whose second tab is still
    // watching, and they would flicker back on their own next beat.
    const { registry } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0, 'c1'));
    registry.beat(SCOPE, beatOf('conn-2', PRIYA, T0 + 1, 'c14'));
    expect(registry.roster(SCOPE)).toEqual([{ userId: PRIYA, screen: 'review', clauseId: 'c14' }]);
    registry.leave('conn-2');
    expect(registry.roster(SCOPE)).toEqual([{ userId: PRIYA, screen: 'review', clauseId: 'c1' }]);
  });

  it('keeps two firms apart, because a review id is minted in a browser', () => {
    const { registry } = recording();
    const other: PresenceScope = { workspaceId: 'another-firm', sub: SUB };
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, T0));
    expect(registry.roster(other)).toEqual([]);
  });
});

describe('a beat crosses replicas and cannot carry rubbish', () => {
  it('round-trips a beat through the notification payload', () => {
    const n = {
      k: 'beat' as const, workspaceId: WS, sub: SUB, beat: beatOf('conn-1', PRIYA, T0, 'c14'),
    };
    expect(decodePresence(encodePresence(n))).toEqual(n);
  });

  it('refuses a payload it cannot read, rather than inventing a member', () => {
    for (const bad of [
      'not json',
      '{}',
      JSON.stringify({ k: 'shout', workspaceId: WS, sub: SUB, beat: beatOf('c', PRIYA, T0) }),
      JSON.stringify({ k: 'beat', sub: SUB, beat: beatOf('c', PRIYA, T0) }),
      JSON.stringify({ k: 'beat', workspaceId: WS, sub: SUB, beat: { userId: { a: 1 } } }),
      JSON.stringify({ k: 'beat', workspaceId: WS, sub: SUB }),
    ]) {
      expect(decodePresence(bad), bad).toBeUndefined();
    }
    // The sanity check: the same function DOES read a good one, so the
    // `toBeUndefined`s above are about the payloads rather than about a
    // decoder that returns nothing for everything.
    expect(decodePresence(encodePresence({
      k: 'leave', workspaceId: WS, sub: SUB, beat: beatOf('c', PRIYA, T0),
    }))).toBeDefined();
  });
});

describe('presence is written nowhere', () => {
  it('names no write in its own source', () => {
    const code = codeOf(path.join(ROOT, 'apps/api/src/realtime/presence.ts'));
    expect(code).not.toMatch(/insert into|update |blobStore|upload/i);
    // The sanity check, or an empty file — or a path typo — passes this.
    expect(code).toMatch(/roster/);
    expect(code).toMatch(/createPresenceRegistry/);
    // It does not even import a database. The absence above is then
    // structural rather than a habit somebody could break in one line.
    expect(code).not.toMatch(/db\/pool/);
  });

  it('has no presence table anywhere in the database, after a session', async () => {
    const { registry } = recording();
    registry.beat(SCOPE, beatOf('conn-1', PRIYA, Date.now(), 'c14'));
    registry.beat(SCOPE, beatOf('conn-2', HUMAN, Date.now()));
    registry.leave('conn-1');

    const tables = await appDb().query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename ilike $1",
      ['%presence%']);
    expect(tables).toEqual([]);
    // The sanity check: this query CAN see a table that is really there.
    const real = await appDb().query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename ilike $1",
      ['%finding_disposition%']);
    expect(real.length).toBeGreaterThan(0);
  });

  it('has no presence column on any table either', async () => {
    const columns = await appDb().query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name ilike $1`, ['%presence%']);
    expect(columns).toEqual([]);
  });
});

describe('presence gates no write', () => {
  it('lets a disposition change through while somebody else is present on that clause', async () => {
    await withPg(async t => {
      await seedFinding(t);
      const { registry } = recording();
      // Priya is here, on this clause, right now.
      registry.beat(SCOPE, beatOf('conn-priya', PRIYA, Date.now(), 'c1'));
      expect(registry.roster(SCOPE)).toHaveLength(1);

      const { app } = buildTestApi({
        principal: { issuer: 'i', subject: 's-presence', groups: ['reviewers'] },
        db: dbOn(t),
        actor: {
          id: HUMAN, displayName: 'H Human', initials: 'HH', role: 'reviewer', workspaceId: WS,
        },
      });
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/reviews/pr1/findings/d1/c1/disposition',
        headers: { authorization: 'Bearer t' },
        payload: { state: 'rejected', reason: 'The cap is uncapped.', version: 1 },
      });
      /*
       * S6: presence "locks nothing, blocks nothing, gates no write". The
       * write succeeds and the roster is untouched by it — two facts, and
       * the second is the one a "soft warning" would break first.
       */
      expect(res.statusCode, res.body).toBe(200);
      expect(registry.roster(SCOPE)).toHaveLength(1);
    });
  });

  it('no write path in the shipped API consults a roster at all', () => {
    // The structural half of the claim above. `presence` is named by the
    // three realtime files that carry it and by nothing that writes a row —
    // a route that imported the registry would be a lock waiting to be
    // switched on.
    const readers = ['realtime/presence.ts', 'realtime/socket.ts', 'realtime/feed.ts',
      'server.ts', 'main.ts', 'config.ts'];
    const offenders = walkApiSources()
      .filter(f => /presenceRegistry|lexpromptPresence|\.roster\(/.test(codeOf(f)))
      .map(f => f.replace(/\\/g, '/').split('apps/api/src/')[1] ?? f)
      .filter(f => !readers.includes(f));
    expect(offenders).toEqual([]);
    // The sanity check: the scan finds the files that DO name it.
    expect(walkApiSources().filter(f => /roster/i.test(codeOf(f))).length).toBeGreaterThan(1);
  });
});

const walkApiSources = (): string[] => walk(path.join(ROOT, 'apps/api/src'));

async function seedFinding(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', 's-presence', 'H Human', 'HH', 'reviewer', 'active')
     on conflict (id) do nothing`, [HUMAN, WS]);
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('pm1', $1, 'Presence', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ('pr1', $1, 'pm1', '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ('pr1', 'd1', 'c1', $1, 'done') on conflict do nothing`, [WS]);
  await t.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     values ('pr1', 'd1', 'c1', $1, 'unchecked', 0) on conflict do nothing`, [WS]);
}
