import type { FastifyInstance } from 'fastify';
import type { Role, WorkspaceUser, WorkspaceUsers } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';

/**
 * THE WORKSPACE'S PEOPLE — the ONE place a user id becomes a name (§6.3,
 * P32).
 *
 * ## Why this route exists at all
 *
 * §6.3 requires every disposition on screen to name who set it and when.
 * Until this route, the API had no way to answer that: `GET /v1/me` names
 * the caller and nobody else, so a card handed `byUserId:
 * "1fa80a94-5505-…"` could render an id or render nothing, and both are
 * wrong. `twoAccounts.compose.test.ts` demonstrates the gap against the
 * running stack.
 *
 * ## Why a directory rather than a name on every payload
 *
 * A `byUserId` on a `finding_disposition` is a FOREIGN KEY. A display name
 * is a MUTABLE field on `app_user` that a person changes through
 * `PUT /v1/me`. Carrying the name on every disposition and every event would
 * make a second copy of a mutable field, refreshed at different times in
 * different places — this project's most repeated defect, arriving on the
 * field a reader trusts most. One directory, resolved once per session,
 * keeps one copy.
 *
 * ## WHAT THIS ROUTE IS NOT
 *
 * It resolves ids to names FOR DISPLAY. It is not, and must not become, a
 * way to ASSERT an attribution. Nothing here writes anything; the only
 * writers of `finding_disposition` and `finding_disposition_event` are
 * `dispositions/service.ts`, called with `req.actor!.id` and this server's
 * clock, and `routes/findings.ts` refuses a body naming `byUserId` or `at`
 * by name. The fix round that closed the import's forged-attribution path
 * (`findings/import.ts`) is the reason that sentence is worth writing down:
 * a directory that could be POSTed to would reopen it from a new direction.
 */
export function registerUsers(app: FastifyInstance, db: Db): void {
  /**
   * `reviewer`, and the bar is argued rather than defaulted: a reviewer who
   * cannot resolve the name on a disposition they are being shown cannot
   * read their own screen. S10 has no per-matter ACLs for a directory to
   * respect, and the caller is already inside the workspace whose people
   * these are.
   */
  app.get('/v1/workspace/users', async (req): Promise<WorkspaceUsers> => ({
    users: await readUsers(db, req.actor!.workspaceId),
  }));
}

interface UserRow {
  id: string;
  display_name: string;
  initials: string;
  role: Role;
  status: 'active' | 'disabled';
  email: string | null;
}

/**
 * Every person in one workspace, ordered by name.
 *
 * ONE statement, ONE literal — not two concatenated. `workspaceScope.test.ts`
 * reads string literals out of the source and checks each one's predicate
 * region, and a statement split across a `+` puts `from app_user` in one
 * literal and `where … workspace_id` in another, which it reports (rightly)
 * as an unscoped read of a table holding every firm's people.
 *
 * A DISABLED user is listed. Someone who has left the firm still verified
 * things last March, and a card rendering "Verified by (unknown)" for them
 * is worse than one that names them and says the account is turned off —
 * hiding the row is how history loses a name. `status` travels so a caller
 * can say which it is.
 *
 * `order by display_name, id`: the id breaks a tie between two people with
 * the same name, so the directory reads the same way twice rather than in
 * whatever order the planner happened to produce.
 */
export async function readUsers(db: Db, workspaceId: string): Promise<WorkspaceUser[]> {
  const rows = await db.query<UserRow>(
    `select id::text as id, display_name, initials, role, status, email from app_user
      where workspace_id = $1 order by display_name, id`,
    [workspaceId]);
  return rows.map(r => ({
    id: r.id,
    displayName: r.display_name,
    initials: r.initials,
    role: r.role,
    status: r.status,
    // ABSENT when there is none, never `email: undefined`. `structuredClone`
    // preserves an undefined-valued key, so an `in` check would read it as
    // an address that is there — and an empty string would render as a
    // mailto link to nowhere.
    ...(r.email ? { email: r.email } : {}),
  }));
}
