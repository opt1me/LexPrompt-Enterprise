import type { FastifyInstance } from 'fastify';
import {
  ModelError, isRole,
  type Role, type RoleMappingEffect, type RoleMappingView, type RoleMappingsPage,
} from '@lexprompt/core';
import type { Db, Tx } from '../../db/pool.ts';
import { ROLE_RANK } from '../../auth/roles.ts';
import { appendAudit } from '../../audit/write.ts';

/**
 * §7's ROLE MAPPING, ADMINISTERED — the one screen in LexPrompt that writes
 * policy.
 *
 * ## What is holding this up, and it is not this file
 *
 * Migration 015 bounds the app role to `source = 'admin'` rows by row-level
 * security, and `lexprompt_migrator` owns the table so the startup seed is
 * unaffected. Every refusal below is therefore a SECOND layer: the handler
 * refuses first, with a sentence an administrator can act on, and the
 * database refuses after it with a Postgres error if the handler is ever
 * changed. `roleMappings.compose.test.ts` asserts both and trusts neither
 * alone — deleting the handler's refusal must leave the write still failing.
 *
 * ## Every write says what it will do FIRST, in the server's own words
 *
 * `POST …/preview` returns the sentence the screen renders VERBATIM (P53). A
 * screen that composes its own description of a policy change is a screen
 * that can describe it wrongly, and this is the one change in the
 * application whose consequence is who can do what. The sentence always ends
 * with when it applies — the next request, including for anyone already
 * signed in — which is true because `resolveActor` re-derives the role from
 * `role_mapping` on every single request.
 *
 * ## Nothing here reads or writes `app_user.role`
 *
 * That column is a per-request cache of the last role `roleFor` derived. It
 * is not policy, it is not authoritative, and a screen showing it as a
 * person's role shows a stale mapping as current (P54).
 */

/* -------------------------------------------------------------------------
 * The handle
 * ---------------------------------------------------------------------- */

/**
 * `role_mapping`'s primary key is `(issuer, group_value)` and it has no id
 * column, so a route addressing one row has to carry both halves.
 *
 * NOT as two path segments. An issuer is a URL, and the deployed proxy
 * DECODES `%2F` back into a path separator before Fastify routes: probed
 * against this project's own stack,
 * `…/http%3A%2F%2Flocalhost%3A8088%2Frealms%2Flexprompt/admins` arrived at
 * the API as `…/http:/localhost:8088/realms/lexprompt/admins` — more
 * segments than the route declares, with the double slash collapsed on top.
 * The route would simply never match, and the symptom would be a 404 on the
 * one screen whose subject is who can do what.
 *
 * base64url of `issuer\ngroupValue` survives that hop unchanged (probed in
 * the same run). `\n` is the separator because neither half can contain one:
 * `parseRoleMappings` splits `API_ROLE_MAPPINGS` on `,` and `|` and a
 * newline would have broken the entry long before it reached the table.
 */
export function mappingId(issuer: string, groupValue: string): string {
  return Buffer.from(`${issuer}\n${groupValue}`, 'utf8').toString('base64url');
}

/** The inverse, refusing rather than guessing. A handle that does not decode
 *  is a 404, never a lookup against half a key. */
export function parseMappingId(id: string): { issuer: string; groupValue: string } {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const cut = decoded.indexOf('\n');
  if (cut <= 0 || cut === decoded.length - 1) {
    throw new ModelError('There is no such role mapping.', 'not_found', 404);
  }
  return { issuer: decoded.slice(0, cut), groupValue: decoded.slice(cut + 1) };
}

/* -------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------- */

interface MappingRow {
  issuer: string;
  group_value: string;
  role: Role;
  source: 'configuration' | 'admin';
  created_at: Date;
  created_by_user_id: string | null;
  updated_at: Date | null;
  updated_by_user_id: string | null;
  converted_from_admin_at: Date | null;
}

const COLUMNS = `issuer, group_value, role, source, created_at,
                 created_by_user_id::text as created_by_user_id, updated_at,
                 updated_by_user_id::text as updated_by_user_id, converted_from_admin_at`;

/** Every optional field ABSENT rather than `undefined`-valued, the same rule
 *  `toActivityRow` and `toDispositionView` follow: `structuredClone`
 *  preserves an undefined-valued key, so an `in` check would read "nobody
 *  authored this" as "somebody did, unnamed". */
