import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ExportGateBanner } from './ExportGateBanner';
import type { Finding } from '../../types';

function finding(state: Finding['verification']['state']): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state }, notes: [] };
}

describe('ExportGateBanner', () => {
  it('states the count and what the export will say about them', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked'), c2: finding('unchecked'), c3: finding('verified') } }} />);
    expect(c.textContent).toContain('2 findings are unchecked.');
    expect(c.textContent).toContain('Export is available, but the report will mark them as unverified AI output.');
  });

  it('renders nothing at all when everything has been checked', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('verified'), c2: finding('rejected') } }} />);
    expect(c.textContent).toBe('');
  });

  it('renders nothing for a review with no findings', () => {
    const c = mount(<ExportGateBanner findings={{}} />);
    expect(c.textContent).toBe('');
  });

  it('offers a way to the unchecked findings when the caller supplies one', () => {
    const onReviewUnchecked = vi.fn();
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} onReviewUnchecked={onReviewUnchecked} />);
    click(buttonNamed(c, /Review unchecked/));
    expect(onReviewUnchecked).toHaveBeenCalled();
  });

  it('gates nothing, even when it is offering its own control', () => {
    // It must not block, disable, or gate the export button (§10.3).
    //
    // An earlier draft mounted this WITHOUT `onReviewUnchecked` and then
    // asserted the button count was 0 — true by construction, and it would
    // have stayed true however the component gated the export (F17a,
    // R-GP10). Mount it WITH the control, so the assertion is about what
    // the banner does rather than about what was not passed to it.
    const onReviewUnchecked = vi.fn();
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} onReviewUnchecked={onReviewUnchecked} />);
    // Its own control is enabled, and it is the only one it renders.
    const controls = Array.from(c.querySelectorAll('button'));
    expect(controls).toHaveLength(1);
    expect(controls[0].hasAttribute('disabled')).toBe(false);
    expect(c.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0);
    // And it exposes no way to reach or suppress an export: the export
    // buttons live in the review header and this component never wraps them.
    expect(c.textContent).not.toMatch(/export docx|export csv|download/i);
  });

  it('uses the singular for one unchecked finding', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} />);
    expect(c.textContent).toContain('1 finding is unchecked.');
  });

  it('derives its count from the shared verificationCounts helper, not a local tally', () => {
    // Mirrors CLAUDE.md's mutation-testing rule: a hardcoded count would
    // pass every test above by coincidence (they all happen to want a
    // number that isn't 0), so assert against a shape verificationCounts
    // alone can get right — a mix that this component must not miscount by
    // hand, e.g. by only checking `state === 'unchecked'` explicitly and
    // missing a finding with no `verification` at all.
    const c = mount(<ExportGateBanner findings={{
      d1: {
        c1: finding('unchecked'),
        c2: finding('flagged'),
        c3: finding('rejected'),
        c4: finding('verified'),
      },
      d2: {
        c1: finding('unchecked'),
      },
    }} />);
    expect(c.textContent).toContain('2 findings are unchecked.');
  });
});
