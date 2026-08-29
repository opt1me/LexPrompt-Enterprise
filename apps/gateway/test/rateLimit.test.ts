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

/**
 * Every case below counts REQUESTS with `recordAttempt` and TOKENS with
 * `record`, because those are now two ledgers and the split is the point.
 *
 * They used to call `check` and `record` in lockstep, which made the
 * per-minute request budget look enforced while it was in fact counting
 * only successes: `record` runs from the success branch alone, so a call
 * that failed — the exact condition a request throttle exists for —
 * contributed nothing, and deleting `record`'s call site in `callModel.ts`
 * left this whole file green.
 */
describe('WindowRateLimiter', () => {
  it('allows requests up to the per-actor limit', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
    expect(() => limiter.check('ws', 'a')).toThrowError(
      expect.objectContaining({ code: 'budget_exhausted', status: 429 }));
  });

  it('does not let one actor exhaust another actor\'s allowance', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
    expect(() => limiter.check('ws', 'b')).not.toThrow();
  });

  it('enforces the workspace request limit across actors', () => {
    const { limiter } = make();
    for (const actor of ['a', 'b']) {
      for (let i = 0; i < 2; i++) { limiter.check('ws', actor); limiter.recordAttempt('ws', actor); }
    }
    limiter.check('ws', 'c'); limiter.recordAttempt('ws', 'c');
    expect(() => limiter.check('ws', 'd')).toThrow(/workspace/i);
  });

  it('forgets requests once the minute window has passed', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
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
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
    expect(() => limiter.check('ws', 'a')).toThrow(/3 requests a minute[\s\S]*try again/i);
  });

  it('scopes an unknown workspace separately rather than sharing a bucket', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws1', 'a'); limiter.recordAttempt('ws1', 'a'); }
    expect(() => limiter.check('ws2', 'a')).not.toThrow();
  });

  // ==================================================================
  // M5. The defect this class shipped with: `check` counted only what
  // `record` appended, and `record` ran only after a call SUCCEEDED. So
  // `requestsPerMinutePerActor` was a limit on successes — inert under
  // exactly the conditions a request throttle is for (a provider returning
  // 500s, a retry storm, a client bug), while each failed call still cost
  // three upstream attempts at full prompt-token price.
  //
  // This is the case that fails if the accounting is reverted. Every other
  // case in this file drives check/record in lockstep and would not.
  // ==================================================================
  it('counts an attempt that never succeeded toward the request budget', () => {
    const { limiter } = make();
    // Three attempts, no `record` at all — i.e. three calls that FAILED.
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
    expect(() => limiter.check('ws', 'a')).toThrowError(
      expect.objectContaining({ code: 'budget_exhausted', status: 429 }));
  });

  // The other half of the split, and the reason it is a split rather than
  // one ledger: a successful call writes an attempt AND a cost, and must
  // still count as ONE request.
  it('does not double-count a successful call as two requests', () => {
    const { limiter } = make();
    for (let i = 0; i < 2; i++) {
      limiter.check('ws', 'a');
      limiter.recordAttempt('ws', 'a');
      limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 });
    }
    // Two successful calls against a budget of three: the third must clear.
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });

  // Conversely: token cost is still billed only for calls that produced an
  // answer. An attempt on its own must not spend the token budget.
  it('does not bill the token budget for an attempt that produced nothing', () => {
    const { limiter } = make({ requestsPerMinutePerActor: 1000, requestsPerMinutePerWorkspace: 1000 });
    for (let i = 0; i < 5; i++) { limiter.check('ws', 'a'); limiter.recordAttempt('ws', 'a'); }
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });
});
