import { describe, it, expect } from 'vitest';
import {
  unconfirmedPosition, confirmPosition, amendPosition, resetPosition,
  positionText, NetPositionError,
} from './netPosition';
import type { TrailStep } from '../types';

const trail: TrailStep[] = [
  { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
  { documentId: 'd2', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [] },
];

describe('unconfirmedPosition', () => {
  it('starts unconfirmed, with no attribution', () => {
    const p = unconfirmedPosition('Break on 6 months notice.', trail);
    expect(p.state).toBe('unconfirmed');
    expect(p.byUserId).toBeUndefined();
    expect(p.at).toBeUndefined();
    expect(p.trail).toHaveLength(2);
  });

  it('does not invent an amendment', () => {
    expect('amended' in unconfirmedPosition('x', trail)).toBe(false);
  });
});

describe('confirmPosition', () => {
  it('records who and when', () => {
    const p = confirmPosition(unconfirmedPosition('x', trail), 'u1', 99);
    expect(p).toMatchObject({ state: 'confirmed', byUserId: 'u1', at: 99 });
  });

  it('keeps the trail — the argument survives the conclusion being accepted', () => {
    expect(confirmPosition(unconfirmedPosition('x', trail), 'u1', 99).trail).toHaveLength(2);
  });
});

describe('amendPosition', () => {
  it('stores the human text and marks it confirmed — a person wrote it', () => {
    const p = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 5);
    expect(p.amended).toBe('human text');
    expect(p.state).toBe('confirmed');
    expect(p.byUserId).toBe('u1');
  });

  it('keeps `proposed` so the trail can show what was changed', () => {
    const p = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 5);
    expect(p.proposed).toBe('model text');
  });

  it('refuses an empty or whitespace-only amendment', () => {
    const p = unconfirmedPosition('model text', trail);
    expect(() => amendPosition(p, '', 'u1', 5)).toThrow(NetPositionError);
    expect(() => amendPosition(p, '   ', 'u1', 5)).toThrow(NetPositionError);
  });

  it('trims what it stores', () => {
    expect(amendPosition(unconfirmedPosition('m', trail), '  h  ', 'u1', 5).amended).toBe('h');
  });
});

describe('positionText', () => {
  it('prefers the human amendment over the model proposal', () => {
    const p = amendPosition(unconfirmedPosition('model', trail), 'human', 'u1', 1);
    expect(positionText(p)).toBe('human');
  });

  it('falls back to the proposal when unamended', () => {
    expect(positionText(unconfirmedPosition('model', trail))).toBe('model');
  });
});

describe('resetPosition', () => {
  it('returns to unconfirmed and drops attribution', () => {
    const p = resetPosition(confirmPosition(unconfirmedPosition('m', trail), 'u1', 1));
    expect(p.state).toBe('unconfirmed');
    expect(p.byUserId).toBeUndefined();
    expect('at' in p).toBe(false);
  });

  it('drops a human amendment too — it described superseded synthesis', () => {
    const amended = amendPosition(unconfirmedPosition('m', trail), 'human', 'u1', 1);
    expect('amended' in resetPosition(amended)).toBe(false);
  });
});
