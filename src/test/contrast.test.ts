import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readTokens, contrastRatio, composite, resolveColour } from './tokens';

const tokens = readTokens(resolve(__dirname, '../index.css'));

/** Tier thresholds. `body` is WCAG AA for normal text; `chip` is AA for
 *  large/bold text and is what the 9.5px uppercase mono chips are held to
 *  because they are bold, letter-spaced and short. `decorative` is a
 *  documented FLOOR, not a WCAG grade: ink-5 on paper is 2.28:1 by design
 *  and is right for a timestamp and wrong for anything a reader must not
 *  miss (R-G19, R-GP4). Asserting it rather than exempting it is what stops
 *  a future palette edit pushing a timestamp to invisible.
 *
 *  `disabled` is a fourth tier with exactly one member (F3): ink-6 on card is
 *  1.74:1, and ink-6 is the disabled-glyph and page-number step — it may
 *  never carry text a reader needs, which is R-G19 one step further down.
 *  It is asserted rather than exempted for R-GP4's own reason. The two
 *  alternatives are worse: dropping ink-6 from PAIRS removes the guard
 *  altogether, and lowering `decorative` to 1.7 would stop it guarding
 *  ink-5, which has 0.08 of headroom. */
const MIN = { body: 4.5, chip: 3.0, decorative: 2.2, disabled: 1.7 } as const;

type Pair = [fg: string, bg: string, tier: keyof typeof MIN];

const PAIRS: Pair[] = [
  // Primary and prose ink on every surface it is used on.
  ['ink-1', 'paper', 'body'], ['ink-1', 'card', 'body'], ['ink-1', 'page', 'body'],
  ['ink-prose', 'paper', 'body'], ['ink-prose', 'card', 'body'], ['ink-prose', 'page', 'body'],
  ['ink-quote', 'card', 'body'], ['ink-quote', 'paper', 'body'],
  ['ink-2', 'paper', 'body'], ['ink-2', 'card', 'body'],
  ['ink-3', 'paper', 'body'], ['ink-3', 'card', 'body'],
  // Decorative-grade ink. Never used for a warning, a disclosure or a
  // failure — that rule is R-G19 and lives in review, not in arithmetic.
  ['ink-4', 'paper', 'chip'], ['ink-4', 'card', 'chip'],
  ['ink-5', 'paper', 'decorative'], ['ink-5', 'card', 'decorative'],
  ['ink-6', 'card', 'disabled'],
  // Action and human confirmation.
  ['accent', 'paper', 'body'], ['accent', 'card', 'body'], ['accent', 'accent-tint', 'chip'],
  // Asserted as a foreground, not parked in SURFACE_ONLY: that is what
  // stops accent-strong drifting back to an alias of accent and making
  // every primary-button hover a visual no-op (R-GP9).
  ['accent-strong', 'paper', 'body'], ['page', 'accent-strong', 'body'],
  // Risk, on the surfaces and washes each is used on.
  ['risk-high', 'paper', 'body'], ['risk-high', 'card', 'body'], ['risk-high', 'risk-high-tint', 'chip'],
  ['risk-med', 'paper', 'body'], ['risk-med', 'card', 'body'], ['risk-med', 'risk-med-tint', 'chip'],
  ['risk-low', 'paper', 'body'], ['risk-low', 'card', 'body'], ['risk-low', 'risk-low-tint', 'chip'],
  // Verification chips, each on the fill it sits in.
  ['state-verified', 'accent-tint', 'chip'],
  ['state-flagged', 'risk-med-tint', 'chip'],
  ['state-rejected', 'risk-high-tint', 'chip'],
  ['state-unchecked', 'chip-fill', 'chip'],
  // Position outcome chips sit on a transparent fill over card.
  ['outcome-meets', 'card', 'chip'],
  ['outcome-deviates', 'card', 'chip'],
  ['outcome-unclear', 'card', 'chip'],
  // Position health.
  ['health-held', 'card', 'chip'], ['health-conceded', 'card', 'chip'],
  ['health-untested', 'card', 'chip'], ['health-none', 'card', 'decorative'],
  // Net position.
  ['net-unconfirmed', 'card', 'body'], ['net-confirmed', 'card', 'body'],
  // Draft / suggested.
  ['draft', 'card', 'body'], ['draft', 'draft-tint', 'chip'],
  // Presence (Task 23): a colleague's initials, on the card the rail sits
  // on and on their own tint. Held to the chip floor on the tint because
  // that is what the marker is — two characters of mono at `text-pin`.
  ['presence', 'card', 'body'], ['presence', 'presence-tint', 'chip'],
  // Primary button: white text on the accent fill.
  ['page', 'accent', 'body'],
];

