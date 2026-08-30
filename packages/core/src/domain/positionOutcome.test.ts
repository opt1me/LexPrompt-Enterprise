import { describe, expect, it } from 'vitest';
import { normalisePositionOutcome, NO_RATIONALE_NOTE } from './positionOutcome.ts';
import type { StandardPosition } from './types.ts';

const position: StandardPosition = { text: 'We ask for 6 months', origin: 'authored', reviewedByHuman: true };

describe('normalisePositionOutcome', () => {
  it('yields no outcome at all when the clause has no standard position', () => {
    const out = normalisePositionOutcome(undefined, 'meets', 'because');
    expect('positionOutcome' in out).toBe(false);
    expect('positionRationale' in out).toBe(false);
  });

  it('passes a well-formed meets through', () => {
    expect(normalisePositionOutcome(position, 'meets', 'six months exactly'))
      .toEqual({ positionOutcome: 'meets', positionRationale: 'six months exactly' });
  });

  it('turns a missing outcome into unclear, never meets', () => {
    expect(normalisePositionOutcome(position, undefined, 'x').positionOutcome).toBe('unclear');
  });

  it('turns an unrecognised outcome into unclear, never meets', () => {
    expect(normalisePositionOutcome(position, 'satisfies', 'x').positionOutcome).toBe('unclear');
    expect(normalisePositionOutcome(position, null as never, 'x').positionOutcome).toBe('unclear');
    expect(normalisePositionOutcome(position, 42 as never, 'x').positionOutcome).toBe('unclear');
  });

  it('accepts a case-mismatched outcome from a loose-JSON model', () => {
    expect(normalisePositionOutcome(position, 'DEVIATES', 'shorter').positionOutcome).toBe('deviates');
  });

  it('turns deviates with no rationale into unclear and says why', () => {
    const out = normalisePositionOutcome(position, 'deviates', '   ');
    expect(out.positionOutcome).toBe('unclear');
    expect(out.positionRationale).toBe(NO_RATIONALE_NOTE);
  });

  it('leaves meets with no rationale as meets', () => {
    // Only `deviates` is downgraded: a deviation nobody can see the argument
    // for is not actionable, whereas an unexplained agreement asserts nothing
    // a reader would act on.
    const out = normalisePositionOutcome(position, 'meets', '');
    expect(out.positionOutcome).toBe('meets');
    expect(out.positionRationale).toBeUndefined();
  });

  it('never returns meets for any input the model did not clearly say meets', () => {
    for (const raw of [undefined, null, '', '  ', 'unknown', 'MEETS?', 0, [], {}]) {
      const out = normalisePositionOutcome(position, raw as never, 'r');
      expect(out.positionOutcome).not.toBe('meets');
    }
  });
});
