import { describe, it, expect } from 'vitest';
import { withPg, appDb, migratorDb } from './helpers/pgHarness.ts';
import { resolveActor } from '../src/auth/actor.ts';
import { ModelError } from '@lexprompt/core';
import type { Principal } from '../src/oidc.ts';

const WS = '00000000-0000-0000-0000-000000000001';
const principal = (over: Partial<Principal> = {}): Principal => ({
  issuer: 'http://keycloak:8080/realms/lexprompt',
  subject: 'kc-sub-1',
  groups: [],
  name: 'Ada Trainee',
  email: 'trainee@lexprompt.local',
  ...over,
});

describe('resolveActor', () => {
  it('creates a row on first sight, with the role it was given', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      expect(actor.role).toBe('reviewer');
      expect(actor.displayName).toBe('Ada Trainee');
      expect(actor.initials).toBe('AT');
      expect(actor.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  it('returns the SAME id on the second sight of the same (issuer, subject)', async () => {
    await withPg(async t => {
      const first = await resolveActor(t, principal(), 'reviewer', WS);
      const second = await resolveActor(t, principal({ email: 'renamed@lexprompt.local' }), 'reviewer', WS);
      expect(second.id).toBe(first.id);
      // The email moved and the identity did not — the whole argument for
      // keying on (issuer, subject) rather than on the email.
      expect(second.email).toBe('renamed@lexprompt.local');
    });
  });

  it('updates the role when the mapping has changed since the last sign-in', async () => {
    await withPg(async t => {
      await resolveActor(t, principal(), 'reviewer', WS);
      expect((await resolveActor(t, principal(), 'partner', WS)).role).toBe('partner');
    });
  });

  it('refuses a disabled account as its own thing, not as a sign-in failure', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled' where id = $1", [actor.id]);
      const err = await resolveActor(t, principal(), 'reviewer', WS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe('account_disabled');
      expect((err as ModelError).status).toBe(403);
      // NOT sign_in_required: signing in again is exactly what a disabled
      // user would try, it would succeed, and they would meet the same
      // refusal forever — a loop the message would have caused.
    });
  });

  it('never lets a re-sign-in re-enable a disabled account', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled' where id = $1", [actor.id]);
      await resolveActor(t, principal(), 'admin', WS).catch(() => undefined);
      const rows = await t.query<{ status: string }>('select status from app_user where id = $1', [actor.id]);
      expect(rows[0].status).toBe('disabled');
    });
  });

  it('still records last_seen_at for a disabled account that tried', async () => {
    // An administrator seeing "still trying, twice today" is the fact that
    // makes a disabled account actionable. Refusing before the write would
    // hide it.
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled', last_seen_at = '2000-01-01' where id = $1", [actor.id]);
      await resolveActor(t, principal(), 'reviewer', WS).catch(() => undefined);
      const rows = await t.query<{ y: string }>(
        "select to_char(last_seen_at, 'YYYY') y from app_user where id = $1", [actor.id]);
      expect(rows[0].y).not.toBe('2000');
    });
  });

  it('never resolves a token from one issuer to a user provisioned under another, even with the same subject', async () => {
    // The worst defect available in just-in-time provisioning: a lookup that
    // matched on `subject` alone would silently merge a Keycloak account and
    // an Entra account that happen to share an opaque id. Two issuers exist
    // precisely so local and deployed run the same code path, and this is
    // the property that makes that safe.
    await withPg(async t => {
      const a = await resolveActor(t, principal({ issuer: 'https://issuer-a.test', subject: 'shared-sub' }), 'reviewer', WS);
      const b = await resolveActor(t, principal({ issuer: 'https://issuer-b.test', subject: 'shared-sub' }), 'partner', WS);
      expect(a.id).not.toBe(b.id);
      expect(a.role).toBe('reviewer');
      expect(b.role).toBe('partner');
      const rows = await t.query<{ n: string }>(
        "select count(*)::text n from app_user where subject = 'shared-sub'");
      expect(rows[0].n).toBe('2');
    });
  });

  it('falls back to the email local part when the token carries no name', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal({ name: undefined }), 'reviewer', WS);
      expect(actor.displayName).toBe('trainee');
      expect(actor.initials).toBe('T');
    });
  });

  it('names the subject when there is neither a name nor an email, rather than showing nothing', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal({ name: undefined, email: undefined }), 'reviewer', WS);
      expect(actor.displayName).toBe('kc-sub-1');
      expect(actor.initials).toBe('K');
    });
  });

  // Real concurrency, deliberately NOT inside `withPg`: `withPg` binds every
  // call to ONE pinned client, so two "concurrent" calls through it would
  // only interleave on a single Postgres session, proving nothing about the
  // race two browser tabs signing in at once actually create. This uses two
  // independent connections from the real app pool committing for real, so
  // cleanup runs afterwards on the migrator connection (the app role has no
  // DELETE grant on app_user, by design — see identity.pg.test.ts).
  //
  // Task 1's advisory-lock race was invisible in a single run and showed up
  // in 6 of 11 (§ task-1-report). One green run here proves nothing about
  // concurrency either, so this repeats the race many times in one test
  // rather than trusting a single pair of concurrent calls.
  it('two concurrent sign-ins from the same (issuer, subject) never create two rows', async () => {
    const db = appDb();
    const ITERATIONS = 25;
    const subjects: string[] = [];
    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const subject = `race-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
        subjects.push(subject);
        const p = principal({ subject });
        const [a, b] = await Promise.all([
          db.tx(t => resolveActor(t, p, 'reviewer', WS)),
          db.tx(t => resolveActor(t, p, 'reviewer', WS)),
        ]);
        expect(a.id).toBe(b.id);
        const rows = await db.query<{ n: string }>(
          'select count(*)::text n from app_user where subject = $1', [subject]);
        expect(rows[0].n).toBe('1');
      }
    } finally {
      // Cleanup on the migrator connection — the app role structurally
      // cannot delete an app_user row (Task 2's grant test), which is why
      // this is not `db.query(...)`.
      await migratorDb().query('delete from app_user where subject = any($1)', [subjects]);
    }
  });
});
