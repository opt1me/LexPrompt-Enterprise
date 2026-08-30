import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlaybookClause, Finding, StandardPosition } from '../../types';
import { FindingCard } from './FindingCard';
import { unconfirmedPosition } from '@lexprompt/core';
import { dispositionLabel } from '../../lib/findingOutcome';
import {
  DISPOSITION_SHAPES, BY_A_STRANGER, TEST_AUDIENCE,
} from '../../test/dispositionShapes';

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

  // sr-only sweep (final behaviour review's leftover): Tailwind's `sr-only`
  // is `position: absolute`. With no positioned ancestor its containing
  // block is the document root, not the button it sits in — which is
  // exactly how one instance of this pattern extended the review screen to
  // 14,570px and produced a whole-window scrollbar over blank space. This
  // pins that the icon-only Retry button on a `done` card is its own
  // containing block, so the label can never escape it again.
  it('the icon-only Retry button on a done card is a positioned ancestor for its sr-only label', () => {
    const finding: Finding = {
      clauseId: 'c1', status: 'done', citations: [], summary: 'ok',
      verification: { state: 'unchecked' }, notes: [],
    };
    const container = mount(
      <FindingCard clause={CLAUSE} finding={finding} onCiteClick={() => {}} onRetry={() => {}} />,
    );
    const label = Array.from(container.querySelectorAll('span')).find(s => s.className === 'sr-only' && s.textContent === 'Retry');
    expect(label, 'expected an sr-only "Retry" label').toBeTruthy();
    expect(label!.parentElement!.tagName).toBe('BUTTON');
    expect(label!.parentElement!.className).toMatch(/(?:^|\s)relative(?:\s|$)/);
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

/**
 * Task 7. Three chips, three questions, never merged (spec §11): a
 * `PositionChip` (does this finding match the firm's own standard position?)
 * is a third, independent axis from `StateChip` (has a human checked this?)
 * and `RiskChip` (how risky is it?). The third test below is the one that
 * catches a merge — see this file's mutation test in the task report.
 */
describe('FindingCard — standard position comparison (Task 7)', () => {
  const pos: StandardPosition = {
    text: 'a 6-month break notice, no conditions.',
    origin: 'authored',
    reviewedByHuman: true,
  };

  it('shows the comparison above the evidence when the clause has a position', () => {
    const finding = doneFinding({
      summary: 'The lease gives 9 months.',
      citations: [{ quote: 'Evidence quote here', documentId: 'doc-1' }],
      positionOutcome: 'deviates',
      positionRationale: 'Nine months, not six.',
    });
    const container = mount(
      <FindingCard {...baseProps} clause={{ ...CLAUSE, standardPosition: pos }} finding={finding} />,
    );
    const html = container.innerHTML;
    expect(html).toContain('We ask for');
    // 'Evidence quote here' is the actual quote text `EvidenceList` renders
    // for this citation — its real marker, not an invented `data-testid`.
    expect(html.indexOf('We ask for')).toBeLessThan(html.indexOf('Evidence quote here'));
  });

  it('shows no comparison block for a clause with no position', () => {
    const container = mount(<FindingCard {...baseProps} finding={doneFinding()} />);
    expect(container.innerHTML).not.toContain('We ask for');
  });

  it('renders the position chip alongside the state and risk chips, not instead of them', () => {
    const finding = doneFinding({
      riskLevel: 'Medium',
      verification: { state: 'verified' },
      positionOutcome: 'deviates',
    });
    const container = mount(
      <FindingCard {...baseProps} clause={{ ...CLAUSE, standardPosition: pos }} finding={finding} />,
    );
    const text = container.textContent || '';
    expect(text).toMatch(/deviates/i);
    expect(text).toMatch(/verified/i);   // state chip survives
    expect(text).toMatch(/medium/i);     // risk chip survives
  });
});

/* ------------------------------------------------------------------ *
 *  STAGE 4 §18 item 5: every disposition on screen carries its actor   *
 *  and its time, and a changed one says so.                            *
 * ------------------------------------------------------------------ */

describe('FindingCard — the disposition names who set it and when', () => {
  it.each(Object.keys(DISPOSITION_SHAPES))('renders the "%s" shape with its own words', (what) => {
    const shape = DISPOSITION_SHAPES[what];
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        disposition={shape}
        audience={TEST_AUDIENCE}
      />,
    );
    // The card renders the ONE wording, rather than composing its own —
    // which is what keeps the card, the history panel and the two exporters
    // from drifting apart the way the DOCX and the CSV once did.
    expect(container.textContent).toContain(dispositionLabel(shape, TEST_AUDIENCE));
  });

  it('never renders a bare state with no actor for a disposition somebody set', () => {
    /*
     * THE MUTATION THIS EXISTS FOR: delete the label line from
     * `FindingCard` and keep the `StateChip`. The chip still says
     * "Verified", the card still looks finished, and this assertion is the
     * only thing that goes red.
     */
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding({ verification: { state: 'verified', byUserId: 'u2', at: 1 } })}
        disposition={DISPOSITION_SHAPES['verified after a rejection']}
        audience={TEST_AUDIENCE}
      />,
    );
    const text = container.textContent!;
    expect(text).toContain('Verified by R. Okafor');
    // Every "Verified" on this card is followed by an actor. The chip's own
    // word is "Verified" with nothing after it, so this also pins that the
    // chip is not the only thing saying so.
    const line = container.querySelector('[data-disposition-label]');
    expect(line).toBeTruthy();
    expect(line!.textContent).toMatch(/Verified by /);
  });

  it('names nobody for a never-touched finding, rather than whoever ran the review', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['never touched']}
        audience={TEST_AUDIENCE}
      />,
    );
    const line = container.querySelector('[data-disposition-label]')!;
    expect(line.textContent).toBe('Not checked');
    expect(line.textContent).not.toContain(' by ');
  });

  it('says a disposition it has not READ is unread, never "Not checked"', () => {
    // A card with no `disposition` prop at all — a preview, or a cell this
    // browser has not read. "Not checked" here would be a claim about a
    // lawyer's work made because a fetch had not happened.
    const container = mount(<FindingCard {...baseProps} finding={doneFinding()} />);
    const line = container.querySelector('[data-disposition-label]')!;
    expect(line.textContent).toMatch(/not read/i);
    expect(line.textContent).not.toBe('Not checked');
  });

  it('does not derive an actor from a Finding s verification — only from a disposition', () => {
    /*
     * RULE 1, RENDERED. A `Finding.verification` can carry a `byUserId`,
     * and a card that read it would put a name on screen because a name was
     * resolvable rather than because a disposition said so. The two are
     * given DIFFERENT people here, and the card must say what the
     * disposition says.
     */
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding({ verification: { state: 'verified', byUserId: 'u1', at: 1 } })}
        disposition={DISPOSITION_SHAPES['verified after a rejection']}
        audience={TEST_AUDIENCE}
      />,
    );
    const line = container.querySelector('[data-disposition-label]')!;
    expect(line.textContent).toContain('R. Okafor');
    expect(line.textContent).not.toContain('A. Trainee');
  });

  it('renders no actor line at all on a finding no judgement can attach to', () => {
    // `isVerifiable`, the same rule `VerificationControls` is gated on. A
    // pending or errored clause has no settled output for a judgement to be
    // about, so an attribution line there would be about nothing.
    for (const status of ['pending', 'running', 'error', 'cancelled'] as const) {
      const container = mount(
        <FindingCard
          {...baseProps}
          finding={{ clauseId: 'c1', status, citations: [], verification: { state: 'unchecked' }, notes: [] }}
          disposition={DISPOSITION_SHAPES['verified once']}
          audience={TEST_AUDIENCE}
        />,
      );
      expect(container.querySelector('[data-disposition-label]'), status).toBeNull();
      cleanup?.();
    }
  });

  it('shows the line even when the card cannot CHANGE a disposition', () => {
    // Attribution is information, not a control. A preview with no
    // `onVerify` still has to be honest about who checked the clause.
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['verified once']}
        audience={TEST_AUDIENCE}
      />,
    );
    expect(container.querySelector('[data-disposition-label]')!.textContent)
      .toContain('A. Trainee');
    // …and no verification controls, so this really is the no-write case.
    expect(Array.from(container.querySelectorAll('button')).some(
      b => /^verify$/i.test(b.textContent || ''))).toBe(false);
  });

  it('names nobody it cannot name, and never prints a raw id', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        disposition={BY_A_STRANGER}
        audience={TEST_AUDIENCE}
      />,
    );
    const text = container.textContent!;
    expect(text).toContain('someone this workspace does not name');
    expect(text).not.toContain(BY_A_STRANGER.disposition.byUserId!);
  });

  it('falls back to naming nobody when no audience is given, rather than throwing', () => {
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding()} disposition={DISPOSITION_SHAPES['verified once']} />,
    );
    const line = container.querySelector('[data-disposition-label]')!;
    expect(line.textContent).toContain('Verified by someone this workspace does not name');
    expect(line.textContent).not.toBe('');
  });

  it('distinguishes a re-run reset from a person clearing a verification', () => {
    // §6.3: the card must not flatten them.
    const rerun = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['cleared by a re-run']} audience={TEST_AUDIENCE} />,
    );
    const rerunText = rerun.querySelector('[data-disposition-label]')!.textContent;
    cleanup?.();
    const byHand = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['cleared by hand']} audience={TEST_AUDIENCE} />,
    );
    const byHandText = byHand.querySelector('[data-disposition-label]')!.textContent;
    expect(rerunText).not.toBe(byHandText);
    expect(rerunText).toContain('re-run');
  });

  it('says a contested clause has been changed more than twice', () => {
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['changed three times']} audience={TEST_AUDIENCE} />,
    );
    expect(container.querySelector('[data-disposition-label]')!.textContent)
      .toContain('changed 3 times');
  });
});

