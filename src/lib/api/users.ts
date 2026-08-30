import type { WorkspaceUser, WorkspaceUsers } from '@lexprompt/core';
import { apiGet } from './client';

/**
 * THE BROWSER'S ONE RESOLVER FROM A USER ID TO A NAME (§6.3, P32).
 *
 * A `byUserId` is a foreign key and a display name is a mutable field on
 * `app_user`. Every attribution surface in Stage 4 — the card's actor line,
 * the history panel, the refusal notice — resolves through here, so there is
 * exactly one copy of that mutable field in this tab rather than one per
 * payload, refreshed at different times in different places.
 *
 * ## WHAT THIS MODULE MUST NOT BECOME
 *
 * It resolves ids to names FOR DISPLAY. It cannot assert an attribution and
 * must never grow a way to: the actor on a disposition comes from the token
 * `apps/api` validated, `routes/findings.ts` refuses a body naming
 * `byUserId` or `at` by name, and the fix round that closed the import's
 * forged-attribution path is why that sentence is worth writing down.
 * Nothing here writes anything, and nothing here is ever sent.
 *
 * ## Loaded once, and never per card
 *
 * A directory refreshed per row is a request per row, and the loop that
 * produces it is deleted by whoever profiles it next — taking the sentence
 * it fed with it. In-flight memoisation, and the cache cleared on failure so
 * one rejection does not poison every later call: the same rule
 * `db/profile.ts`'s `getProfile` follows and `db/open.ts`'s `getDb` follows,
 * reused rather than re-reasoned.
 */
let byId: Map<string, WorkspaceUser> | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Loads the directory, once per session.
 *
 * REJECTS on failure and leaves the directory unloaded — it never resolves
 * to an empty one. "This workspace has no other people" and "the directory
 * could not be read" render identically once the second has been flattened
 * into the first, and what they render as is every actor on every card
 * reading as a stranger. `directoryLoaded()` is how a caller tells the two
 * apart; `describeLoadError` turns the rejection into a sentence.
 */
export async function loadDirectory(): Promise<void> {
  if (byId) return;
  inFlight ??= apiGet<WorkspaceUsers>('/v1/workspace/users')
    .then(({ users }) => { byId = new Map(users.map(u => [u.id, u])); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Whether the directory is in hand. A caller that renders an actor without
 *  checking this cannot tell "left the firm" from "never loaded", and the
 *  two are not the same claim. */
export function directoryLoaded(): boolean {
  return byId !== null;
}

/**
 * The whole record for an id, or `undefined` for one the directory does not
 * hold.
 *
 * NEVER a fabricated entry and never the raw id. `matterActivity`'s R-GP5
 * already ruled this once for the local profile — *"an entry whose author
 * matches nothing known is rendered with NO actor rather than an invented
 * one"* — and this is the same rule one layer up, at the point where there
 * genuinely is more than one person to get wrong.
 */
export function userIn(id: string | undefined): WorkspaceUser | undefined {
  return id === undefined ? undefined : byId?.get(id);
}

/**
 * A person's display name, or `undefined`.
 *
 * `undefined` covers two facts on purpose — the directory does not hold this
 * id, and the directory is not loaded — because a CALLER cannot act on the
 * difference: either way it does not know this person's name and must say
 * so rather than print a uuid, which says nothing to a reader while looking
 * like it should. What a caller must not do is turn `undefined` into
 * silence: an actor line that disappears reads as "nobody did this", which
 * is the blank-CSV-cell defect at a new surface. `dispositionLabel`
 * (`findingOutcome.ts`) is where that wording lives.
 */
export function userName(id: string | undefined): string | undefined {
  return userIn(id)?.displayName;
}

/** Initials, on the same terms as `userName`. */
export function userInitials(id: string | undefined): string | undefined {
  return userIn(id)?.initials;
}

/** Puts this module back into the state a fresh tab is in. Tests, and a
 *  401-driven sign-in — a different person's session must not inherit the
 *  previous one's directory. */
export function forgetDirectory(): void {
  byId = null;
  inFlight = null;
}