function toView(row: MappingRow): RoleMappingView {
  return {
    id: mappingId(row.issuer, row.group_value),
    issuer: row.issuer,
    groupValue: row.group_value,
    role: row.role,
    source: row.source,
    createdAt: row.created_at.getTime(),
    ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at.getTime() } : {}),
    ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
    ...(row.converted_from_admin_at
      ? { convertedFromAdminAt: row.converted_from_admin_at.getTime() } : {}),
  };
}

/* -------------------------------------------------------------------------
 * The sentence
 * ---------------------------------------------------------------------- */

/** How each role reads in a sentence a person has to act on. "an admin" is
 *  jargon; "an administrator" is what the refusal messages already say. */
const ARTICLE: Record<Role, string> = {
  reviewer: 'a reviewer',
  partner: 'a partner',
  admin: 'an administrator',
};

/**
 * WHEN IT APPLIES, in every sentence this module produces.
 *
 * True because `resolveActor` re-derives the role from `role_mapping` on
 * every request — there is no session cache to expire and no sign-out to
 * wait for. An administrator who believed otherwise would either leave a
 * revocation they thought had not landed, or grant a role and tell somebody
 * to sign in again for no reason.
 */
const WHEN = 'This takes effect on their next request, including for anyone already signed in.';

export function effectFor(
  issuer: string, groupValue: string, role: Role | undefined, current: Role | undefined,
): RoleMappingEffect {
  const group = JSON.stringify(groupValue);
  const action = role === undefined ? 'remove' : current === undefined ? 'create' : 'change';
  if (role === undefined) {
    return {
      action,
      widens: false,
      ...(current ? { currentRole: current } : {}),
      sentence: current === undefined
        ? `There is no mapping for the group ${group} from ${issuer}, so removing it would `
          + 'change nothing.'
        : `Anyone whose sign-in carries the group ${group} from ${issuer} is ${ARTICLE[current]} `
          + 'today. Removing this mapping leaves them with no role from that group at all — if '
          + 'it is their only mapped group they will have no access to LexPrompt. '
          + WHEN,
    };
  }
  const widens = current === undefined || ROLE_RANK[role] > ROLE_RANK[current];
  const head = `Anyone whose sign-in carries the group ${group} from ${issuer} will be `
    + `${ARTICLE[role]}.`;
  const now = current === undefined
    ? 'There is no mapping for that group today.'
    : role === current
      ? `That is what it already grants; nothing about who has access changes.`
      : `It grants ${ARTICLE[current]} today.`;
  return {
    action,
    widens,
    grantsRole: role,
    ...(current ? { currentRole: current } : {}),
    sentence: `${head} ${now} ${WHEN}`,
  };
}

/* -------------------------------------------------------------------------
 * The lock-out guard
 * ---------------------------------------------------------------------- */

/**
 * REFUSES A CHANGE THAT WOULD LEAVE THE WORKSPACE WITH NO ADMIN MAPPING,
 * inside the write transaction.
 *
 * ## Two statements, in this order, and the order is the guarantee
 *
 * The LOCK first: `for update` over the rows this request could actually
 * write (`source = 'admin'`), which serialises two concurrent admin-removing
 * writes — without it both see two admin mappings, both proceed, and the
 * workspace ends with none. A `select` OUTSIDE the transaction is the
 * classic wrong implementation here and it passes every single-caller test.
 *
 * The COUNT second, and WITHOUT `for update`. Postgres applies the UPDATE
 * policy's USING clause to a locking select and silently drops the rows that
 * fail it, so a count taken `for update` would not see an admin mapping that
 * came from `API_ROLE_MAPPINGS` — it would count one fewer than exists and
 * refuse a delete that was perfectly safe. Probed against the real database;
 * `roleMappingGrants.pg.test.ts` pins the behaviour.
 *
 * Under READ COMMITTED, the count runs on a snapshot taken after the lock
 * was granted, so a request that waited sees the winner's committed effect.
 */
async function refuseIfLastAdminMapping(
  t: Tx, workspaceId: string, removingRole: Role,
): Promise<void> {
  if (removingRole !== 'admin') return;
  await t.query(
    `select 1 from role_mapping
      where workspace_id = $1 and role = 'admin' and source = 'admin' for update`,
    [workspaceId]);
  const [{ n }] = await t.query<{ n: string }>(
    `select count(*)::text as n from role_mapping
      where workspace_id = $1 and role = 'admin'`,
    [workspaceId]);
  if (Number(n) > 1) return;
  throw new ModelError(
    'This is the only role mapping that grants administrator access to this workspace, so '
    + 'removing it would leave nobody able to reach this screen — including you. The only way '
    + 'back would be to redeploy with an administrator group named in API_ROLE_MAPPINGS. Add a '
    + 'second administrator mapping first.',
    'last_admin_mapping', 409,
  );
}