describe('FindingCard — the history, reachable in one action (§6.3)', () => {
  it('offers no opener on a disposition nobody has moved', () => {
    // A button that opened an empty panel would be an affordance for
    // nothing, and a reader clicking it would learn only that they had
    // wasted the click.
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['never touched']} audience={TEST_AUDIENCE} />,
    );
    expect(Array.from(container.querySelectorAll('button'))
      .some(b => /what changed/i.test(b.textContent || ''))).toBe(false);
  });

  it('offers one on a disposition somebody moved, and it is a real control', () => {
    // NOT a disabled button with a "coming soon" title: half a feature. The
    // panel exists, so the control opens it.
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={DISPOSITION_SHAPES['rejected with a reason']} audience={TEST_AUDIENCE} />,
    );
    const opener = Array.from(container.querySelectorAll('button'))
      .find(b => /what changed/i.test(b.textContent || ''));
    expect(opener).toBeTruthy();
    expect(opener!.disabled).toBe(false);
  });

  it('opens the history panel in ONE action, keyed by what the SERVER said', () => {
    const shape = DISPOSITION_SHAPES['rejected with a reason'];
    const container = mount(
      <FindingCard {...baseProps} finding={doneFinding()}
        disposition={shape} audience={TEST_AUDIENCE} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const opener = Array.from(container.querySelectorAll('button'))
      .find(b => /what changed/i.test(b.textContent || ''))!;
    act(() => { opener.click(); });
    // The panel is mounted. What it FETCHES is `DispositionHistory`'s own
    // suite's business; what matters here is that the card reaches it in one
    // click, from the ids the disposition itself carries rather than from a
    // document the viewer pane happens to be showing.
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('What changed, and who changed it');
    expect(shape.disposition.findingsKey).toBe('d1');
  });
});

