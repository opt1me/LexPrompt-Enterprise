import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, buttonNamed, click, textbox, type } from '../../test/mount';
import { NetPositionPanel } from './NetPositionPanel';
import { unconfirmedPosition, confirmPosition, amendPosition } from '@lexprompt/core';
import type { TrailStep } from '../../types';

const TRAIL: TrailStep[] = [
  { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
  { documentId: 'd2', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [] },
];

// Anchored but whitespace-tolerant: the real button text is icon + a text
// node like " Confirm" (a leading space from the JSX between them), and
// `buttonNamed` matches raw `textContent` with no trimming — an exact
// `/^confirm$/i` would never match the real button. This still refuses to
// match "Confirm amendment", which a bare `/confirm/i` would not.
const CONFIRM_ONLY = /^\s*confirm\s*$/i;
const AMEND_ONLY = /^\s*amend\s*$/i;

describe('NetPositionPanel — absence (no net position renders nothing)', () => {
  it('renders nothing at all when the finding has no net position', () => {
    const container = mount(
      <NetPositionPanel netPosition={undefined} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('NetPositionPanel — states', () => {
  it('an unconfirmed position visibly says so, with no interaction', () => {
    const container = mount(
      <NetPositionPanel
        netPosition={unconfirmedPosition('Rent is fixed at £10,000 p.a.', TRAIL)}
        onConfirm={() => {}}
        onAmend={() => {}}
      />,
    );
    expect(container.textContent).toMatch(/unconfirmed/i);
  });

  it('a confirmed position shows that a person confirmed it, and when', () => {
    const confirmed = confirmPosition(unconfirmedPosition('Rent is fixed at £10,000 p.a.', TRAIL), 'u1', 1_700_000_000_000);
    const container = mount(
      <NetPositionPanel netPosition={confirmed} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(container.textContent).toMatch(/confirmed/i);
    // "by you", never the stored id — see the attribution describe below.
    expect(container.textContent).toContain('Confirmed by you');
    expect(container.textContent).not.toContain('u1');
    expect(container.textContent).toContain(new Date(1_700_000_000_000).toLocaleDateString());
  });

  it('an amended position shows the human text and marks it amended by a person — stronger than confirmed', () => {
    const amended = amendPosition(unconfirmedPosition('Rent is fixed at £10,000 p.a.', TRAIL), 'Rent is now £12,000 p.a.', 'u1', 5);
    const container = mount(
      <NetPositionPanel netPosition={amended} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(container.textContent).toContain('Rent is now £12,000 p.a.');
    // The superseded model text must not be what's shown as the position.
    expect(container.textContent).not.toContain('Rent is fixed at £10,000 p.a.');
    expect(container.textContent).toMatch(/amended/i);
    // Not merely "confirmed" — amending is a stronger claim, with its own label.
    expect(buttons(container).some(b => CONFIRM_ONLY.test((b.textContent || '').trim()))).toBe(false);
  });
});

describe('NetPositionPanel — actions offered', () => {
  it('offers Confirm and Amend on an unconfirmed position', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(buttonNamed(container, /confirm/i)).toBeTruthy();
    expect(buttonNamed(container, /amend/i)).toBeTruthy();
  });

  it('offers only Amend (not Confirm) on an already-confirmed position', () => {
    const confirmed = confirmPosition(unconfirmedPosition('x', TRAIL), 'u1', 1);
    const container = mount(
      <NetPositionPanel netPosition={confirmed} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(buttons(container).some(b => CONFIRM_ONLY.test((b.textContent || '').trim()))).toBe(false);
    expect(buttonNamed(container, /amend/i)).toBeTruthy();
  });

  it('calls onConfirm when Confirm is clicked', () => {
    const onConfirm = vi.fn();
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} onConfirm={onConfirm} onAmend={() => {}} />,
    );
    click(buttonNamed(container, CONFIRM_ONLY));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onAmend with the typed text once the amend dialog is confirmed', () => {
    const onAmend = vi.fn();
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('model text', TRAIL)} onConfirm={() => {}} onAmend={onAmend} />,
    );
    click(buttonNamed(container, AMEND_ONLY));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    type(textbox(dialog!) as HTMLTextAreaElement, 'The human-corrected position.');
    click(buttonNamed(dialog!, /confirm amendment/i));
    expect(onAmend).toHaveBeenCalledWith('The human-corrected position.');
  });

  it('keeps the amend confirm button disabled on whitespace-only text (mirrors RejectReasonModal)', () => {
    const onAmend = vi.fn();
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('model text', TRAIL)} onConfirm={() => {}} onAmend={onAmend} />,
    );
    click(buttonNamed(container, AMEND_ONLY));
    const dialog = container.querySelector('[role="dialog"]')!;
    type(textbox(dialog) as HTMLTextAreaElement, '   ');
    const confirmBtn = buttonNamed(dialog, /confirm amendment/i) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });
});

describe('NetPositionPanel — busy disables everything', () => {
  it('disables Confirm and Amend while a write is in flight', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} busy onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect((buttonNamed(container, CONFIRM_ONLY) as HTMLButtonElement).disabled).toBe(true);
    expect((buttonNamed(container, AMEND_ONLY) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables "see the variation trail" while a write is in flight', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} busy onConfirm={() => {}} onAmend={() => {}} onOpenTrail={() => {}} />,
    );
    expect((buttonNamed(container, /variation trail/i) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NetPositionPanel — the trail link', () => {
  it('offers "See the variation trail" when there is a trail and a handler', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} onConfirm={() => {}} onAmend={() => {}} onOpenTrail={() => {}} />,
    );
    expect(buttonNamed(container, /variation trail/i)).toBeTruthy();
  });

  it('does not offer it when the trail is empty', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', [])} onConfirm={() => {}} onAmend={() => {}} onOpenTrail={() => {}} />,
    );
    expect(buttonNamed(container, /variation trail/i)).toBeFalsy();
  });

  it('does not offer it when no handler was given, even with a trail', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} onConfirm={() => {}} onAmend={() => {}} />,
    );
    expect(buttonNamed(container, /variation trail/i)).toBeFalsy();
  });

  it('calls onOpenTrail when clicked', () => {
    const onOpenTrail = vi.fn();
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} onConfirm={() => {}} onAmend={() => {}} onOpenTrail={onOpenTrail} />,
    );
    click(buttonNamed(container, /variation trail/i));
    expect(onOpenTrail).toHaveBeenCalledTimes(1);
  });
});

