import { ModelError, isRole, type Role } from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';

export interface RoleMapping {
  issuer: string;
  groupValue: string;
  role: Role;
}

/**
 * admin > partner > reviewer.
 *
 * A person in several mapped groups gets the HIGHEST, because taking the
 * lowest would mean ADDING a group could REMOVE access — an outcome nobody
 * at a directory console would predict, and one that would show up as a
 * partner losing the ability to publish the day somebody added them to
 * all-staff.
 *
 * This is the only ranking of the three roles in `apps/api/src`, and
 * `requireRole.ts` imports it rather than declaring a second one: two copies
 * of an ordering that must agree is this project's most repeated defect
 * (CLAUDE.md, "Sibling drift"), and the two copies here would be a
 * provisioning decision and an authorisation decision drifting apart.
 */
export const ROLE_RANK: Record<Role, number> = { reviewer: 1, partner: 2, admin: 3 };

/**
 * `API_ROLE_MAPPINGS` is a comma-separated list of `issuer|group|role`.
 *
 * Shaped like `API_REQUIRED_CLAIMS`'s parser next door and for the same
 * reason: the API has no idea what a group value MEANS. A Keycloak group
 * name (`partners`, because the seeded realm's mapper sets `full.path` to
 * false) and an Entra security-group object id (`8f2c1a55-…`) are both
 * opaque strings here, looked up in the same table by the same code (S28).
 *
 * A malformed entry throws rather than being skipped. Skipping is how a firm
 * ends up with a partners group nobody mapped and a partner who is told,
 * confidently, that they have no access.
 *
 * Throws a plain `Error`; `config.ts` re-raises it as a `ConfigError` so this
 * module does not have to import the configuration module that imports it.
 */
export function parseRoleMappings(raw: string | undefined): RoleMapping[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  return trimmed.split(',').map(entry => {
    const parts = entry.split('|').map(s => s.trim());
    if (parts.length !== 3 || parts.some(p => !p)) {
      throw new Error(
        `API_ROLE_MAPPINGS entry ${JSON.stringify(entry)} is not "issuer|group|role".`,
      );
    }
    const [issuer, groupValue, role] = parts;
    if (!isRole(role)) {
      throw new Error(
        `API_ROLE_MAPPINGS entry ${JSON.stringify(entry)} names the role ${JSON.stringify(role)}, `
        + 'which is not one of reviewer, partner, admin.',
      );
    }
    return { issuer, groupValue, role };
  });
}

/**
 * A configuration entry that CLAIMED a row an administrator had authored
 * (P52). Reported back so `main.ts` can name it in the startup log, and
 * recorded permanently on the row itself as `converted_from_admin_at`.
 */
export interface SupersededMapping {
  issuer: string;
  groupValue: string;
  /** What the administrator's row granted, and is about to stop granting. */
  previousRole: Role;
  /** What the configuration grants instead. It may be the SAME role — the
   *  row still changed hands, and the administrator still lost the ability
   *  to edit it from the screen, which is the fact they need told. */
  role: Role;
}

/**
 * Makes the CONFIGURATION HALF of the stored table equal to the configured
 * one — writes what is configured and REMOVES what is not.
 *
 * The removal half is not tidiness. The only way an administrator revokes a
 * group's role through deployment configuration is by taking it out of
 * `API_ROLE_MAPPINGS` and redeploying. An upsert-only seed would leave the
 * removed row in place and keep granting the role forever, with the
 * configuration file saying otherwise — a revocation that silently did not
 * happen, which is the same shape of wrong-and-confident this project's one
 * rule is about.
 *
 * ## `and source = 'configuration'` is the whole of this function's risk
 *
 * Since migration 015 this table has TWO writers: this seed, and the admin
 * screen behind `POST /v1/admin/role-mappings`. They get one half each, and
 * the database enforces the boundary for the app role (row-level security
 * bounds it to `source = 'admin'`; the migrator owns the table and is
 * unaffected, which is what keeps this function working at all).
 *
 * Nothing bounds THIS function except the predicate on the delete. Without
 * it, every container restart erases every mapping an administrator ever
 * made — silently, with nothing on screen and nothing in a log, and from the
 * screen it looks exactly like a change that never saved. With it in the
 * wrong arm, configuration stops revoking. There is no third failure mode
 * and both are silent, which is why `roleMappingSeed.pg.test.ts` asserts
 * each direction separately.
 *
 * ## A collision supersedes, and says so
 *
 * When `API_ROLE_MAPPINGS` names a group an administrator has already mapped,
 * CONFIGURATION WINS — a deployment's own policy must not be overridable
 * from a screen, or a compromised admin session outlives the deployment that
 * would correct it. The row becomes `source = 'configuration'`, and
 * `converted_from_admin_at` keeps the fact visible ON THE ROW forever rather
 * than only in a log, so an administrator looking at the screen can see that
 * their change was superseded without going and reading one.
 *
 * The collisions are also RETURNED, so `main.ts` can write a startup line
 * naming each. A supersession that happened only in a table nobody watches
 * is a supersession nobody sees.
 *
 * ## Why there is no `audit_event` row for a supersession
 *
 * `appendAudit` requires an `actorUserId`, and `audit_event.actor_user_id`
 * is `not null references app_user(id)` — it means "the person who did
 * this". At startup there is no person. The available candidates are all
 * false in the same way: the administrator whose row was superseded did not
 * supersede it, an arbitrary `role = 'admin'` user did nothing at all, and a
 * synthetic "system" user would be a fabricated id in the one table a firm
 * would treat as evidence. Recording a deployment's act against a named
 * human is precisely the confidently-wrong attribution this project exists
 * not to make, so the supersession is recorded where it can be recorded
 * honestly: on the row, permanently and on screen, and in the startup log.
 *
 * `AUDIT_ACTIONS` therefore gains no `role_mapping.superseded_by_configuration`
 * verb: `actions.ts` is a closed set of acts a PERSON took, and a verb with
 * no writer is the shape that file's own docstring refuses.
 *
 * ## Scope and emptiness, both unchanged
 *
 * Scoped to `workspace_id`, so another workspace's mappings are not swept up
 * by this one's deployment. An EMPTY list therefore deletes every
 * CONFIGURATION mapping this workspace has and leaves its admin ones — the
 * correct reading of "the configuration names no mapping", and why
 * `config.ts` refuses to start with `API_ROLE_MAPPINGS` unset rather than
 * letting a missing value quietly empty the table.
 *
 * Runs on the MIGRATOR connection at startup.
 */
