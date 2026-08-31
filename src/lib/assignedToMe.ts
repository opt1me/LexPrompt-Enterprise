import type { AssignmentInboxPage, AssignmentView } from '@lexprompt/core';
import { getMyInbox } from './api/assignments';
import { describeLoadError } from './loadError';

/**
 * "ASSIGNED TO ME" — A COUNTER THAT NEVER SAYS ZERO WHEN IT DOES NOT KNOW
 * (§18 item 5, S18, Stage 5).
 *
 * ## Three states, and the third is the point
 *
 * `ready` with `count: 0` renders as **nothing at all**. `error` renders as
 * a marker with a sentence. They must not be the same pixel: a badge that
 * hides a request because a fetch failed is a lawyer not doing something a
 * colleague is waiting on, and it looks exactly like a quiet week.
 *
 * That is this project's founding defect at a new surface. A CSV wrote
 * unreviewed clauses as blank cells and a spreadsheet read them as "checked,
 * nothing found"; a counter that renders `0` on a failed read is the same
 * mistake with one digit instead of an empty cell.
 *
 * ## Nothing is derived from the frames themselves
 *
 * A frame is a doorbell. The count is always the answer to a fresh read of
 * `GET /v1/assignments?state=open`, never a number this module incremented
 * on a push — a count maintained by incrementing diverges the first time a
 * frame is missed, and a socket that has been asleep misses them by design
 * (the outbox is a reconnection buffer, not an archive).
 */
export type AssignedToMeKind = 'loading' | 'error' | 'ready';

export type AssignedToMe =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
    status: 'ready';
    count: number;
    capped: boolean;
    /**
     * The distinct matters these requests are in, in the order the inbox
     * returned them.
     *
     * A counter with no way to find what it counts is a badge, and this
     * stage ships no cross-matter inbox SCREEN to send a reader to -- so
     * the marker names the matters instead of offering a control that does
     * not do what it says. It is exactly what Task 1's projection exists
     * for: the row alone could not have said this.
     */
    matters: string[];
  };

/**
 * How this module hears that something changed.
 *
 * INJECTED rather than reached for, because the socket delivers assignment
 * frames per REVIEW SUBSCRIPTION (§8) and this counter lives in the app
 * header, which is not on a review. `App` is the one place that holds both
 * facts, so it is the one place that connects them — through
 * `assignmentChanged` below, which is a fan-out and not a second transport.
 */
export type AssignmentSubscribe = (
  onAssignment: (assignment: AssignmentView) => void,
) => () => void;

const listeners = new Set<(assignment: AssignmentView) => void>();

/**
 * A frame arrived. Called by whatever is already receiving socket events —
 * `App`'s `applyPush` — and by nothing else.
 *
 * It carries the WHOLE ROW rather than a count or a delta, because the
 * decision this module makes with it is "is this addressed to me", and a
 * delta would be the derived number the docstring above forbids.
 */
export function assignmentChanged(assignment: AssignmentView): void {
  for (const listener of [...listeners]) listener(assignment);
}

function defaultSubscribe(on: (assignment: AssignmentView) => void): () => void {
  listeners.add(on);
  return () => { listeners.delete(on); };
}

export interface AssignedToMeDeps {
  load?: () => Promise<AssignmentInboxPage>;
  subscribe?: AssignmentSubscribe;
  /**
   * This browser's own user id.
   *
   * `undefined` until `GET /v1/me` answers, and an unknown reader matches
   * NOBODY — the same rule `assignmentParty` states: *"an unknown reader is
   * a bystander, never a party"*. Without the comparison, every assignment
   * made anywhere in the workspace would cost every open tab a read.
   */
  meId?: string;
}

/**
 * Reads the inbox now, and re-reads it when the socket says something
 * addressed to this person changed. Returns an unsubscribe.
 *
 * ## It starts in `loading`, never in `ready` with a zero
 *
 * The first state a caller ever sees is `loading`. A hook that initialised
 * to `{ status: 'ready', count: 0 }` would render "nothing is waiting for
 * you" for the whole of the first read, which is a claim it cannot support
 * and which is indistinguishable from the truthful empty case.
 *
 * ## One read in flight at a time, with a trailing re-read
 *
 * Three frames in a second must not become three requests. A frame that
 * arrives while a read is in flight sets a flag; the read that is running
 * re-runs once when it settles. Dropping it instead would leave the counter
 * one behind whenever a push landed mid-read, which is the shape a person
 * only notices when the number is wrong.
 */
export function watchAssignedToMe(
  onChange: (state: AssignedToMe) => void,
  deps: AssignedToMeDeps = {},
): () => void {
  const load = deps.load ?? getMyInbox;
  const subscribe = deps.subscribe ?? defaultSubscribe;
  let stopped = false;
  let inFlight = false;
  let again = false;

  onChange({ status: 'loading' });

  const read = (): void => {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    load().then(
      (page) => {
        if (!stopped) {
          onChange({
            status: 'ready',
            count: page.items.length,
            capped: page.capped,
            matters: [...new Set(page.items.map(i => i.matterName))],
          });
        }
      },
      (e: unknown) => {
        if (stopped) return;
        // SAID, with the reason. `describeLoadError` is the one classifier
        // every load path in this app uses; a bespoke sentence here would be
        // a second wording for "your firm's service could not be reached".
        onChange({
          status: 'error',
          message: describeLoadError(
            e, 'LexPrompt could not read what has been asked of you.'),
        });
      },
    ).finally(() => {
      inFlight = false;
      if (again && !stopped) { again = false; read(); }
    });
  };

  read();

  const off = subscribe((assignment) => {
    // ADDRESSED TO ME, or nothing happens. The frame carries the whole row
    // because the socket's subscription is a REVIEW and has no per-recipient
    // filter — so without this guard every assignment between two other
    // people in the workspace would cost this tab a request.
    if (!deps.meId || assignment.assigneeUserId !== deps.meId) return;
    read();
  });

  return () => {
    stopped = true;
    off();
  };
}
