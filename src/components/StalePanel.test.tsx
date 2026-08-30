import { describe, it, expect } from 'vitest';
import { mount, buttons } from '../test/mount';
import { StalePanel } from './StalePanel';
import { LoadErrorPanel } from './LoadErrorPanel';
import { RESYNCING_NOTICE, STALE_NOTICE } from '../lib/loadError';

/**
 * §3'S FOUR LOAD STATES, RENDERED AS FOUR DISTINCT THINGS.
 *
 * The mutation this file exists for: make the stale branch fall through to
 * `LoadErrorPanel` and confirm the fourth case below fails. "Stale" is not
 * "broken", and a reviewer told the review failed to load will reload a
 * review that is fine — which is a worse outcome than the one they were
 * already in, because it loses their place as well.
 */

const Loading = () => <div className="p-8 font-ui text-ui text-ink-3">Loading review…</div>;
const Empty = () => <div className="p-8 font-ui text-ui text-ink-3">This review found nothing.</div>;

describe('the fourth load state renders as itself', () => {
  it('says the app has lost touch, and does not say anything failed', () => {
    const c = mount(<StalePanel kind="stale" />);
    expect(c.textContent).toContain('LexPrompt has lost touch with this review');
    expect(c.textContent).toContain('no longer being updated');
    // NOT an error. "Could not be loaded" would send a reviewer to reload a
    // review that is fine.
    expect(c.textContent).not.toMatch(/could not|failed|try again/i);
  });

  it('offers no Retry, because there is nothing for a person to retry', () => {
    // The socket reconnects on its own backoff. A button that does what is
    // already happening teaches a reader that pressing it is what fixed it.
    expect(buttons(mount(<StalePanel kind="stale" />))).toHaveLength(0);
  });

  it('says something DIFFERENT while it is refreshing', () => {
    const c = mount(<StalePanel kind="resyncing" />);
    expect(c.textContent).toContain('Reconnecting');
    expect(c.textContent).not.toBe(STALE_NOTICE);
    expect(c.textContent).toContain(RESYNCING_NOTICE);
  });

  it('is non-modal and polite, so a reader can keep reading', () => {
    const c = mount(<StalePanel kind="stale" />);
    const panel = c.querySelector('[data-stale]')!;
    expect(panel).toBeTruthy();
    // `status`, not `alert`: it must not interrupt a screen reader
    // mid-sentence, for the same reason it is not a dialog.
    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(c.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders stale, broken, empty and in-flight as FOUR distinct things', () => {
    const rendered = [
      mount(<Loading />).innerHTML,
      mount(<LoadErrorPanel message="This review could not be loaded." onRetry={() => {}} />).innerHTML,
      mount(<Empty />).innerHTML,
      mount(<StalePanel kind="stale" />).innerHTML,
    ];
    expect(new Set(rendered).size).toBe(4);
    // …and the sanity check that the comparison could ever fail: two renders
    // of the SAME state are equal, so the four above being distinct is a
    // fact about the components rather than about `innerHTML` never
    // matching.
    expect(mount(<StalePanel kind="stale" />).innerHTML)
      .toBe(mount(<StalePanel kind="stale" />).innerHTML);
  });

  it('is not the error panel wearing a different message', () => {
    // The specific collapse this guards: `stale` routed through
    // `LoadErrorPanel`. That panel offers a Retry and paints in oxblood;
    // this one does neither.
    const stale = mount(<StalePanel kind="stale" />).innerHTML;
    const error = mount(<LoadErrorPanel message={STALE_NOTICE} onRetry={() => {}} />).innerHTML;
    expect(stale).not.toBe(error);
    expect(stale).not.toContain('Retry');
    expect(error).toContain('Retry');
  });
});