export async function seedRoleMappings(
  runner: Db | Tx, workspaceId: string, mappings: RoleMapping[],
): Promise<SupersededMapping[]> {
  /*
   * READ THE COLLISIONS FIRST, in a statement of their own.
   *
   * `converted_from_admin_at is null` is what makes a restart idempotent:
   * without it every startup reports the same supersession again and an
   * operator reads one as a hundred. And the scan is separate from the
   * upsert deliberately — if the report and the row change came out of one
   * statement, a test asserting both would be asserting one fact twice.
   */
  const superseded = mappings.length === 0 ? [] : await runner.query<{
    issuer: string; group_value: string; role: Role;
  }>(
    `select issuer, group_value, role from role_mapping
      where workspace_id = $1
        and source = 'admin'
        and converted_from_admin_at is null
        and (issuer, group_value) in (
          select * from unnest($2::text[], $3::text[]))`,
    [workspaceId, mappings.map(m => m.issuer), mappings.map(m => m.groupValue)],
  );

  for (const m of mappings) {
    await runner.query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, $3, $4, 'configuration')
       on conflict (issuer, group_value) do update
         set role = excluded.role,
             workspace_id = excluded.workspace_id,
             source = 'configuration',
             -- Stamped only on the FIRST conversion, so a later restart
             -- does not keep moving the instant an administrator is being
             -- shown as the moment their change was taken over.
             converted_from_admin_at = case
               when role_mapping.source = 'admin' and role_mapping.converted_from_admin_at is null
                 then now()
               else role_mapping.converted_from_admin_at
             end`,
      [workspaceId, m.issuer, m.groupValue, m.role],
    );
  }

  await runner.query(
    `delete from role_mapping
      where workspace_id = $1
        -- THE PREDICATE. See this function's docstring: without it every
        -- restart erases every admin-authored mapping in the workspace.
        and source = 'configuration'
        and not exists (
          select 1 from unnest($2::text[], $3::text[]) as configured(issuer, group_value)
           where configured.issuer = role_mapping.issuer
             and configured.group_value = role_mapping.group_value)`,
    [workspaceId, mappings.map(m => m.issuer), mappings.map(m => m.groupValue)],
  );

  const byKey = new Map(mappings.map(m => [`${m.issuer} ${m.groupValue}`, m.role]));
  return superseded.map(row => ({
    issuer: row.issuer,
    groupValue: row.group_value,
    previousRole: row.role,
    role: byKey.get(`${row.issuer} ${row.group_value}`)!,
  }));
}

/**
 * The group claim becomes a role, or the request is refused.
 *
 * `groups` comes from `oidc.ts`'s `readGroups`, which has already refused a
 * claim shape it could not read (`service_misconfigured`, 503) and has
 * already raised `group_overage` for an ABSENT claim with `_claim_names`
 * beside it. So an empty array here genuinely means "authenticated, in no
 * group the token could carry", and refusing it is correct — that
 * distinction is the whole of §7's missing-versus-empty rule, and it is
 * upheld one module upstream. Do not re-derive it here; there is exactly one
 * place it lives, and a second one would be where the two disagree.
 *
 * The lookup carries the ISSUER, which is why the table's primary key does:
 * a local realm's group name must be worth nothing in a tenant, and a
 * tenant's object id worth nothing in a local realm.
 *
 * There is no workspace filter, deliberately. `role_mapping`'s primary key is
 * `(issuer, group_value)`, so a row belongs to exactly one workspace and a
 * filter could only ever remove a row this lookup should have seen — and §6
 * has one workspace. When a second one arrives, the key changes first and
 * this query changes with it.
 */
export async function roleFor(runner: Tx | Db, issuer: string, groups: string[]): Promise<Role> {
  if (groups.length > 0) {
    const rows = await runner.query<{ role: Role }>(
      'select role from role_mapping where issuer = $1 and group_value = any($2::text[])',
      [issuer, groups],
    );
    let best: Role | undefined;
    for (const row of rows) if (!best || ROLE_RANK[row.role] > ROLE_RANK[best]) best = row.role;
    if (best) return best;
  }
  // The message NAMES THE GROUPS the token carried. An administrator reading
  // "your sign-in carries these groups: all-staff, london-office" can map one
  // of them; one reading "no access" can do nothing at all, and the user will
  // be back tomorrow.
  throw new ModelError(
    'Your account is not in any group that LexPrompt maps to a role, so you have no access '
    + `to it yet. ${groups.length === 0
      ? 'Your sign-in carries no groups at all.'
      : `Your sign-in carries these groups: ${groups.join(', ')}.`} `
    + 'Ask an administrator to add one of them to the LexPrompt role mapping. This is not '
    + 'something signing in again will change.',
    'no_role', 403,
  );
}
