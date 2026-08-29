import React from 'react';

/**
 * What the app says, on every screen, while a firm's data is still in this
 * browser.
 *
 * ## Why a banner and not a modal (P15)
 *
 * A modal that can be dismissed once is a migration a person can lose. A
 * modal that cannot be dismissed is an app they cannot use while their data
 * is being moved — which, for a library of any size, is not a few seconds.
 * So this sits above the app, permanently, until there is nothing left for
 * it to say.
 *
 * ## The state that matters most is `unknown`
 *
 * `CLAUDE.md`'s opening list: *"a failed storage migration rendering an
 * empty library, indistinguishable from a fresh install."* A local database
 * that cannot be opened is exactly that situation at exactly that moment —
 * the person's matters may all still be there, and the app has no way to
 * tell. Rendering nothing would be the app deciding, on no evidence, that
 * there is nothing to move. So an unreadable database gets the LOUDEST of
 * the three states, carries `describeLoadError`'s own wording (which names
 * "close your other tabs" and "your data has not been lost" where those are
 * the true answers), and offers a retry.
 */

export type LocalDataBannerState =
  /** The database could not be opened or read. Never hidden. */
  | { kind: 'unknown'; message: string }
  /** Records are here and have not been moved yet. */
  | { kind: 'present'; total: number }
  /** A store or more could not be read, alongside whatever was. */
  | { kind: 'partial'; total: number; message: string }
  /** Everything moved. The copy is STILL HERE and the banner says so —
   *  Task 23, §13.1: a banner that vanishes is a person who never learns
   *  the copy is still in their browser. */
  | { kind: 'moved' };

export interface LocalDataBannerProps {
  state: LocalDataBannerState;
  /** Opens the uploader screen. Absent on `moved`, where there is nothing
   *  left to do. */
  onOpen?: () => void;
  /** Re-reads the local database. Present on `unknown` and `partial`. */
  onRetry?: () => void;
}

export function LocalDataBanner({ state, onOpen, onRetry }: LocalDataBannerProps) {
  if (state.kind === 'moved') {
    return (
      <div className="shrink-0 border-b border-rule bg-card px-6 py-2.5 flex items-center gap-4">
        <p className="font-ui text-ui-sm text-ink-3">
          Your data is on the server. A copy is still in this browser and will be removed in a
          later release.
        </p>
      </div>
    );
  }

  if (state.kind === 'unknown') {
    return (
      <div className="shrink-0 border-b border-risk-high-edge bg-risk-high-tint px-6 py-2.5 flex items-center gap-4">
        <p className="font-ui text-ui-sm text-risk-high flex-1">
          LexPrompt could not read the data stored in this browser, so it cannot tell you what is
          still here to move. {state.message}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 px-3 py-1.5 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  const noun = state.total === 1 ? 'item' : 'items';
  return (
    <div className="shrink-0 border-b border-rule bg-draft-tint px-6 py-2.5 flex items-center gap-4">
      <p className="font-ui text-ui-sm text-ink-2 flex-1">
        {state.kind === 'partial'
          ? `${state.total} ${noun} are still stored in this browser and have not been moved to your firm's server. Some of what is here could not be read at all: ${state.message}`
          : `${state.total} ${noun} are still stored in this browser and have not been moved to your firm's server.`}
      </p>
      {onOpen && (
        <button
          onClick={onOpen}
          className="shrink-0 px-3 py-1.5 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
        >
          Move it to the server
        </button>
      )}
      {state.kind === 'partial' && onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 px-3 py-1.5 rounded-control border border-rule-strong font-ui text-button text-ink-2 hover:bg-chip-fill"
        >
          Try again
        </button>
      )}
    </div>
  );
}
