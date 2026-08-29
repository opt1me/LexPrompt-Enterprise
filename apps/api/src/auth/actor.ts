import { ModelError, type Role } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import type { Principal } from '../oidc.ts';

export interface Actor {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName: string;
  initials: string;
  role: Role;
  workspaceId: string;
}

/**
 * A display name from the best thing the token actually carries.
 *
 * Never "Unknown" and never blank. An attribution line reading "Verified by
 * Unknown" is worse than one reading "Verified by kc-sub-1", because the
 * second is at least resolvable by an administrator. Order: the name claim,
 * the email's local part, then the subject itself.
 */
function nameFrom(p: Principal): string {
  if (p.name?.trim()) return p.name.trim();
  if (p.email?.includes('@')) return p.email.split('@')[0];
  if (p.email?.trim()) return p.email.trim();
  return p.subject;
}

/** Two letters from two or more words, one from a single word. Mirrors the
 *  local profile's own initials so a migrated matter's owner does not change
 *  shape when the uploader rewrites its attribution (P16). */
export function initialsFrom(displayName: string): string {
  const words = displayName.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Just-in-time provisioning (§7): a row is created on first successful
 * sign-in from the token's configured subject claim, its issuer, and its
 * name and email claims.
 *
 * ONE statement, deliberately. A read-then-write would let two tabs signing
 * in at once both see no row and both insert, and the unique constraint
 * would answer the loser with a duplicate-key error at sign-in — a hard
 * failure on the happy path, which is the exact race `getProfile`'s
 * in-flight memoisation exists to close one layer up.
 *
 * `status` is in the INSERT and NOT in the DO UPDATE list. A disabled
 * account that signs in again must stay disabled; including `status` there
 * would make re-authentication the undo button for an administrator's
 * decision, and nothing in the UI would ever show it happening.
 *
 * `display_name` and `initials` are out of the DO UPDATE list for the SAME
 * reason, one person rather than one administrator. They were in it, which
 * made `PUT /v1/me` — the one thing §7 lets a person change about
 * themselves — a write that undid itself: a rename survived until the next
 * authenticated request, milliseconds later, when this statement put the
 * token's name back. A route, a repository function (`saveProfile`), its
 * docstring ("so the header shows a renamed user without a reload") and its
 * test all asserted a behaviour the server did not have. Nothing calls
 * `saveProfile` today, so the consequence was nil — and that is exactly the
 * shape that ships as a defect the day a rename screen lands.
 *
 * The cost, stated rather than hidden: a name changed in the identity
 * provider no longer propagates to an existing row. The token's name is
 * what PROVISIONS a row and is not what maintains it. Making both true at
 * once needs a `display_name_source` column ('token' | 'user'), so that a
 * name a person set wins and a name nobody set follows the token — a schema
 * change, and a Stage 3 one. Until then this is the direction that leaves
 * no self-undoing write.
 *
 * `email` is COALESCEd rather than taken from `excluded`. A token minted
 * without an `email` claim — a narrower scope, a different client — would
 * otherwise NULL a stored address rather than leave it, deleting a fact
 * nothing in this system can recover.
 *
 * The disabled check reads the row the upsert RETURNED — after the write,
 * not before it. Refusing first would suppress `last_seen_at`, which is the
 * fact an administrator uses to see that a disabled person is still trying.
 */
export async function resolveActor(
  t: Tx, principal: Principal, role: Role, workspaceId: string,
): Promise<Actor> {
  const displayName = nameFrom(principal);
  const rows = await t.query<{
    id: string; email: string | null; display_name: string;
    initials: string; role: Role; status: string;
  }>(
    `insert into app_user
       (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'active')
     on conflict (issuer, subject) do update set
       email        = coalesce(excluded.email, app_user.email),
       role         = excluded.role,
       last_seen_at = now()
     returning id, email, display_name, initials, role, status`,
    [workspaceId, principal.issuer, principal.subject, principal.email ?? null,
      displayName, initialsFrom(displayName), role],
  );
  const row = rows[0];
  if (row.status === 'disabled') {
    throw new ModelError(
      'Your LexPrompt account has been disabled by an administrator. Signing in again will '
      + 'not change this — your sign-in is working, and it is the account that is turned '
      + 'off. Ask an administrator to re-enable it.',
      'account_disabled', 403,
    );
  }
  return {
    id: row.id,
    issuer: principal.issuer,
    subject: principal.subject,
    email: row.email ?? undefined,
    displayName: row.display_name,
    initials: row.initials,
    role: row.role,
    workspaceId,
  };
}
