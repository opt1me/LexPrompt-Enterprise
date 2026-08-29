import type { Actor } from './auth/actor.ts';

/**
 * The actor overwrite every route that forwards a client body to the
 * gateway must apply (Task 17's rule; Task 18 reuses this rather than
 * rebuilding it for the streaming route).
 *
 * Spread the client body FIRST, then overwrite `workspaceId` /
 * `actorIssuer` / `actorSubject` / `actorUserId` from the validated token's
 * resolved `Actor`. A client that could set its own actor could put a
 * colleague's name — or a colleague's `app_user.id` — on every call in the
 * firm's audit log — corrupting the record that answers §12's questions,
 * silently. Never `{ workspaceId, actorIssuer, actorSubject, actorUserId, ...client }`.
 *
 * (issuer, subject), never an Entra-shaped id: `actor.subject` is whatever
 * the configured `subjectClaim` named, and the two halves stay separate so
 * Stage 2 can key `app_user` on the pair.
 *
 * `actorUserId` goes ALONGSIDE the pair, never replacing it (§6.5, Task 6):
 * a record written before `app_user` existed has the pair and no id, and a
 * query joining this call log to `app_user` must span both eras — which it
 * only can while the pair keeps being sent on every call, not only when an
 * id is available.
 */
export function withActor(
  client: Record<string, unknown>,
  workspaceId: string,
  actor: Actor,
): Record<string, unknown> {
  return {
    ...client,
    workspaceId,
    actorIssuer: actor.issuer,
    actorSubject: actor.subject,
    actorUserId: actor.id,
  };
}
