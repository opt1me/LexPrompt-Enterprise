import type { Principal } from './oidc.ts';

/**
 * The actor overwrite every route that forwards a client body to the
 * gateway must apply (Task 17's rule; Task 18 reuses this rather than
 * rebuilding it for the streaming route).
 *
 * Spread the client body FIRST, then overwrite `workspaceId` /
 * `actorIssuer` / `actorSubject` from the validated token. A client that
 * could set its own actor could put a colleague's name on every call in the
 * firm's audit log — corrupting the record that answers §12's questions,
 * silently. Never `{ workspaceId, actorIssuer, actorSubject, ...client }`.
 *
 * (issuer, subject), never an Entra-shaped id: `principal.subject` is
 * whatever the configured `subjectClaim` named, and the two halves stay
 * separate so Stage 2 can key `app_user` on the pair.
 */
export function withActor(
  client: Record<string, unknown>,
  workspaceId: string,
  principal: Principal,
): Record<string, unknown> {
  return {
    ...client,
    workspaceId,
    actorIssuer: principal.issuer,
    actorSubject: principal.subject,
  };
}
