import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, textbox, type } from '../../test/mount';
import { VariationTrailModal, type TrailDocumentInfo } from './VariationTrailModal';
import { unconfirmedPosition } from '../../lib/netPosition';
import type { TrailStep } from '../../types';

const TRAIL: TrailStep[] = [
  {
    documentId: 'd1',
    kind: 'original',
    effect: 'Break on 12 months notice.',
    citations: [{ quote: 'either party may terminate on 12 months notice', documentId: 'd1' }],
  },
  {
    documentId: 'd2',
    kind: 'varies',
    effect: 'Notice period cut to 6 months.',
    citations: [{ quote: 'notice is reduced to 6 months', documentId: 'd2' }],
  },
];

const DOCS: Record<string, TrailDocumentInfo> = {
  d1: { name: 'Lease.pdf', documentDate: 1_600_000_000_000 },
  d2: { name: 'Deed of Variation.pdf' },
  // d3 deliberately absent — the "missing document" case.
};

// Anchored but whitespace-tolerant — see NetPositionPanel.test.tsx's own
// copy of this comment: the real button text is icon + " Confirm"/" Amend",
// and `buttonNamed` does not trim.
const CONFIRM_ONLY = /^\s*confirm\s*$/i;
const AMEND_ONLY = /^\s*amend\s*$/i;

function baseProps() {
  return {
    open: true,
    onClose: () => {},
    netPosition: unconfirmedPosition('Notice is now 6 months.', TRAIL),
    documents: DOCS,
    onConfirm: () => {},
    onAmend: () => {},
  };
}

describe('VariationTrailModal — one card per contributing document, in reading order', () => {
  it('labels each step ORIGINAL or VARIES with its document name and date where known', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    const text = container.textContent || '';
    expect(text).toMatch(/original/i);
    expect(text).toMatch(/varies/i);
    expect(text).toContain('Lease.pdf');
    expect(text).toContain(new Date(1_600_000_000_000).toLocaleDateString());
    // d2 has no date known — its name still appears, undated.
    expect(text).toContain('Deed of Variation.pdf');
  });

  it('renders steps in the trail\'s own order (original first, then each variation)', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    const text = container.textContent || '';
    expect(text.indexOf('Lease.pdf')).toBeLessThan(text.indexOf('Deed of Variation.pdf'));
    expect(text.indexOf('Break on 12 months notice.')).toBeLessThan(text.indexOf('Notice period cut to 6 months.'));
  });

  it('shows each step\'s effect and its quoted citations', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    const text = container.textContent || '';
    expect(text).toContain('Break on 12 months notice.');
    expect(text).toContain('either party may terminate on 12 months notice');
    expect(text).toContain('Notice period cut to 6 months.');
    expect(text).toContain('notice is reduced to 6 months');
  });
});

describe('VariationTrailModal — a missing document', () => {
  it('renders the step as unavailable rather than omitting it', () => {
    const trailWithGap: TrailStep[] = [
      ...TRAIL,
      { documentId: 'd3', kind: 'varies', effect: 'This document is unavailable and could not be reviewed.', citations: [] },
    ];
    const container = mount(
      <VariationTrailModal {...baseProps()} netPosition={unconfirmedPosition('x', trailWithGap)} />,
    );
    const text = container.textContent || '';
    // The step is present (its effect text shows) even though d3 has no entry in `documents`.
    expect(text).toContain('This document is unavailable and could not be reviewed.');
    expect(text).toMatch(/unavailable/i);
  });
});

describe('VariationTrailModal — the terminal card', () => {
  it('shows the net position with Confirm and Amend', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    expect(container.textContent).toContain('Notice is now 6 months.');
    expect(buttonNamed(container, CONFIRM_ONLY)).toBeTruthy();
    expect(buttonNamed(container, AMEND_ONLY)).toBeTruthy();
  });

  it('calls onConfirm from the terminal card', () => {
    const onConfirm = vi.fn();
    const container = mount(<VariationTrailModal {...baseProps()} onConfirm={onConfirm} />);
    click(buttonNamed(container, CONFIRM_ONLY));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not itself offer a "see the variation trail" link (it IS the trail)', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    expect(buttonNamed(container, /variation trail/i)).toBeFalsy();
  });
});

describe('VariationTrailModal — amending requires non-empty text (mirrors RejectReasonModal)', () => {
  it('keeps the amendment confirm button disabled on whitespace-only text', () => {
    const container = mount(<VariationTrailModal {...baseProps()} />);
    click(buttonNamed(container, AMEND_ONLY));
    const dialogs = container.querySelectorAll('[role="dialog"]');
    // The trail modal itself is not a `role="dialog"` (see Modal usage
    // below); the amend dialog is the only one.
    const amendDialog = Array.from(dialogs).find(d => /amend this position/i.test(d.textContent || ''))!;
    expect(amendDialog).toBeTruthy();
    type(textbox(amendDialog) as HTMLTextAreaElement, '   ');
    const confirmBtn = buttonNamed(amendDialog, /confirm amendment/i) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('calls onAmend with the typed text once confirmed', () => {
    const onAmend = vi.fn();
    const container = mount(<VariationTrailModal {...baseProps()} onAmend={onAmend} />);
    click(buttonNamed(container, AMEND_ONLY));
    const dialog = Array.from(container.querySelectorAll('[role="dialog"]')).find(d => /amend this position/i.test(d.textContent || ''))!;
    type(textbox(dialog) as HTMLTextAreaElement, 'Notice is actually 3 months.');
    click(buttonNamed(dialog, /confirm amendment/i));
    expect(onAmend).toHaveBeenCalledWith('Notice is actually 3 months.');
  });
});

describe('VariationTrailModal — busy disables the terminal card\'s actions', () => {
  it('disables Confirm and Amend while a write is in flight', () => {
    const container = mount(<VariationTrailModal {...baseProps()} busy />);
    expect((buttonNamed(container, CONFIRM_ONLY) as HTMLButtonElement).disabled).toBe(true);
    expect((buttonNamed(container, AMEND_ONLY) as HTMLButtonElement).disabled).toBe(true);
  });
});
