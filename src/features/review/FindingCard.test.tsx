import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlaybookClause, Finding } from '../../types';
import { FindingCard } from './FindingCard';
import { unconfirmedPosition } from '../../lib/netPosition';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUSE: PlaybookClause = { id: 'c1', title: 'Governing Law', extractPrompt: 'Extract the governing law clause.' };

function render(node: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, root };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(node: React.ReactElement): HTMLDivElement {
  const { container, root } = render(node);
  cleanup = () => { act(() => { root.unmount(); }); container.remove(); };
  return container;
}

function hasRetryButton(container: HTMLDivElement): boolean {
  return Array.from(container.querySelectorAll('button')).some(b => /retry/i.test(b.textContent || ''));
}

function doneFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'c1',
    status: 'done',
    summary: 'The agreement is governed by English law.',
    citations: [],
    verification: { state: 'unchecked' },
    notes: [],
    ...overrides,
  };
}

const baseProps = {
  clause: CLAUSE,
  onCiteClick: () => {},
  onRetry: () => {},
};

describe('FindingCard — interrupted prop (Important 1)', () => {
  it('a pending cell offers no Retry when the run is live (default/not interrupted)', () => {
    const container = mount(
      <FindingCard clause={CLAUSE} finding={undefined} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(container.textContent).toContain('Governing Law');
    expect(hasRetryButton(container)).toBe(false);
  });

  it('a running cell offers no Retry when the run is live (default/not interrupted)', () => {
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(container)).toBe(false);
  });

  it('a pending cell offers Retry when interrupted, and it calls onRetry with the clause id', () => {
    const onRetry = vi.fn();
    const container = mount(
      <FindingCard clause={CLAUSE} finding={undefined} onCiteClick={() => {}} onRetry={onRetry} interrupted />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetry).toHaveBeenCalledWith('c1');
  });

  it('a running cell offers Retry when interrupted, and it calls onRetry with the clause id', () => {
    const onRetry = vi.fn();
    const finding: Finding = { clauseId: 'c1', status: 'running', citations: [], verification: { state: 'unchecked' }, notes: [] };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={onRetry} interrupted />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetry).toHaveBeenCalledWith('c1');
  });

  it('error and cancelled cells keep offering Retry regardless of interrupted (unchanged behaviour)', () => {
    const errorFinding: Finding = { clauseId: 'c1', status: 'error', citations: [], error: 'boom', verification: { state: 'unchecked' }, notes: [] };
    const containerA = mount(
      <FindingCard clause={CLAUSE} finding={errorFinding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(containerA)).toBe(true);
    cleanup?.();

    const cancelledFinding: Finding = { clauseId: 'c1', status: 'cancelled', citations: [], verification: { state: 'unchecked' }, notes: [] };
    const containerB = mount(
      <FindingCard clause={CLAUSE} finding={cancelledFinding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(containerB)).toBe(true);
  });

  // Superseded by Task 10 (spec section 5 / definition-of-done #3): "a
  // verified finding [is unretriable]" was true when this test was written,
  // before `Verification` existed. Now the spec requires the opposite —
  // "re-running a clause resets its verification to unchecked and says
  // so" — and a `Verification` only ever exists on a `done` finding (the
  // only status `VerificationControls` renders for). Without a way to
  // retry a `done` finding, that reset rule would be dead code no user
  // action could ever reach. `interrupted` is irrelevant to it either way:
  // this Retry is offered unconditionally on `done`, live run or not.
  it('a done cell offers Retry unconditionally, so a verified finding can be re-run (Task 10)', () => {
    const finding: Finding = {
      clauseId: 'c1',
      status: 'done',
      citations: [],
      summary: 'ok',
      verification: { state: 'unchecked' },
      notes: [],
    };
    const notInterrupted = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(hasRetryButton(notInterrupted)).toBe(true);
    cleanup?.();

    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={() => {}} interrupted />,
    );
    expect(hasRetryButton(container)).toBe(true);
  });
});

describe('FindingCard verification and evidence', () => {
  it('always shows a state chip, including on an unchecked finding', () => {
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding({ verification: { state: 'unchecked' } })} />,
    );
    expect(container.textContent).toMatch(/unverified/i);
  });

  it('shows the quote text inline without any hover interaction', () => {
    const finding = doneFinding({
      citations: [{ quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 }],
    });
    const container = mount(<FindingCard {...baseProps} finding={finding} />);
    expect(container.textContent).toMatch(/Liability is capped at the Charges\./);
  });

  it('still drives the viewer highlight from a click, and says which document the quote came from', () => {
    const onCiteClick = vi.fn();
    // `doc-2`, deliberately not the first document a caller would guess:
    // a collection review's single finding carries citations from across the
    // collection, and the viewer cannot find a quote it is told to look for
    // in the wrong document.
    const finding = doneFinding({ citations: [{ quote: 'a quote here', documentId: 'doc-2' }] });
    const container = mount(<FindingCard {...baseProps} finding={finding} onCiteClick={onCiteClick} />);
    const button = Array.from(container.querySelectorAll('button')).find(b => /a quote here/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onCiteClick).toHaveBeenCalledWith(['a quote here'], 'doc-2');
  });
});