/* -------------------------------------------------------------------------
 * Reads and writes
 * ---------------------------------------------------------------------- */

/**
 * THE WIRE FIELD IS `grantsRole`, NOT `role`, and the name is load-bearing
 * twice over.
 *
 * It says what the value IS — what the mapping will grant — rather than
 * inviting the reading that a request can carry its own role. And
 * `stage2DoD.test.ts` scans every file under `apps/api/src` for `body.role`,
 * because *"a header a caller controls deciding what a caller may do is the
 * shape this whole gate exists to make impossible"*. That guard fired on the
 * first draft of this file. It is right that it has no exemption list, and
 * the fix is the field name rather than a hole in the scan: the value here is
 * DATA BEING WRITTEN, and the caller's own privilege is decided by
 * `ROUTE_POLICY` and `req.actor!.role` with nothing from the body anywhere
 * near it.
 */
interface WriteBody { issuer?: unknown; groupValue?: unknown; grantsRole?: unknown }

function roleFromBody(value: unknown, required: boolean): Role | undefined {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new ModelError(
      'A role is required: one of reviewer, partner, admin.', 'unknown', 400);
  }
  if (!isRole(value)) {
    throw new ModelError(
      `${JSON.stringify(value)} is not one of reviewer, partner, admin.`, 'unknown', 400);
  }
  return value;
}

function stringFromBody(value: unknown, field: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ModelError(`${field} is required.`, 'unknown', 400);
  return s;
}

/** Reads one row as the row it is — SOURCE INCLUDED, because the handler's
 *  own refusal depends on it and a read that dropped the column would leave
 *  only the database's message. */
async function readOne(
  runner: Db | Tx, workspaceId: string, issuer: string, groupValue: string,
): Promise<MappingRow | undefined> {
  const rows = await runner.query<MappingRow>(
    `select ${COLUMNS} from role_mapping
      where workspace_id = $1 and issuer = $2 and group_value = $3`,
    [workspaceId, issuer, groupValue]);
  return rows[0];
}

function refuseConfiguration(row: MappingRow): void {
  if (row.source !== 'configuration') return;
  throw new ModelError(
    `The mapping for ${JSON.stringify(row.group_value)} comes from this deployment's own `
    + 'configuration (API_ROLE_MAPPINGS), so it cannot be changed from this screen. An '
    + 'administrator changes it by editing that variable and redeploying. Nothing was saved.',
    'mapping_is_configuration', 409,
  );
}

