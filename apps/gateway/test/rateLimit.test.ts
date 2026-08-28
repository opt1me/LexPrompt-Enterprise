import { describe, it, expect } from 'vitest';
import { WindowRateLimiter } from '../src/rateLimit.ts';

const make = (over = {}) => {
  let clock = 1_000_000;
  const limiter = new WindowRateLimiter({
    requestsPerMinutePerActor: 3,
    requestsPerMinutePerWorkspace: 5,
    tokensPerHourPerActor: 100,
    tokensPerHourPerWorkspace: 200,
    now: () => clock,
    ...over,
  });
  return { limiter, advance: (ms: number) => { clock += ms; } };
};

describe('WindowRateLimiter', () => {
  it('allows requests up to the per-actor limit', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'a')).toThrowError(
      expect.objectContaining({ code: 'budget_exhausted', status: 429 }));
  });

  it('does not let one actor exhaust another actor\'s allowance', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'b')).not.toThrow();
  });

  it('enforces the workspace request limit across actors', () => {
    const { limiter } = make();
    for (const actor of ['a', 'b']) {
      for (let i = 0; i < 2; i++) { limiter.check('ws', actor); limiter.record('ws', actor, { promptTokens: 1, completionTokens: 0 }); }
    }
    limiter.check('ws', 'c'); limiter.record('ws', 'c', { promptTokens: 1, completionTokens: 0 });
    expect(() => limiter.check('ws', 'd')).toThrow(/workspace/i);
  });

  it('forgets requests once the minute window has passed', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    advance(61_000);
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });

  it('enforces the token budget over the hour window', () => {
    const { limiter } = make();
    limiter.check('ws', 'a');
    limiter.record('ws', 'a', { promptTokens: 90, completionTokens: 20 });
    expect(() => limiter.check('ws', 'a')).toThrow(/token/i);
  });

  it('forgets tokens once the hour window has passed', () => {
    const { limiter, advance } = make();
    limiter.check('ws', 'a');
    limiter.record('ws', 'a', { promptTokens: 90, completionTokens: 20 });
    advance(3_601_000);
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });

  it('says which limit was hit and when it clears, so the message is actionable', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'a')).toThrow(/3 requests a minute[\s\S]*try again/i);
  });

  it('scopes an unknown workspace separately rather than sharing a bucket', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws1', 'a'); limiter.record('ws1', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws2', 'a')).not.toThrow();
  });
});
