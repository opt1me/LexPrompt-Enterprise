import React from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { RESYNCING_NOTICE, STALE_NOTICE } from '../lib/loadError';

export interface StalePanelProps {
  /**
   * `stale` — this client cannot vouch for what is on screen.
   * `resyncing` — the events between its cursor and now are gone, so the
   * screen is being re-read. Both are "not current"; only one of them is
   * being fixed right now, and telling a reader which is the whole of the
   * difference.
   */
  kind: 'stale' | 'resyncing';
}

/**
 * §3'S FOURTH LOAD STATE, ON SCREEN.
 *
 * ## Separate from `LoadErrorPanel`, deliberately
 *
 * `LoadErrorPanel` replaces the content it stands for and offers a Retry.
 * This does neither, and both differences matter:
 *
 *  - It sits ALONGSIDE the findings, which stay on screen. Blanking them is
 *    the other failure — a reviewer who loses their place because the wifi
 *    blinked. The rule is "never show disconnected data AS THOUGH IT WERE
 *    CURRENT", not "show nothing".
 *  - It offers no Retry, because there is nothing for a person to retry:
 *    the socket reconnects on its own backoff, and a button that does what
 *    is already happening teaches a reader that pressing it is what fixed
 *    it.
 *
 * A reviewer told the review failed to load will reload a review that is
 * fine. `stale` is not `error`, and a `describeLoadError` branch would have
 * collapsed them.
 *
 * ## Persistent, and non-modal
 *
 * §8: *"a persistent, non-modal stale indicator."* Non-modal because a
 * reviewer reading a finding must be able to keep reading it; persistent
 * because a toast that fades leaves the app looking normal while it is not,
 * which is the entire defect §19 names.
 *
 * ## Amber, not oxblood
 *
 * `--color-risk-med` already means "attention, not failure", which is
 * exactly what this is — nothing has gone wrong, the app simply cannot
 * promise the screen is current. Minting a role for one banner would put a
 * seventh colour in the palette for a state that already has a meaning.
 */
export function StalePanel({ kind }: StalePanelProps) {
  const resyncing = kind === 'resyncing';
  return (
    <div
      // `status`, not `alert`: this must not interrupt a screen reader
      // mid-sentence, for the same reason it is not a modal.
      role="status"
      aria-live="polite"
      data-stale={kind}
      className="flex items-start gap-2 rounded-card border border-risk-med-edge bg-risk-med-tint px-3 py-2"
    >
      {resyncing
        ? <RefreshCw className="w-4 h-4 mt-0.5 shrink-0 text-risk-med" aria-hidden="true" />
        : <WifiOff className="w-4 h-4 mt-0.5 shrink-0 text-risk-med" aria-hidden="true" />}
      <p className="font-ui text-ui-sm text-risk-med leading-relaxed">
        {resyncing ? RESYNCING_NOTICE : STALE_NOTICE}
      </p>
    </div>
  );
}