export function registerRoleMappings(app: FastifyInstance, db: Db): void {
  app.get('/v1/admin/role-mappings', async (req): Promise<RoleMappingsPage> => {
    const ws = req.actor!.workspaceId;
    // `readAt` is measured AT THE QUERY, not at serialisation. The gap is
    // milliseconds and the point is which fact the instant describes: when
    // the rows below were true, not when they were turned into JSON.
    const readAt = Date.now();
    const rows = await db.query<MappingRow>(
      `select ${COLUMNS} from role_mapping
        where workspace_id = $1 order by source, group_value, issuer`,
      [ws]);
    return {
      mappings: rows.map(toView),
      readAt,
      // Named on the wire rather than typed into the screen: the variable an
      // administrator would have to edit is a deployment fact, and the
      // screen showing a name the server did not give it is one rename away
      // from sending somebody to a variable that no longer exists.
      configurationSource: 'API_ROLE_MAPPINGS',
    };
  });

  app.post('/v1/admin/role-mappings/preview', async (req): Promise<RoleMappingEffect> => {
    const ws = req.actor!.workspaceId;
    const body = (req.body ?? {}) as WriteBody;
    const issuer = stringFromBody(body.issuer, 'issuer');
    const groupValue = stringFromBody(body.groupValue, 'groupValue');
    // `role` ABSENT means "what would removing this do". One producer for
    // all three writes, so a removal's sentence cannot be the one the screen
    // wrote for itself.
    const role = roleFromBody(body.grantsRole, false);
    const current = await readOne(db, ws, issuer, groupValue);
    return effectFor(issuer, groupValue, role, current?.role);
  });

  app.post('/v1/admin/role-mappings', async (req, reply): Promise<RoleMappingView> => {
    const ws = req.actor!.workspaceId;
    const body = (req.body ?? {}) as WriteBody;
    const issuer = stringFromBody(body.issuer, 'issuer');
    const groupValue = stringFromBody(body.groupValue, 'groupValue');
    const role = roleFromBody(body.grantsRole, true)!;

    const written = await db.tx(async t => {
      const existing = await readOne(t, ws, issuer, groupValue);
      if (existing) {
        refuseConfiguration(existing);
        throw new ModelError(
          `There is already a mapping for ${JSON.stringify(groupValue)} from this issuer. `
          + 'Change it rather than adding a second one.',
          'conflict', 409,
        );
      }
      const rows = await t.query<MappingRow>(
        `insert into role_mapping
           (workspace_id, issuer, group_value, role, source, created_by_user_id)
         values ($1, $2, $3, $4, 'admin', $5)
         returning ${COLUMNS}`,
        [ws, issuer, groupValue, role, req.actor!.id]);
      // ONE TRANSACTION with its audit row (S11): a record of a policy change
      // that did not happen is worse than no record.
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'role_mapping.created',
        subjectType: 'role_mapping', subjectId: mappingId(issuer, groupValue),
        detail: { issuer, groupValue, toRole: role },
      });
      return rows[0];
    });
    void reply.code(201);
    return toView(written);
  });

  app.put('/v1/admin/role-mappings/:id', async (req): Promise<RoleMappingView> => {
    const ws = req.actor!.workspaceId;
    const { issuer, groupValue } = parseMappingId((req.params as { id: string }).id);
    const role = roleFromBody((req.body as WriteBody | undefined)?.grantsRole, true)!;

    return toView(await db.tx(async t => {
      const existing = await readOne(t, ws, issuer, groupValue);
      if (!existing) throw new ModelError('There is no such role mapping.', 'not_found', 404);
      refuseConfiguration(existing);
      // Only when this write takes the `admin` role AWAY from a mapping that
      // has it. Granting one can never leave the workspace without an
      // administrator.
      if (existing.role === 'admin' && role !== 'admin') {
        await refuseIfLastAdminMapping(t, ws, 'admin');
      }
      const rows = await t.query<MappingRow>(
        `update role_mapping
            set role = $4, updated_at = now(), updated_by_user_id = $5
          where workspace_id = $1 and issuer = $2 and group_value = $3
          returning ${COLUMNS}`,
        [ws, issuer, groupValue, role, req.actor!.id]);
      if (!rows[0]) {
        // The policy refused what the handler let through — which means the
        // handler's own check has been changed. Said plainly rather than
        // answered as a 500 nobody can describe.
        throw new ModelError(
          'LexPrompt could not change that role mapping. The database refused the write, '
          + 'which means it is not an administrator-authored mapping.',
          'mapping_is_configuration', 409,
        );
      }
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'role_mapping.changed',
        subjectType: 'role_mapping', subjectId: mappingId(issuer, groupValue),
        detail: { issuer, groupValue, fromRole: existing.role, toRole: role },
      });
      return rows[0];
    }));
  });

  app.delete('/v1/admin/role-mappings/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { issuer, groupValue } = parseMappingId((req.params as { id: string }).id);

    await db.tx(async t => {
      const existing = await readOne(t, ws, issuer, groupValue);
      if (!existing) throw new ModelError('There is no such role mapping.', 'not_found', 404);
      refuseConfiguration(existing);
      await refuseIfLastAdminMapping(t, ws, existing.role);
      const rows = await t.query<{ issuer: string }>(
        `delete from role_mapping
          where workspace_id = $1 and issuer = $2 and group_value = $3
          returning issuer`,
        [ws, issuer, groupValue]);
      if (!rows[0]) {
        throw new ModelError(
          'LexPrompt could not remove that role mapping. The database refused the write, '
          + 'which means it is not an administrator-authored mapping.',
          'mapping_is_configuration', 409,
        );
      }
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'role_mapping.removed',
        subjectType: 'role_mapping', subjectId: mappingId(issuer, groupValue),
        detail: { issuer, groupValue, fromRole: existing.role },
      });
    });
    void reply.code(204);
  });
}
