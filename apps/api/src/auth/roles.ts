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
 * Makes the stored table equal to the configured one — writes what is
 * configured and REMOVES what is not.
 *
 * The removal half is not tidiness. `role_mapping` is deployment
 * configuration in this stage (Task 2's migration grants the app role SELECT
 * and nothing else), so the only way an administrator revokes a group's role
 * is by taking it out of `API_ROLE_MAPPINGS` and redeploying. An upsert-only
 * seed would leave the removed row in place and keep granting the role
 * forever, with the configuration file saying otherwise — a revocation that
 * silently did not happen, which is the same shape of wrong-and-confident
 * this project's one rule is about.
 *
 * Scoped to `workspace_id`, so another workspace's mappings are not swept up
 * by this one's deployment.
 *
 * An EMPTY list therefore deletes every mapping this workspace has. That is
 * the correct reading of "the configuration names no mapping", and it is
 * exactly why `config.ts` refuses to start with `API_ROLE_MAPPINGS` unset
 * rather than letting a missing value quietly empty the table.
 *
 * Runs on the MIGRATOR connection at startup — the app role holds no write
 * grant on this table, so no request can change a role mapping in this stage.
 */
export async function seedRoleMappings(
  runner: Db | Tx, workspaceId: string, mappings: RoleMapping[],
): Promise<void> {
  for (const m of mappings) {
    await runner.query(
      `insert into role_mapping (workspace_id, issuer, group_value, role)
       values ($1, $2, $3, $4)
       on conflict (issuer, group_value) do update
         set role = excluded.role, workspace_id = excluded.workspace_id`,
      [workspaceId, m.issuer, m.groupValue, m.role],
    );
  }
  await runner.query(
    `delete from role_mapping
      where workspace_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::text[]) as configured(issuer, group_value)
           where configured.issuer = role_mapping.issuer
             and configured.group_value = role_mapping.group_value)`,
    [workspaceId, mappings.map(m => m.issuer), mappings.map(m => m.groupValue)],
  );
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
