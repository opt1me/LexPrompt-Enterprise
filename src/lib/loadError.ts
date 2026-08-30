import { ModelError, type RunView } from '@lexprompt/core';
import { DbBlockedError, DbOpenTimeoutError } from './db/open';
import { UnconvertedPlaybookError } from './db/playbookMigration';

/** The classification half of every "load X, show an honest error instead
 *  of an empty list" call site in App.tsx: a `DbBlockedError` already
 *  carries its own explanatory, user-facing message (another tab has the
 *  database open); anything else is an opaque IndexedDB failure the user
 *  can't diagnose, so it falls back to a subject-specific generic message.
 *
 *  Extracted because this exact ternary was hand-copied at seven call sites
 *  (`App.tsx`'s matters/library/matter/documents/reviews/review/playbook
 *  loaders) — the sixth instance of this project's sibling-drift pattern.
 *  Each call site keeps its own `useState` and its own reset; only the
 *  classification itself (and its one hard-coded fallback string) is
 *  shared here, so this is a pure function, not a hook — nothing here
 *  changes what state exists or when it resets.
 *
 *  `UnconvertedPlaybookError` joins `DbBlockedError` on the pass-through
 *  side for the same reason: it names a specific, recoverable situation
 *  ("reload the page to finish the upgrade") that the generic message
 *  cannot, and it is raised precisely where a generic message would leave
 *  the user retrying something that will keep failing.
 *
 *  `DbOpenTimeoutError` joins them on the same test: it names the one
 *  situation where nothing failed and nothing succeeded — the database
 *  simply never answered — and its message exists to say the thing the
 *  generic fallback cannot, that the data has not been lost. Without this
 *  line the backstop still fails loudly and still offers a Retry, but the
 *  wording that makes a 30-second silence intelligible never reaches the
 *  screen.
 *
 *  A `ModelError` joins them, and for the same reason each of the others is
 *  here: it already carries a specific, user-facing message that the generic
 *  fallback cannot produce. "This needs the partner role" and "you are not
 *  signed in" and "LexPrompt could not reach your firm's service" are three
 *  different instructions, and folding any of them into "the matters could
 *  not be loaded. Try again." would leave a reader retrying something that
 *  will keep failing — which is the failure `DbBlockedError` was added here
 *  to prevent, one transport later.
 *
 *  The fourth load state, `stale`, arrives with realtime in Stage 4 and is
 *  deliberately NOT here: nothing in Stage 2 can be stale, because nothing
 *  pushes. */
export function describeLoadError(e: unknown, fallback: string): string {
  if (
    e instanceof DbBlockedError
    || e instanceof UnconvertedPlaybookError
    || e instanceof DbOpenTimeoutError
    || e instanceof ModelError
  ) return e.message;
  return fallback;
}

/**
 * HOW A RUN ENDED — the fourth fact a run has, which is neither a load
 * error nor a success.
 *
 * `describeLoadError` above gains nothing from Stage 3: a failed READ is a
 * failed read whatever it was reading. What is new is that a RUN can end in
 * a way that is not an error and not a success, and the two must not
 * collapse into one sentence:
 *
 *  - `cancelled` — a person asked it to stop. Rendered CALMLY. Everything
 *    already completed stays completed, and a reviewer is entitled to the
 *    twelve findings a stopped run produced; calling that a failure would
 *    tell them their work is suspect when it is not.
 *  - `failed` — it stopped WITHOUT being asked: a reaped heartbeat, or a
 *    fatal error. It says why, from the run's own `error`, because a run
 *    that failed and cannot say why is a run nobody can act on.
 *  - `succeeded` — over, and there is nothing to say about the ENDING. A
 *    cell in `error` is a finding a person can retry; the run itself is
 *    fine. `null` rather than a cheerful notice, so a completed run's
 *    screen is the findings and not a banner.
 *
 * This is the same rule `Finding.status`'s `cancelled` already follows, one
 * level up: 'cancelled' is distinct from 'error' and is never rendered as a
 * failure.
 *
 * The COUNTS travel with it because a partial run must never read as a
 * complete one — "12 of 40" is a fact the reader is entitled to, and a
 * `state` alone cannot carry it.
 *
 * ## WHY THE COUNT IS `done` ALONE
 *
 * It was `done + error`, and that made the sentence say the opposite of what
 * the paragraph above promises. The reaper's `failRunCells` moves EVERY
 * remaining `queued` and `leased` cell to `error`, so for any reaped run
 * `done + error === total` — and a run that died after three of forty
 * clauses told the reader *"40 of 40 clauses were reviewed"*, in the one
 * branch the count was written for. Thirty-seven of those were never
 * attempted, and their own cards say so.
 *
 * `done` is the number of clauses that produced an answer. A cell in `error`
 * was not reviewed: either it was never started (the reaper wrote the state
 * and the cause) or it was tried and produced no finding a reader can act on
 * beyond the error itself. Counting it as reviewed is the same collapse in
 * miniature that this whole function exists to prevent.
 *
 * The `cancelled` branch takes the same count for the same reason, though it
 * was already honest by accident: a cancel moves pending cells to
 * `cancelled`, not `error`, so `error` there is only ever a cell that really
 * failed mid-run — which is still not a clause that was reviewed.
 */
