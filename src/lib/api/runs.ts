import type { AppEvent, RetryResult, RunView } from '@lexprompt/core';
import { apiGet, apiGetOrNull, apiSend } from './client';
import { onConnectionState, subscribe } from './socket';

/**
 * The browser's run client — Task 17. **The browser asks about a run instead
 * of performing one.**
 *
 * Every function here goes through `src/lib/api/client.ts`, Stage 2's one
 * HTTP transport, which owns the token, the base URL and the `ModelError`
 * classification. This module adds none of its own: a second place deciding
 * what a 401 means is the drift that transport exists to close.
 */

/** Starts a run over the whole review. The response is the RUN, not the
 *  results — a forty-cell review against a five-minute-per-cell model is not
 *  a request anybody can hold open. */
export const startRun = (reviewId: string): Promise<RunView> =>
  apiSend<RunView>('POST', `/v1/reviews/${encodeURIComponent(reviewId)}/runs`, {});

export const getRun = (runId: string): Promise<RunView> =>
  apiGet<RunView>(`/v1/runs/${encodeURIComponent(runId)}`);

/**
 * A person asked it to stop, which is NOT a failure. Everything already
 * completed stays completed.
 */
export const cancelRun = (runId: string): Promise<RunView> =>
  apiSend<RunView>('POST', `/v1/runs/${encodeURIComponent(runId)}/cancel`, {});

/**
 * This review's live run, or `null` when it has none.
 *
 * `null` is a fact about the review, not a failure to find it — the route
 * answers 200 with `null` rather than 404 for exactly that reason, and a
 * review that genuinely does not exist still rejects.
 */
export const liveRunFor = (reviewId: string): Promise<RunView | null> =>
  apiGetOrNull<RunView>(`/v1/reviews/${encodeURIComponent(reviewId)}/runs/live`);

/**
 * Re-runs ONE clause, and clears the judgement that described the answer
 * being replaced — in one transaction, server-side (Task 16).
 *
 * The response says WHAT it cleared, so the browser's notice is composed
 * from what the transaction actually did rather than from the browser's own
 * copy of the finding.
 */
export const retryCell = (
  reviewId: string, findingsKey: string, clauseId: string,
): Promise<RetryResult> => apiSend<RetryResult>(
  'POST',
  `/v1/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingsKey)}`
  + `/${encodeURIComponent(clauseId)}/retry`,
  {},
);

/** A run that has ended, whichever way. */
const TERMINAL = new Set(['succeeded', 'cancelled', 'failed']);

export function isRunOver(state: RunView['state']): boolean {
  return TERMINAL.has(state);
}

export interface WatchOptions {
  /**
   * Called when the cursor has fallen outside the retention window and the
   * events between it and now are gone. The caller must re-read the findings
   * map over HTTP; the watch then continues from the new cursor.
   *
   * A callback rather than a synthesised event, because there is no event
   * that says this — inventing one would put a fabricated entry into the
   * stream a reader's screen is built from.
   */
  onResync?: () => void;
  /** Milliseconds between polls. The knob, not the architecture — see below. */
  intervalMs?: number;
}

/**
 * Watches a run's events and calls `onEvent` for each, in order, keeping the
 * highest id it has applied. Returns an unsubscribe.
 *
 * ## THE SIGNATURE IS UNCHANGED, AND THAT IS THE WHOLE OF STAGE 3'S
 * ## INTERFACE NOTE 3
 *
 * Stage 3 said, in this file: *"Stage 4 replaces the transport INSIDE this
 * function and changes no caller — which is why the poll lives here rather
 * than in `App.tsx`."* This is that. `App.tsx`'s `attachRun` is not touched:
 * same four parameters, same `onEvent(event)`, same `onError(error)`, same
 * `options.onResync`, same returned `stop`.
 *
 * What has gone is `setTimeout` and `GET /v1/runs/:id/events`. What has
 * arrived is `subscribe({ run: runId }, …)` over the one socket this tab
 * holds (`src/lib/api/socket.ts`), where the cursor, the replay and the
 * `resync_required` frame are the same protocol the poll expressed over
 * HTTP.
 *
 * ## `onError` is now connection-state-driven, and it is not the same fact
 *
 * The poll called `onError` after three consecutive failures, because that
 * was the only way it could know anything was wrong. A socket knows
 * directly: `stale` means the client cannot vouch for what is on screen.
 * `onError` fires when the connection reaches `stale` while this watch is
 * running, which is the same sentence at the same moment for the same
 * reason — a run whose updates have stopped looking exactly like a run that
 * has stopped producing them.
 *
 * It fires ONCE per stale period, not on every frame of it: a notice
 * repeated every second is a notice nobody reads, which was the argument for
 * three strikes and is the argument for this.
 *
 * `options.intervalMs` is accepted and IGNORED, deliberately rather than
 * removed. It was the poll's knob; callers and tests that pass one should
 * not break, and a socket has no interval to set. Removing it from the type
 * would be a signature change, which is the one thing this function promised
 * not to make.
 */
export function watchRun(
  runId: string,
  onEvent: (event: AppEvent) => void,
  onError: (error: unknown) => void,
  options: WatchOptions = {},
): () => void {
  let stopped = false;
  let reported = false;

  const subscription = subscribe({ run: runId }, {
    onEvent(event) {
      if (stopped) return;
      onEvent(event);
      // The watch ends when the run does, exactly as the poll's did. The
      // caller's `onEvent` has already run, so the ending has been
      // delivered before the subscription goes.
      if (event.type === 'run.finished') stop();
    },
    onResync() {
      if (stopped) return;
      // Unchanged in meaning: the events between the cursor and now are
      // gone, and nothing is fabricated to fill the gap. `App.tsx` re-reads
      // the findings map AND the run itself.
      options.onResync?.();
    },
  });

  const offState = onConnectionState(next => {
    if (stopped) return;
    if (next === 'stale' && !reported) {
      reported = true;
      onError(new Error(
        'LexPrompt has lost touch with this review while it runs.'));
      return;
    }
    if (next === 'live') reported = false;
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    offState();
    subscription.close();
  }

  return stop;
}
