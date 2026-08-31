import type { FastifyInstance } from 'fastify';
import { ModelError, type WorkspaceUser } from '@lexprompt/core';
import type { Db } from '../../db/pool.ts';
import { appendAudit } from '../../audit/write.ts';

/**
 * §7's TWO ADMIN POWERS OVER A PERSON — turning an account off, and retiring
 * a name.
 *
 * ## The lock already existed; this is the door
 *
 * `resolveActor` has refused a `status = 'disabled'` account since Stage 2,
 * with a message saying plainly that signing in again will not change it —
 * and nothing could set that status. The refusal path was correct, tested,
 * and unreachable. These routes are the missing half, and nothing about the
 * refusal is re-implemented here.
 *
 * `status` is deliberately absent from `resolveActor`'s `do update` list, so
 * signing in again cannot undo an administrator's decision. That is asserted
 * from this side too rather than assumed.
 *
 * ## Pseudonymisation is §17 Q6's ONLY remedy, and it is not erasure
 *
 * `audit_event` is insert-only by grant and `finding_disposition_event` is
 * append-only history: both are the firm's record of who decided what about
 * a contract, and both are the reason `001_identity.sql` gives the app role
 * no `delete` on `app_user` at all — *"deleting one would orphan every
 * attribution they authored"*.
 *
 * So this route changes ONE ROW. It replaces the person's NAME and EMAIL
 * with a stable pseudonym and turns the account off. It touches no history
 * row, no audit row, no `by_user_id` and no foreign key. Every judgement
 * that person recorded is still theirs and is still attributable to the same
 * id — what stops being available is the name and the address.
 *
 * What that does and does not satisfy is a question for the firm's own DPO
 * and is written down in the README rather than implied by a button. A
 * button labelled "delete this person" over an implementation that cannot
 * delete would be the worst available outcome: a confident claim of erasure
 * that did not happen.
 */

interface UserRow {
  id: string;
  display_name: string;
  initials: string;
  role: WorkspaceUser['role'];
  status: 'active' | 'disabled';
  email: string | null;
}

const SELECT = `id::text as id, display_name, initials, role, status, email`;

/** ABSENT rather than `undefined`-valued for the optional address, the same
 *  rule `readUsers` follows: an `in` check must not read "no address" as
 *  "one, empty". */
function toView(row: UserRow): WorkspaceUser {
  return {
    id: row.id,
    displayName: row.display_name,
    initials: row.initials,
    role: row.role,
    status: row.status,
    ...(row.email ? { email: row.email } : {}),
  };
}

/**
 * REFUSES AN ADMINISTRATOR ACTING ON THEMSELVES.
 *
 * A locked-out administrator's only repair is a database session, which is
 * not a repair a firm has at 17:40 — the same reasoning as the last-admin
 * mapping guard next door, about the state a change would leave behind
 * rather than about the act.
 *
 * It is also what keeps this route from needing a "last administrator"
 * count: whoever is making the request is an administrator and stays active,
 * so an administrator always remains.
 */
function refuseSelf(actorId: string, targetId: string, verb: string): void {
  if (actorId !== targetId) return;
  throw new ModelError(
    `You cannot ${verb} your own account. If you did, nobody could undo it from LexPrompt — `
    + 'the repair would be a database session. Ask another administrator.',
    'cannot_disable_self', 409,
  );
}

async function readUser(db: Db, workspaceId: string, id: string): Promise<UserRow> {
  const rows = await db.query<UserRow>(
    `select ${SELECT} from app_user where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) {
    // 404 rather than an empty answer: "this workspace has no such person"
    // is a fact, and it must not read as a change that quietly did nothing.
    throw new ModelError('There is no such person in this workspace.', 'not_found', 404);
  }
  return rows[0];
}

export function registerPeople(app: FastifyInstance, db: Db): void {
  app.post('/v1/admin/users/:id/disable', async (req): Promise<WorkspaceUser> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    refuseSelf(req.actor!.id, id, 'disable');
    return toView(await db.tx(async t => {
      const before = await readUser(dbOn(t), ws, id);
      const rows = await t.query<UserRow>(
        `update app_user set status = 'disabled'
          where id = $1 and workspace_id = $2 returning ${SELECT}`, [id, ws]);
      // ONE TRANSACTION with its audit row (S11): a record of an access
      // change that did not happen is worse than no record.
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'user.disabled',
        subjectType: 'app_user', subjectId: id,
        detail: { wasStatus: before.status },
      });
      return rows[0];
    }));
  });

  app.post('/v1/admin/users/:id/enable', async (req): Promise<WorkspaceUser> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    return toView(await db.tx(async t => {
      const before = await readUser(dbOn(t), ws, id);
      const rows = await t.query<UserRow>(
        `update app_user set status = 'active'
          where id = $1 and workspace_id = $2 returning ${SELECT}`, [id, ws]);
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'user.enabled',
        subjectType: 'app_user', subjectId: id,
        detail: { wasStatus: before.status },
      });
      return rows[0];
    }));
  });

  app.post('/v1/admin/users/:id/pseudonymise', async (req): Promise<WorkspaceUser> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    refuseSelf(req.actor!.id, id, 'pseudonymise');
    return toView(await db.tx(async t => {
      await readUser(dbOn(t), ws, id);
      /*
       * ONE STATEMENT, and nothing else in the database is touched.
       *
       * The pseudonym is derived from the id, so it is STABLE: calling this
       * twice produces the same name rather than a second, different one.
       * A random pseudonym would make the same person look like two people
       * in a history that still names them by id.
       *
       * `status = 'disabled'` goes with it, and it is belt AND braces.
       * `resolveActor`'s `do update` excludes `display_name` (Stage 3's
       * fix), so a pseudonymised person signing in would not rename
       * themselves back — but an account that can still sign in under a
       * retired name is not a retired name, and the two defences are
       * asserted separately.
       */
      const rows = await t.query<UserRow>(
        `update app_user
            set display_name = 'Former user ' || left(id::text, 8),
                initials     = upper('F' || left(id::text, 1)),
                email        = null,
                status       = 'disabled'
          where id = $1 and workspace_id = $2
          returning ${SELECT}`,
        [id, ws]);
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'user.pseudonymised',
        subjectType: 'app_user', subjectId: id,
        // The OLD NAME IS NOT RECORDED HERE. An audit row carrying it would
        // put the retired name back into the one table nothing can erase,
        // which would make this route's whole point false.
        detail: {},
      });
      return rows[0];
    }));
  });
}

/** A `Tx` presented as the `Db` the read helper takes, so the read happens
 *  INSIDE the write's transaction rather than on a second connection that
 *  could see a different row. The same wrapper `pgHarness`'s `dbOn` provides
 *  to tests, written here because production code cannot import a test
 *  helper. */
function dbOn(t: import('../../db/pool.ts').Tx): Db {
  return { query: (text, values) => t.query(text, values), tx: run => t.tx(run) };
}