export function describeRunEnding(
  run: Pick<RunView, 'state' | 'error' | 'cells'>,
): { message: string; tone: 'error' | 'info' } | null {
  const done = run.cells.done;
  const of = `${done} of ${run.cells.total} ${run.cells.total === 1 ? 'clause' : 'clauses'}`;
  if (run.state === 'cancelled') {
    return {
      message: `This review was stopped. ${of} were reviewed, and those findings are unchanged.`,
      tone: 'info',
    };
  }
  if (run.state === 'failed') {
    return {
      message: run.error
        ? `This review stopped: ${run.error} ${of} were reviewed.`
        : `This review stopped before it finished. ${of} were reviewed.`,
      tone: 'error',
    };
  }
  return null;
}

/**
 * §3'S FOURTH LOAD STATE — and it is a SIBLING of `describeLoadError`, not a
 * branch inside it.
 *
 * `describeLoadError` is a function over an ERROR. `stale` is not an error:
 * nothing failed, nothing is broken, and a reviewer told the review failed
 * to load will reload a review that is fine. What `stale` says is narrower
 * and worse — **the app cannot vouch for what is on screen** — and §19 calls
 * that "the defect this design is most likely to ship in the app", because a
 * live view that has quietly stopped being live looks exactly like a quiet
 * review.
 *
 * ## Why the wording lives here rather than in the components
 *
 * Four surfaces say it: the persistent banner, the disposition controls, the
 * notes box and the net-position panel. `verificationLabel`'s lesson is that
 * four callers is three more than it takes for a second copy to appear, and
 * the copy that drifts is always the one nobody was looking at.
 */

/** The banner. PERSISTENT and NON-MODAL: a reviewer reading a finding must
 *  be able to keep reading it, and a toast that fades leaves the app looking
 *  normal while it is not — which is the entire defect §19 names. */
export const STALE_NOTICE =
  'LexPrompt has lost touch with this review. What is on screen is what was last '
  + 'received, and it is no longer being updated.';

/** What a dead control says, and it is DISABLED rather than hidden: a hidden
 *  control is indistinguishable from a finding that cannot be verified (the
 *  `isVerifiable` case, which already hides them). Disabled-with-a-reason is
 *  the only rendering that says "you may do this, but not right now, and
 *  here is why." */
export const STALE_CONTROL_NOTICE =
  'LexPrompt has lost touch with this review. Your judgement would not be saved '
  + 'against a state anyone can vouch for, so this is unavailable until the '
  + 'connection is back.';

/** During a resync — the events between the cursor and now are gone, so the
 *  screen is being re-read rather than merely waited on. A different fact
 *  from `stale` and it says so. */
export const RESYNCING_NOTICE = 'Reconnecting — refreshing this review…';

/**
 * WHY `stale` IS NOT `busy`, stated where both are read.
 *
 * `busy` means YOUR write is in flight and will land. `stale` means the app
 * cannot vouch for what is on screen, and a change submitted against a
 * version that may be minutes old would be refused anyway (§8). Rendering
 * the two identically would tell a reviewer to wait for something that is
 * not coming.
 */
export function controlDisabledReason(
  { busy, stale }: { busy?: boolean; stale?: boolean },
): string | undefined {
  if (stale) return STALE_CONTROL_NOTICE;
  if (busy) return undefined;
  return undefined;
}
