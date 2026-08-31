import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { API_BASE, asUser, signIn, type TestAccount } from './helpers/twoAccounts.ts';
import { threeAccounts } from './helpers/threeAccounts.ts';

/**
 * TURNING AN ACCOUNT OFF, over real HTTP, with three real people.
 *
 * ## What this file proves and what `people.pg.test.ts` proves
 *
 * Here: the GATE (a trainee and a partner refused at all three routes), and
 * the thing only a running stack can show — that a person already holding a
 * valid token is refused on their NEXT REQUEST, and that signing in again
 * does not undo it.
 *
 * There: pseudonymisation, and the byte-for-byte claim that it touches no
 * history row.
 *
 * ## Nothing here pseudonymises a seeded account
 *
 * Pseudonymisation is irreversible through the application —
 * `resolveActor`'s `do update` deliberately does not restore
 * `display_name`, which is Stage 3's fix and is load-bearing for this
 * feature. A compose test that pseudonymised the trainee would rename them
 * permanently for every suite that follows. The trainee is DISABLED here,
 * which is reversible, and re-enabled in `afterAll` whatever happens.
 */

const MIGRATOR_URL = process.env.LEXPROMPT_TEST_MIGRATION_URL;

let trainee: TestAccount;
let partner: TestAccount;
let admin: TestAccount;

const json = async <T>(res: Response): Promise<T> => await res.json() as T;

/** Puts every seeded account back to `active`, whatever happened. Run in
 *  `beforeAll` as well: a run that died half way through would otherwise
 *  leave the trainee locked out for every later suite, and the symptom is a
 *  403 in a file about something else entirely. */
async function reactivateEveryone(): Promise<void> {
  if (!MIGRATOR_URL) return;
  const pool = new Pool({ connectionString: MIGRATOR_URL, max: 1 });
  try {
    await pool.query(
      "update app_user set status = 'active' where subject in (select subject from app_user)");
  } finally { await pool.end(); }
}

beforeAll(async () => {
  await reactivateEveryone();
  ({ trainee, partner, admin } = await threeAccounts());
});

afterAll(reactivateEveryone);

describe('who may turn an account off', () => {
  it('refuses all three routes for a trainee and for a partner', async () => {
    for (const verb of ['disable', 'enable', 'pseudonymise']) {
      for (const who of [trainee, partner]) {
        const res = await asUser(who, 'POST', `/v1/admin/users/${admin.userId}/${verb}`, {});
        expect(res.status, `${verb} as ${who.username}`).toBe(403);
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('not_permitted');
      }
    }
    // …and the administrator is still active afterwards, which is what makes
    // the six refusals about the CALLER rather than about the route being
    // broken.
    expect((await asUser(admin, 'GET', '/v1/matters')).status).toBe(200);
  });

  it('refuses them unauthenticated with 401', async () => {
    const res = await fetch(`${API_BASE}/v1/admin/users/${admin.userId}/disable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('a disabled account, with the same token', () => {
  it('is refused on its NEXT REQUEST, and signing in again does not undo it', async () => {
    expect((await asUser(trainee, 'GET', '/v1/matters')).status).toBe(200);

    expect((await asUser(admin, 'POST',
      `/v1/admin/users/${trainee.userId}/disable`, {})).status).toBe(200);

    // THE SAME TOKEN. Not expired, not re-issued — `resolveActor` reads the
    // row on every request, and this is the refusal that has existed since
    // Stage 2 with nothing able to trigger it.
    const res = await asUser(trainee, 'GET', '/v1/matters');
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string; message: string } }>(res)).error.code)
      .toBe('account_disabled');

    // …and signing in AGAIN does not undo it. `resolveActor`'s upsert keeps
    // `status` out of its `do update` list precisely so that
    // re-authentication is not the undo button for an administrator's
    // decision; `signIn` calls `/v1/me`, so it rejects.
    await expect(signIn('trainee')).rejects.toThrow(/account_disabled|403/);

    // The refusal says so in words a person can act on, rather than sending
    // them round the sign-in loop again.
    const again = await asUser(trainee, 'GET', '/v1/matters');
    expect((await json<{ error: { message: string } }>(again)).error.message)
      .toMatch(/signing in again will not change this/i);
  });

  it('is restored by enable, on the same token again', async () => {
    expect((await asUser(admin, 'POST',
      `/v1/admin/users/${trainee.userId}/enable`, {})).status).toBe(200);
    expect((await asUser(trainee, 'GET', '/v1/matters')).status).toBe(200);
    // And a fresh sign-in works again too, which is the half that proves the
    // repair reached the row rather than only this token's cached actor.
    expect((await signIn('trainee')).role).toBe('reviewer');
  });

  it('refuses an administrator disabling THEMSELVES', async () => {
    const res = await asUser(admin, 'POST', `/v1/admin/users/${admin.userId}/disable`, {});
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('cannot_disable_self');
    // Still working, which is the point: a locked-out administrator's only
    // repair is a database session.
    expect((await asUser(admin, 'GET', '/v1/admin/role-mappings')).status).toBe(200);
  });

  it('leaves the stack as it found it — three accounts, three roles', async () => {
    const [t, p, a] = await Promise.all([signIn('trainee'), signIn('partner'), signIn('admin')]);
    expect([t.role, p.role, a.role]).toEqual(['reviewer', 'partner', 'admin']);
  });
});
