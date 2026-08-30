import type { AppEvent, EventPage, RetryResult, RunView } from '@lexprompt/core';
import { apiGet, apiGetOrNull, apiSend } from './client';
import { debug } from '../debug';

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

/** How many consecutive failed polls before the caller is told. */
const FAILURES_BEFORE_REPORTING = 3;

const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Polls `GET /v1/runs/:id/events?after=<cursor>` and calls `onEvent` for
 * each, in order, keeping the highest id it has applied. Returns an
 * unsubscribe.
 *
 * This is deliberately the SAME contract a WebSocket subscription will have
 * in Stage 4 (§8): subscribe, receive events in id order, keep a cursor, and
 * be told `resync_required` when the cursor falls outside the retention
 * window. Stage 4 replaces the transport INSIDE this function and changes no
 * caller — which is why the poll lives here rather than in `App.tsx` (P22).
 *
 * ## What it is NOT: the fourth load state
 *
 * `stale` is realtime's and arrives in Stage 4 (§3). A polling client that
 * misses a beat is not stale, it is one interval behind, and inventing a
 * stale indicator here would ship half of Stage 4's most easily-skipped
 * feature.
 *
 * ## A poll loop that dies quietly is rule 4 inverted
 *
 * Three consecutive failures call `onError`, and the caller shows it.
 * Without that, a run whose polling has stopped looks exactly like a run
 * that has stopped producing events — a job that died looking like a job
 * still working. THREE rather than one because a single failed poll over a
 * network is ordinary and self-correcting, and a notice on every hiccup is a
 * notice nobody reads.
 *
 * The poll stops on `run.finished`, which carries the ending. It does not
 * stop on an error: the next poll may succeed, and a watch that gave up on
 * the first failure would leave a live run unwatched with nothing said.
 */
export function watchRun(
  runId: string,
  onEvent: (event: AppEvent) => void,
  onError: (error: unknown) => void,
  options: WatchOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cursor = 0;
  let failures = 0;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, intervalMs);
  };

  async function poll(): Promise<void> {
    // One poll at a time. A slow response must not let a second request
    // overtake it and apply events out of order — the cursor is what keeps
    // the stream ordered, and two in flight would both read the same one.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const page = await apiGet<EventPage>(
        `/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`);
      failures = 0;

      if (page.resyncRequired) {
        // The events between the cursor and now are gone. Nothing is
        // fabricated to fill the gap: the caller re-reads the findings map,
        // which is the state those events described.
        debug('run event cursor fell outside the retention window; resyncing', runId);
        options.onResync?.();
      }

      for (const event of page.events) {
        if (stopped) return;
        // The cursor moves as each event is APPLIED, not once for the page:
        // an `onEvent` that throws must not advance past the event it could
        // not handle, or a reload would be the only way to see it again.
        onEvent(event);
        cursor = Math.max(cursor, event.id);
        if (event.type === 'run.finished') {
          stop();
          return;
        }
      }
      cursor = Math.max(cursor, page.nextCursor);
      // `hasMore` means the page was capped, not that the run is busy — poll
      // again immediately rather than waiting out the interval, or a run
      // that produced five hundred events would take five hundred seconds to
      // catch up.
      if (page.hasMore) {
        inFlight = false;
        void poll();
        return;
      }
    } catch (error) {
      failures += 1;
      debug('run event poll failed', runId, failures, error);
      if (failures >= FAILURES_BEFORE_REPORTING) {
        failures = 0;
        onError(error);
      }
    } finally {
      inFlight = false;
    }
    arm();
  }

  // The first poll goes out immediately rather than after an interval: a run
  // that has already finished (started in another tab, or before a reload)
  // should reach the screen now, not a second from now.
  void poll();

  return stop;
}