describe('NetPositionPanel — optional handlers (preview contexts)', () => {
  it('shows the position and its state with no controls when neither handler is given', () => {
    const container = mount(
      <NetPositionPanel netPosition={unconfirmedPosition('x', TRAIL)} />,
    );
    expect(container.textContent).toMatch(/unconfirmed/i);
    expect(buttons(container)).toHaveLength(0);
  });
});

// Found by driving the real app in sub-project C's browser verification:
// the panel printed "Confirmed by vzcsj71fs7mtalycwr on ..." at the reader.
// It was the last place in the product showing a raw user id — the same
// defect `noteLines` had already been fixed for on the export side, and for
// the same two reasons: an opaque id communicates nothing, and a per-person
// id implies the multi-user collaboration ruling R1 says this app must not
// pretend to offer.
describe('NetPositionPanel — attribution never shows a raw user id', () => {
  const confirmed = {
    proposed: 'Six months notice.',
    state: 'confirmed' as const,
    byUserId: 'vzcsj71fs7mtalycwr',
    at: 1756300205000,
    trail: [],
  };

  it('says "Confirmed by you", not the stored user id', () => {
    const c = mount(<NetPositionPanel netPosition={confirmed} onOpenTrail={() => {}} />);
    expect(c.textContent).toContain('Confirmed by you');
    expect(c.textContent).not.toContain('vzcsj71fs7mtalycwr');
  });

  it('says "Amended by you" for a position a person rewrote', () => {
    const c = mount(<NetPositionPanel netPosition={{ ...confirmed, amended: 'My wording.' }} onOpenTrail={() => {}} />);
    expect(c.textContent).toContain('Amended by you');
    expect(c.textContent).not.toContain('vzcsj71fs7mtalycwr');
  });

  it('drops the actor entirely when none was recorded, rather than saying "an unknown user"', () => {
    // "an unknown user" reads as "somebody else" — the exact implication R1
    // forbids when there is only ever one local person.
    const { byUserId: _omit, ...noAuthor } = confirmed;
    const c = mount(<NetPositionPanel netPosition={noAuthor} onOpenTrail={() => {}} />);
    expect(c.textContent).toContain('Confirmed on');
    expect(c.textContent).not.toMatch(/unknown user/i);
    expect(c.textContent).not.toContain('by you');
  });
});