/**
 * P36: A CHANGE THAT ARRIVES WHILE SOMEBODY IS MID-DECISION.
 *
 * `await-then-apply` says a reviewer never sees a state the store did not
 * take. It does not cover the inverse, which live change introduces: a state
 * the store DID take, swapped in under a person's hand while they are
 * deciding about the state it replaced. A partner's rejection landing while
 * the trainee is three words into a reject reason replaces the state the
 * reason is being written about, and the symptom is nothing — no error, no
 * flicker anyone would name, and a history row that reads as a considered
 * second opinion.
 */
function rerenderable(node: React.ReactElement): {
  container: HTMLDivElement; rerender: (next: React.ReactElement) => void;
} {
  const { container, root } = render(node);
  cleanup = () => { act(() => { root.unmount(); }); container.remove(); };
  return { container, rerender: (next) => { act(() => { root.render(next); }); } };
}

const verifiedByTrainee = DISPOSITION_SHAPES['verified once'];
const rejectedByOther = DISPOSITION_SHAPES['rejected with a reason'];

const label = (container: HTMLDivElement): string =>
  container.querySelector('[data-disposition-label]')!.textContent!;

const rejectButton = (container: HTMLDivElement): HTMLButtonElement =>
  Array.from(container.querySelectorAll('button')).find(b => /^Reject$/.test(b.textContent!.trim()))!;

