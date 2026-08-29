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

/**
 * §6.6: `Settings.modelChoiceId` becomes workspace configuration an admin
 * sets from the gateway's allowlist, and `Settings.concurrency` becomes a
 * value STORED here (the server-side per-run bound it becomes is Stage 3's
 * — there is no run on the server yet to bound).
 *
 * `GET /v1/workspace/settings` answers this to any signed-in role; `PUT`
 * accepts it from an admin only (`ROUTE_POLICY`, both sides of the wire).
 * `version`/`updatedAt`/`updatedByUserId` are the same optimistic-
 * concurrency and attribution shape every other record in this project
 * carries (P9, §12) — an admin changing which provider the firm's text goes
 * to is exactly the kind of change §12 asks to be answerable about.
 *
 * `modelSupportsImages`/`modelSupportsStructuredOutput`/`modelContextLength`
 * are declared here too, ALL OPTIONAL, but they are not stored anywhere and
 * `apps/api` never reads or writes them — they are resolved CLIENT-SIDE by
 * cross-referencing `modelChoiceId` against `GET /v1/models`'s allowlist
 * (exactly as `Settings`'s old capability fields were), the same way this
 * type's own docstring in `src/App.tsx` explains. Declared here, alongside
 * the fields that actually cross the wire, so both sides read one type
 * rather than the browser inventing a second one that happens to extend it.
 */
export interface WorkspaceSettings {
  /** A gateway `AllowedModel.id`, or `''` for "not yet configured" — the
   *  same "empty string means unset" convention `Settings.modelChoiceId`
   *  used, kept so `isConfigured`-style checks did not need to learn a
   *  second shape (`null`) for the same fact. */
  modelChoiceId: string;
  modelChoiceLabel?: string;
  modelChoiceModel?: string;
  concurrency: number;
  /** Optional on the TYPE, the same way `Matter.version` is (`db/rows.ts`):
   *  the wire response from `apps/api` always sets it, but a client-side
   *  value built before any fetch has answered (`App.tsx`'s zeroed default,
   *  a test fixture) has no version to state, and absence here is exactly
   *  what a create-shaped write means one layer down in `matters.ts`'s own
   *  PUT. */
  version?: number;
  /** Epoch milliseconds, matching every other timestamp on the wire
   *  (`db/rows.ts`'s `epochOf`) — never an ISO string, which would be the
   *  one record type disagreeing with the rest about how time crosses this
   *  boundary. Optional for the same reason `version` is. */
  updatedAt?: number;
  updatedByUserId?: string;
  modelSupportsImages?: boolean;
  modelSupportsStructuredOutput?: boolean;
  modelContextLength?: number;
}