describe('token contrast', () => {
  for (const [fg, bg, tier] of PAIRS) {
    it(`${fg} on ${bg} clears the ${tier} floor (${MIN[tier]}:1)`, () => {
      const ratio = contrastRatio(fg, bg, tokens);
      expect(
        Number(ratio.toFixed(2)),
        `${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MIN[tier]);
    });
  }

  it('every semantic role in index.css is either exercised above or explicitly surface-only', () => {
    // A role nobody checks is a role that can drift. Surfaces, rules,
    // edges and the two highlight colours are not text pairs; everything
    // else must appear as a foreground somewhere in PAIRS.
    const SURFACE_ONLY = new Set([
      'canvas', 'paper', 'card', 'doc-gutter',
      'rule-soft', 'rule', 'rule-strong', 'chip-fill',
      'accent-tint', 'accent-edge',
      'risk-high-tint', 'risk-high-edge', 'risk-med-tint', 'risk-med-edge', 'risk-low-tint',
      'draft-tint', 'presence-tint', 'highlight-fill', 'highlight-edge',
      'redline-ins', 'redline-del', 'net-amended',
    ]);
    const exercised = new Set(PAIRS.map(([fg]) => fg));
    const missing = Object.keys(tokens.roles)
      .filter(name => !SURFACE_ONLY.has(name) && !exercised.has(name));
    expect(missing).toEqual([]);
  });
});

// `contrastRatio` only calls `composite()` when a resolved colour's alpha is
// below 1, so a broken blend (e.g. one that ignored alpha, or swapped which
// side gets weighted by `a`) could still leave most PAIRS passing — the
// wrong number can land on the same side of a floor as the right one. These
// test the arithmetic directly, with hand-checked expected values, so a
// regression here fails on its own rather than by accident through a ratio.
describe('composite', () => {
  it('blends a 50% foreground exactly halfway between the two colours', () => {
    expect(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }))
      .toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it('returns the foreground unchanged when it is fully opaque', () => {
    expect(composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }))
      .toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('returns the background unchanged when the foreground is fully transparent', () => {
    expect(composite({ r: 10, g: 20, b: 30, a: 0 }, { r: 200, g: 200, b: 200, a: 1 }))
      .toEqual({ r: 200, g: 200, b: 200, a: 1 });
  });

  it('weights the two colours by alpha, not evenly, for an arbitrary alpha', () => {
    // fg 9% over bg: result should sit 9% of the way from bg toward fg.
    const result = composite({ r: 20, g: 87, b: 79, a: 0.09 }, { r: 255, g: 254, b: 251, a: 1 });
    expect(result).toEqual({
      r: Math.round(20 * 0.09 + 255 * 0.91),
      g: Math.round(87 * 0.09 + 254 * 0.91),
      b: Math.round(79 * 0.09 + 251 * 0.91),
      a: 1,
    });
    // Confirms the direction: blended must land strictly between the two
    // inputs, not equal to either — the failure mode a swapped weight or a
    // dropped (1 - a) term would produce.
    expect(result.r).toBeGreaterThan(20);
    expect(result.r).toBeLessThan(255);
  });

  it('resolves accent-tint to the declared 9% alpha before compositing', () => {
    // Guards resolveColour's own alpha extraction, which composite() and
    // every tint pair in PAIRS depend on: a mis-parsed alpha (e.g. reading
    // the wrong capture group) would silently change what every "on
    // *-tint" pair measures without composite() itself being at fault.
    const tint = resolveColour('accent-tint', tokens);
    expect(tint.a).toBeCloseTo(0.09, 5);
    expect(tint.a).toBeLessThan(1);
  });
});

