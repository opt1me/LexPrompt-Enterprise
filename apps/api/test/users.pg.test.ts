import { describe, it, expect } from 'vitest';
import type { Role } from '@lexprompt/core';
import { migratorDb, withPg, dbOn } from './helpers/pgHarness.ts';
import { readUsers } from '../src/routes/users.ts';
import type { Db, Tx } from '../src/db/pool.ts';

/**
 * THE ONE PLACE A USER ID BECOMES A NAME (§6.3, P32).
 *
 * Every attribution surface in Stage 4 resolves through this: the card's
 * actor line, the history panel, the refusal notice. Before it existed the
 * API had no route that could name anybody but the caller, which is why
 * Task 1's demonstration ends with a rejection carrying a uuid and nothing
 * a reader could act on.
 *
 * Run on the MIGRATOR connection: `app_user` rows are what these cases are
 * about, and the app role holds no DELETE on the table — everything here is
 * inside `withPg`'s always-rolled-back transaction either way.
 */

const WS_A = '00000000-0000-0000-0000-000000000001';
/** A second workspace, created inside the rolled-back transaction. The whole
 *  point of the first case is that its people do not appear in A's answer,
 *  and a workspace that does not exist cannot hold anybody. */
const WS_B = '00000000-0000-0000-0000-0000000000b2';

interface Seed {
  id: string;
  workspace: string;
  displayName: string;
  email: string | null;
  role: Role;
  status: 'active' | 'disabled';
}

async function insert(t: Tx, seed: Seed): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user
       (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
     values ($1, $2, 'https://issuer.test/realms/x', $3, $4, $5, $6, $7, $8)
     returning id::text as id`,
    [seed.id, seed.workspace, `sub-${seed.id}`, seed.email, seed.displayName,
      seed.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2),
      seed.role, seed.status]);
  return rows[0].id;
}

const A_OKAFOR = '11111111-1111-4111-8111-000000000001';
const A_TRAINEE = '11111111-1111-4111-8111-000000000002';
const A_GONE = '11111111-1111-4111-8111-000000000003';
const B_STRANGER = '11111111-1111-4111-8111-0000000000b1';

async function seedTwoWorkspaces(t: Tx): Promise<void> {
  await t.query(
    `insert into workspace (id, name) values ($1, 'Another firm')
     on conflict (id) do nothing`, [WS_B]);
  await insert(t, { id: A_OKAFOR, workspace: WS_A, displayName: 'R Okafor',
    email: 'r.okafor@firm.test', role: 'partner', status: 'active' });
  await insert(t, { id: A_TRAINEE, workspace: WS_A, displayName: 'A Trainee',
    email: null, role: 'reviewer', status: 'active' });
  await insert(t, { id: A_GONE, workspace: WS_A, displayName: 'P Departed',
    email: 'p.departed@firm.test', role: 'reviewer', status: 'disabled' });
  await insert(t, { id: B_STRANGER, workspace: WS_B, displayName: 'S Stranger',
    email: 's@other.test', role: 'admin', status: 'active' });
}

/** `readUsers` takes a `Db`; `withPg` hands out a `Tx`. `dbOn` is the
 *  shipped wrapper — opening a second connection would put the reads
 *  outside the rollback. */
const on = dbOn;

describe('the workspace user directory', () => {
  it('lists the workspace s users, and nobody else s', async () => {
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const users = await readUsers(on(t), WS_A);
      const ids = users.map(u => u.id);
      // A SUPERSET check, not an equality one: this database is shared with
      // every other `.pg` suite and the workspace already holds the seeded
      // accounts. What matters is that all three of A's people are there…
      expect(ids).toContain(A_OKAFOR);
      expect(ids).toContain(A_TRAINEE);
      expect(ids).toContain(A_GONE);
      // …and that B's is not. This is the assertion the whole route turns
      // on: a directory that leaked would put another firm's people on a
      // card with this application's full authority.
      expect(ids).not.toContain(B_STRANGER);
      expect(users.every(u => u.displayName !== 'S Stranger')).toBe(true);
    }, migratorDb());
  });

  it('returns no email when the record has none, rather than an empty string', async () => {
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const u = (await readUsers(on(t), WS_A)).find(x => x.id === A_TRAINEE)!;
      // `toEqual` cannot tell an absent key from an `undefined` one, and
      // `structuredClone` — how every record crosses a boundary here —
      // PRESERVES an undefined-valued key. So absence is asserted with `in`.
      expect('email' in u).toBe(false);
      expect(u.displayName).toBe('A Trainee');
    }, migratorDb());
  });

  it('carries an email that IS there', async () => {
    // The other half of the pair above, or the `in` check passes against a
    // reader that drops the field entirely.
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const u = (await readUsers(on(t), WS_A)).find(x => x.id === A_OKAFOR)!;
      expect(u.email).toBe('r.okafor@firm.test');
    }, migratorDb());
  });

  it('lists a disabled user rather than hiding them', async () => {
    // A person who has left the firm still verified things last March, and a
    // card that renders "Verified by (unknown)" for them is worse than one
    // that names them and says the account is disabled. Hiding the row is
    // how history loses a name.
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const u = (await readUsers(on(t), WS_A)).find(x => x.id === A_GONE)!;
      expect(u.status).toBe('disabled');
      expect(u.displayName).toBe('P Departed');
      expect(u.role).toBe('reviewer');
    }, migratorDb());
  });

  it('reads ONE statement, not one per person', async () => {
    // A directory fetched per row is a request per card, and the loop that
    // produces it gets deleted by whoever profiles it next — taking the
    // sentence it fed with it.
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const issued: string[] = [];
      const counting: Db = {
        query: (text, values) => { issued.push(text); return t.query(text, values); },
        tx: run => t.tx(run),
      };
      await readUsers(counting, WS_A);
      expect(issued).toHaveLength(1);
      // …and it is scoped. The predicate is the whole security property of
      // this route, so it is asserted against the statement actually sent
      // rather than left to the repo-wide scanner alone.
      expect(issued[0]).toMatch(/where\s+workspace_id\s*=\s*\$1/);
    }, migratorDb());
  });

  it('orders by display name, so the directory reads the same way twice', async () => {
    // The three seeded names in any collation anybody uses: A < P < R. Not
    // compared against a JavaScript sort — Postgres orders by its own
    // collation and the two disagree on case and punctuation, which would
    // make this case a test of the database's locale rather than of the
    // statement's `order by`.
    await withPg(async t => {
      await seedTwoWorkspaces(t);
      const ids = (await readUsers(on(t), WS_A)).map(u => u.id);
      expect(ids.indexOf(A_TRAINEE)).toBeLessThan(ids.indexOf(A_GONE));
      expect(ids.indexOf(A_GONE)).toBeLessThan(ids.indexOf(A_OKAFOR));
    }, migratorDb());
  });
});