describe('FindingCard — net position (Task 8)', () => {
  it('renders nothing for a net position when the finding has none', () => {
    const container = mount(<FindingCard {...baseProps} finding={doneFinding()} />);
    expect(container.textContent).not.toMatch(/net position/i);
  });

  it('renders the net position ABOVE the evidence when present', () => {
    const finding = doneFinding({
      citations: [{ quote: 'Evidence quote here', documentId: 'doc-1' }],
      netPosition: unconfirmedPosition('The break notice is now 6 months.', [
        { documentId: 'doc-1', kind: 'original', effect: 'Sets a 12 month notice.', citations: [] },
      ]),
    });
    const container = mount(<FindingCard {...baseProps} finding={finding} />);
    const text = container.textContent || '';
    expect(text).toContain('The break notice is now 6 months.');
    expect(text.indexOf('Net position')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Net position')).toBeLessThan(text.indexOf('Evidence quote here'));
  });

  it('calls onConfirmNetPosition/onAmendNetPosition, and reflects netPositionBusy', () => {
    const onConfirmNetPosition = vi.fn();
    const finding = doneFinding({
      netPosition: unconfirmedPosition('x', [{ documentId: 'doc-1', kind: 'original', effect: 'e', citations: [] }]),
    });
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={finding}
        onConfirmNetPosition={onConfirmNetPosition}
        onAmendNetPosition={() => {}}
        netPositionBusy
      />,
    );
    const confirmButton = Array.from(container.querySelectorAll('button'))
      .find(b => /^\s*confirm\s*$/i.test(b.textContent || ''));
    expect(confirmButton).toBeTruthy();
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the variation trail from the card, showing every trail step', () => {
    const finding = doneFinding({
      netPosition: unconfirmedPosition('The break notice is now 6 months.', [
        { documentId: 'doc-1', kind: 'original', effect: 'Sets a 12 month notice.', citations: [] },
        { documentId: 'doc-2', kind: 'varies', effect: 'Cuts notice to 6 months.', citations: [] },
      ]),
    });
    const container = mount(<FindingCard {...baseProps} finding={finding} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const trailButton = Array.from(container.querySelectorAll('button'))
      .find(b => /variation trail/i.test(b.textContent || ''));
    expect(trailButton).toBeTruthy();
    act(() => { (trailButton as HTMLButtonElement).click(); });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('Sets a 12 month notice.');
    expect(dialog!.textContent).toContain('Cuts notice to 6 months.');
  });
});

/**
 * M3. The truncation warning read "This document exceeds the selected
 * model's context budget" — singular — on a finding derived from a whole
 * collection, because `extractCollectionClause` collapsed the filenames
 * `buildCollectionPrompt` had already collected down to a boolean. The
 * reviewer could not tell whether the deed of variation, the document they
 * grouped the collection to ask about, was the one that was cut. Spec
 * section 6: "The deed of variation was cut short" is actionable; "the text
 * was truncated" is not.
 */
describe('FindingCard — the truncation warning names what was cut', () => {
  it('names each truncated document when the finding records them', () => {
    const container = mount(
      <FindingCard
        clause={CLAUSE}
        finding={doneFinding({ truncated: true, truncatedDocuments: ['Deed of Variation.pdf', 'Lease.pdf'] })}
        onCiteClick={() => {}}
        onRetry={() => {}}
      />,
    );
    const text = container.textContent || '';
    expect(text).toContain('Deed of Variation.pdf');
    expect(text).toContain('Lease.pdf');
  });

  it('keeps the single-document wording when no names were recorded', () => {
    const container = mount(
      <FindingCard clause={CLAUSE} finding={doneFinding({ truncated: true })} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(container.textContent || '').toMatch(/this document exceeds/i);
  });

  it('shows no truncation warning at all when nothing was cut', () => {
    const container = mount(
      <FindingCard clause={CLAUSE} finding={doneFinding()} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    expect(container.textContent || '').not.toMatch(/context budget/i);
  });
});