describe('FindingCard — a change arriving mid-decision is held and announced (P36)', () => {
  const props = {
    ...baseProps,
    finding: doneFinding({ verification: { state: 'verified' as const, byUserId: 'u1', at: 1 } }),
    audience: TEST_AUDIENCE,
    onVerify: () => {},
  };

  it('applies an incoming change immediately when nothing is open and nothing is in flight', () => {
    // THE DEFAULT, first. A guard that became "hold everything" would make
    // the app feel broken, which is a second and quieter defect.
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} />);
    expect(label(container)).toContain('Verified by A. Trainee');
    rerender(<FindingCard {...props} disposition={rejectedByOther} />);
    expect(label(container)).toContain('Rejected by R. Okafor');
    expect(container.querySelector('[data-held-update]')).toBeNull();
  });

  it('holds an incoming change while the reject-reason modal is open, and announces it', () => {
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} />);
    act(() => { rejectButton(container).click(); });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    rerender(<FindingCard {...props} disposition={rejectedByOther} />);
    // NOT applied under the open control...
    expect(label(container)).toContain('Verified by A. Trainee');
    // ...but SAID, so nothing is hidden. Concealing it would leave a person
    // writing a rejection about a state that no longer exists.
    expect(container.querySelector('[data-held-update]')!.textContent)
      .toContain('R. Okafor changed this while you were writing');
  });

  it('applies the held change the moment the modal closes without submitting', () => {
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} />);
    act(() => { rejectButton(container).click(); });
    rerender(<FindingCard {...props} disposition={rejectedByOther} />);
    expect(label(container)).toContain('Verified by A. Trainee');

    const cancel = Array.from(container.querySelectorAll('button'))
      .find(b => /^Cancel$/.test(b.textContent!.trim()))!;
    act(() => { cancel.click(); });
    expect(label(container)).toContain('Rejected by R. Okafor');
    expect(container.querySelector('[data-held-update]')).toBeNull();
  });

  it('holds an incoming change while a write of THIS finding s disposition is in flight', () => {
    // The `busyKey` half of the guard. Delete that condition from
    // `mayApplyNow` and THIS is the case that goes red — the brief's own
    // Step 4 says a guard with an untested half is half a guard.
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} verifyBusy />);
    rerender(<FindingCard {...props} disposition={rejectedByOther} verifyBusy />);
    expect(label(container)).toContain('Verified by A. Trainee');
    expect(container.querySelector('[data-held-update]')!.textContent)
      .toContain('changed this while you were writing');

    rerender(<FindingCard {...props} disposition={rejectedByOther} />);
    expect(label(container)).toContain('Rejected by R. Okafor');
  });

  it('holds nothing when the same row arrives again under a different object', () => {
    // Every poll replaces the whole dispositions map, so the card is handed
    // a structurally identical but referentially new object constantly. An
    // identity comparison would announce a change nobody made, every few
    // seconds, at anyone who happened to be typing.
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} />);
    act(() => { rejectButton(container).click(); });
    rerender(<FindingCard {...props} disposition={structuredClone(verifiedByTrainee)} />);
    expect(container.querySelector('[data-held-update]')).toBeNull();
    expect(label(container)).toContain('Verified by A. Trainee');
  });

  it('submits the version it was SHOWING, so a judgement made against a held state is refused',
    () => {
      /*
       * The half of P36 that has no visible symptom at all.
       *
       * Holding the display is not enough on its own: the read that carried
       * the incoming change also moved `src/lib/api/findings.ts`'s version
       * cache, so a rejection submitted from the dialog would take the NEW
       * version, be accepted, and land on a state its author never read —
       * with no error, and a history row that reads as a considered second
       * opinion.
       *
       * Stating what was on screen means the store refuses it (Task 7) and
       * the person is told what replaced it. Mutation: drop `atVersion` in
       * `FindingCard`'s `onChange` and this goes red.
       */
      const seen: (number | undefined)[] = [];
      const onVerify = (_c: unknown, atVersion?: number) => { seen.push(atVersion); };
      const { container, rerender } = rerenderable(
        <FindingCard {...props} disposition={verifiedByTrainee} onVerify={onVerify} />);
      act(() => { rejectButton(container).click(); });
      rerender(
        <FindingCard {...props} disposition={rejectedByOther} onVerify={onVerify} />);

      const textarea = container.querySelector('textarea')!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value')!.set!;
      act(() => {
        setter.call(textarea, 'Cap is uncapped');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const confirm = Array.from(container.querySelectorAll('button'))
        .find(b => /Confirm rejection/.test(b.textContent!))!;
      act(() => { confirm.click(); });

      expect(seen).toEqual([verifiedByTrainee.disposition.version]);
      expect(seen[0]).not.toBe(rejectedByOther.disposition.version);
    });

  it('holds an incoming change while the KEYBOARD path s reject dialog is open for it', () => {
    // `ResultsView` mounts its own `RejectReasonModal` for `r`, which this
    // card cannot see. Without `rejectModalOpen` the guard would cover the
    // mouse path and silently not the keyboard one — the shape Critical 2
    // already cost this project once.
    const { container, rerender } = rerenderable(
      <FindingCard {...props} disposition={verifiedByTrainee} rejectModalOpen />);
    rerender(<FindingCard {...props} disposition={rejectedByOther} rejectModalOpen />);
    expect(label(container)).toContain('Verified by A. Trainee');
    expect(container.querySelector('[data-held-update]')).toBeTruthy();
  });
});

