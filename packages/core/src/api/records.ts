/** The three roles (§7). A closed set, here, because both sides read it. */
export const ROLES = ['reviewer', 'partner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Who the caller is, as the API answers it.
 *
 * `id` is the `app_user` row's uuid, and it is what every `*UserId` field in
 * a record holds from this stage onwards. `issuer` and `subject` travel WITH
 * it and are not replaced by it (§6.5): the gateway's Stage 1 call log
 * carries the pair and no user id, so a record written before this stage
 * stays joinable to the person who wrote it only while both are present.
 */
export interface MeResponse {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName: string;
  initials: string;
  role: Role;
  workspaceId: string;
}
