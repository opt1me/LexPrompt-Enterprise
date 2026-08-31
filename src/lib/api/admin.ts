import type {
  RoleMappingEffect, RoleMappingView, RoleMappingsPage, Role,
} from '@lexprompt/core';
import { apiDelete, apiGet, apiSend } from './client';

/**
 * §7's ADMIN SURFACES, from the browser.
 *
 * ## No cache, and no optimistic write
 *
 * Every call here goes to the server and the screen renders what came back.
 * A cache would be a second answer to *"what is the policy"* — and this is
 * the one screen where a stale answer is an access-control fact rather than
 * a stale list. `readAt` travels with the page for the same reason: the
 * screen shows the instant it was told, and never one it composed.
 *
 * ## REJECTS on failure, never an empty list
 *
 * An empty `role_mapping` means NOBODY can sign in. A load path that
 * flattened a failure into `[]` would render that catastrophe and an
 * ordinary network blip identically, which is the shape every other load
 * path in this app already refuses.
 *
 * ## Nothing here composes a sentence about a change
 *
 * `previewRoleMapping` asks the SERVER what a change would do, and the
 * screen renders `sentence` verbatim (P53). A browser that described a
 * policy change in its own words is a browser that can describe it wrongly,
 * and the two descriptions would drift the first time the server's rules
 * changed.
 */

/** Every mapping this workspace has, configuration and admin alike, with the
 *  instant they were read and the name of the variable the configuration
 *  ones come from. */
export async function getRoleMappings(signal?: AbortSignal): Promise<RoleMappingsPage> {
  return apiGet<RoleMappingsPage>('/v1/admin/role-mappings', signal);
}

/**
 * What a proposed write WOULD do, in the server's words.
 *
 * `grantsRole` absent asks what REMOVING the mapping would do. The wire
 * field is `grantsRole` rather than `role` because it is what the mapping
 * grants, not who the caller is — see the route's own note on the guard that
 * scans for `body.role` in `apps/api/src`.
 */
export async function previewRoleMapping(
  issuer: string, groupValue: string, grantsRole?: Role, signal?: AbortSignal,
): Promise<RoleMappingEffect> {
  return apiSend<RoleMappingEffect>('POST', '/v1/admin/role-mappings/preview', {
    issuer, groupValue, ...(grantsRole === undefined ? {} : { grantsRole }),
  }, signal);
}

export async function createRoleMapping(
  issuer: string, groupValue: string, grantsRole: Role, signal?: AbortSignal,
): Promise<RoleMappingView> {
  return apiSend<RoleMappingView>(
    'POST', '/v1/admin/role-mappings', { issuer, groupValue, grantsRole }, signal);
}

/** `id` is the opaque handle the server minted on the row — never a path
 *  built from the issuer, which the deployed proxy would decode into extra
 *  path segments. */
export async function changeRoleMapping(
  id: string, grantsRole: Role, signal?: AbortSignal,
): Promise<RoleMappingView> {
  return apiSend<RoleMappingView>(
    'PUT', `/v1/admin/role-mappings/${encodeURIComponent(id)}`, { grantsRole }, signal);
}

export async function removeRoleMapping(id: string, signal?: AbortSignal): Promise<void> {
  await apiDelete(`/v1/admin/role-mappings/${encodeURIComponent(id)}`, signal);
}