describe('a request one person made of another (§6.3, Task 25)', () => {
  const ASK = {
    id: 'as1', reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
    assigneeUserId: 'me', assignedByUserId: 'u1',
    message: 'Not sure the cap survives 14.2.', createdAt: 1,
  };

  it('shows the assigner and the message to the assignee, not just a badge', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="me"
        audience={TEST_AUDIENCE}
        assignments={[ASK]}
      />,
    );
    // A bare marker makes the assignee open every clause to find out what
    // was wanted.
    expect(container.textContent).toContain('asked you to look at this');
    expect(container.textContent).toContain('Not sure the cap survives 14.2.');
  });

  it('reads the other way round for the person who asked', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="u1"
        audience={TEST_AUDIENCE}
        assignments={[{ ...ASK, assigneeUserId: 'u2', assignedByUserId: 'u1' }]}
      />,
    );
    expect(container.textContent).toContain('You asked');
    expect(container.textContent).not.toContain('asked you to look at this');
  });

  /*
   * THE THIRD PERSON IN THE ROOM (C1).
   *
   * `assignment.created` is a REVIEW-scoped event, so the push reaches every
   * tab with the review open. The card's render was a binary — assignee, or
   * "you asked" — so a reader who was neither fell into the `else` and was
   * told, in the first person, that they had made a request they had never
   * heard of, under the message its real author wrote, beside a live
   * "Withdraw the request" button.
   *
   * That is `CLAUDE.md`'s R1 rule failing at Stage 4's one new surface: an
   * affordance offering an action on another person's act. There were two
   * cases in the code and three in the world.
   */
  it('tells a BYSTANDER nothing at all about a request between two other people', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="c-the-bystander"
        audience={TEST_AUDIENCE}
        assignments={[{ ...ASK, assigneeUserId: 'u2', assignedByUserId: 'u1' }]}
        onResolveAssignment={() => { /* … */ }}
      />,
    );
    // Not the sentence, not the message, and not the button.
    expect(container.textContent).not.toContain('You asked');
    expect(container.textContent).not.toContain('asked you to look at this');
    expect(container.textContent).not.toContain('Not sure the cap survives 14.2.');
    expect(container.textContent).not.toContain('Withdraw the request');
    expect(container.querySelector('[data-assignments]')).toBeNull();
  });

  it('says nothing in the assignee s own window before the profile has resolved', () => {
    // `localUserId={profile?.id ?? ''}` — for the frames before `GET /v1/me`
    // answers, this tab does not know whose it is. The old binary made the
    // REAL assignee's card read "You asked B. Trainee to look at this" during
    // exactly that window, because `mine` was false.
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId=""
        audience={TEST_AUDIENCE}
        assignments={[ASK]}
      />,
    );
    expect(container.textContent).not.toContain('You asked');
    expect(container.querySelector('[data-assignments]')).toBeNull();
  });

  it('offers Withdraw only to the asker and I have looked at this only to the assignee', () => {
    const asker = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="u1"
        audience={TEST_AUDIENCE}
        assignments={[{ ...ASK, assigneeUserId: 'u2', assignedByUserId: 'u1' }]}
        onResolveAssignment={() => { /* … */ }}
      />);
    expect(asker.textContent).toContain('Withdraw the request');
    expect(asker.textContent).not.toContain('I have looked at this');
    cleanup?.();
    cleanup = null;

    const assignee = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="me"
        audience={TEST_AUDIENCE}
        assignments={[ASK]}
        onResolveAssignment={() => { /* … */ }}
      />);
    expect(assignee.textContent).toContain('I have looked at this');
    expect(assignee.textContent).not.toContain('Withdraw the request');
  });

  it('offers the assign action only where there is somewhere to persist it', () => {
    const without = mount(
      <FindingCard {...baseProps} finding={doneFinding()} audience={TEST_AUDIENCE} />);
    expect(without.textContent).not.toContain('Ask a colleague');
    cleanup?.();
    cleanup = null;

    const withTarget = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        audience={TEST_AUDIENCE}
        assignTarget={{ reviewId: 'r1', findingsKey: 'd1' }}
        onAssigned={() => { /* … */ }}
      />);
    // A control that goes nowhere is worse than no control — the rule
    // `onVerify` already follows on this card.
    expect(withTarget.textContent).toContain('Ask a colleague to look at this');
  });

  it('keeps flagging and asking as TWO acts, reachable from one place', () => {
    const onVerify = vi.fn();
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        audience={TEST_AUDIENCE}
        onVerify={onVerify}
        assignTarget={{ reviewId: 'r1', findingsKey: 'd1' }}
        onAssigned={() => { /* … */ }}
      />);
    const ask = Array.from(container.querySelectorAll('button'))
      .find(b => /Ask a colleague/i.test(b.textContent ?? ''))!;
    act(() => { ask.click(); });
    /*
     * Opening the panel writes NO disposition. Flagging records a judgement
     * about the answer; assigning asks a person to look. Doing both in one
     * click would write a disposition the person may not have meant (§6.3),
     * and this is the assertion a later "flag and assign in one click" would
     * have to break deliberately.
     */
    expect(onVerify).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Ask a colleague to look at this');
  });

  it('goes dead while the client is stale, like every other human-authored write', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        audience={TEST_AUDIENCE}
        stale
        assignments={[ASK]}
        localUserId="me"
        assignTarget={{ reviewId: 'r1', findingsKey: 'd1' }}
        onAssigned={() => { /* … */ }}
        onResolveAssignment={() => { /* … */ }}
      />);
    const named = (re: RegExp) => Array.from(container.querySelectorAll('button'))
      .find(b => re.test(b.textContent ?? ''))!;
    // §3's list names an assignment explicitly. The findings stay on screen;
    // the controls that compose a write do not work.
    expect(named(/Ask a colleague/).disabled).toBe(true);
    expect(named(/I have looked at this/).disabled).toBe(true);
  });

  it('an assignment moves no state chip and names no judgement', () => {
    const container = mount(
      <FindingCard
        {...baseProps}
        finding={doneFinding()}
        localUserId="me"
        audience={TEST_AUDIENCE}
        assignments={[ASK]}
      />);
    // A request is not a disposition. The chip still says what the human
    // record says, and the request sentence carries no verdict of its own.
    const requestBlock = container.querySelector('[data-assignments]')!;
    expect(requestBlock.textContent).not.toMatch(/verified|rejected|flagged/i);
  });
});
