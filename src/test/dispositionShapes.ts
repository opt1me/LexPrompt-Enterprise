import type { DispositionWithHistory, VerificationState } from '@lexprompt/core';
import type { DispositionAudience } from '../lib/findingOutcome';

/**
 * THE COMPLETE SET OF THINGS A DISPOSITION CAN BE, as one fixture.
 *
 * Eight shapes, and they are eight rather than four because three pairs
 * collapse into each other the moment anybody stops paying attention:
 *
 *  - **"never touched" and "cleared by hand"** are both `unchecked`, and are
 *    different facts. `changedCount === 0` means nobody has ever looked;
 *    a person clearing a verification is a decision somebody made.
 *  - **"cleared by hand" and "cleared by a re-run"** are different ACTS
 *    (§6.3: *"the card must not flatten them"*). One is a person
 *    withdrawing a judgement; the other is the system removing a judgement
 *    that described output which no longer exists.
 *  - **"verified once" and "verified after a rejection"** are the difference
 *    between a settled clause and a contested one.
 *
 * A MODULE rather than an export of a `.test.ts` file, so the card, the
 * history panel and the exports can all index into the same eight without
 * one test file importing another.
 */

const OKAFOR = 'u2';
const TRAINEE = 'u1';
const STRANGER = 'u-not-in-this-directory';

/** 16:04 UTC, and 15:12 for the earlier event in a two-step history. */
const AT = Date.UTC(2026, 7, 30, 16, 4);
const EARLIER = Date.UTC(2026, 7, 30, 15, 12);

interface ShapeInput {
  state: VerificationState;
  reason?: string;
  byUserId?: string;
  at?: number;
  changedCount: number;
  last?: {
    fromState: VerificationState;
    toState: VerificationState;
    reason?: string;
    cause: 'human' | 'rerun_reset';
    byUserId: string;
    at: number;
  };
}

function shape(input: ShapeInput): DispositionWithHistory {
  return {
    disposition: {
      reviewId: 'rev-1',
      findingsKey: 'd1',
      clauseId: 'c1',
      state: input.state,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.byUserId ? { byUserId: input.byUserId } : {}),
      ...(input.at ? { at: input.at } : {}),
      changedCount: input.changedCount,
      version: input.changedCount + 1,
    },
    // ABSENT rather than `last: undefined` — `structuredClone` preserves an
    // undefined-valued key, and a fixture that carried one would let a
    // consumer's `in` check pass against an event that never happened.
    ...(input.last ? { last: { id: 1, ...input.last } } : {}),
  };
}

export const DISPOSITION_SHAPES: Record<string, DispositionWithHistory> = {
  'never touched': shape({ state: 'unchecked', changedCount: 0 }),

  'verified once': shape({
    state: 'verified', byUserId: TRAINEE, at: AT, changedCount: 1,
    last: { fromState: 'unchecked', toState: 'verified', cause: 'human', byUserId: TRAINEE, at: AT },
  }),

  'verified after a rejection': shape({
    state: 'verified', byUserId: OKAFOR, at: AT, changedCount: 2,
    last: { fromState: 'rejected', toState: 'verified', cause: 'human', byUserId: OKAFOR, at: AT },
  }),

  'rejected with a reason': shape({
    state: 'rejected', reason: 'The cap is uncapped in clause 14.2.',
    byUserId: OKAFOR, at: AT, changedCount: 2,
    last: {
      fromState: 'verified', toState: 'rejected', reason: 'The cap is uncapped in clause 14.2.',
      cause: 'human', byUserId: OKAFOR, at: AT,
    },
  }),

  flagged: shape({
    state: 'flagged', byUserId: TRAINEE, at: AT, changedCount: 1,
    last: { fromState: 'unchecked', toState: 'flagged', cause: 'human', byUserId: TRAINEE, at: AT },
  }),

  'cleared by hand': shape({
    state: 'unchecked', byUserId: TRAINEE, at: AT, changedCount: 2,
    last: { fromState: 'verified', toState: 'unchecked', cause: 'human', byUserId: TRAINEE, at: AT },
  }),

  'cleared by a re-run': shape({
    state: 'unchecked', byUserId: TRAINEE, at: AT, changedCount: 2,
    last: {
      fromState: 'verified', toState: 'unchecked', cause: 'rerun_reset',
      byUserId: TRAINEE, at: AT,
    },
  }),

  'changed three times': shape({
    state: 'verified', byUserId: OKAFOR, at: AT, changedCount: 3,
    last: { fromState: 'rejected', toState: 'verified', cause: 'human', byUserId: OKAFOR, at: AT },
  }),
};

/** A ninth, kept out of the table above because it is about the AUDIENCE
 *  rather than about the disposition: an actor the directory cannot name. */
export const BY_A_STRANGER: DispositionWithHistory = shape({
  state: 'verified', byUserId: STRANGER, at: AT, changedCount: 1,
  last: { fromState: 'unchecked', toState: 'verified', cause: 'human', byUserId: STRANGER, at: AT },
});

/** The two events a history panel renders, newest first. */
export const HISTORY_EVENTS = [
  {
    id: 2, fromState: 'verified' as const, toState: 'rejected' as const,
    reason: 'The cap is uncapped in clause 14.2.', cause: 'human' as const,
    byUserId: OKAFOR, at: AT,
  },
  {
    id: 1, fromState: 'unchecked' as const, toState: 'verified' as const,
    cause: 'human' as const, byUserId: TRAINEE, at: EARLIER,
  },
];

/** A re-run reset, as an event. The one line in a history panel a reader
 *  could act on wrongly if it were flattened into "somebody un-verified
 *  this". */
export const RERUN_EVENT = {
  id: 3, fromState: 'verified' as const, toState: 'unchecked' as const,
  cause: 'rerun_reset' as const, byUserId: TRAINEE, at: Date.UTC(2026, 7, 30, 11, 7),
};

/**
 * The audience the tests render through.
 *
 * `timeOf` is timezone-free on purpose: a test that asserted a formatted
 * local time would pass in London and fail in Sydney, and the failure would
 * name the string rather than the clock.
 */
export const TEST_AUDIENCE: DispositionAudience = {
  nameOf: (id?: string) => ({ u1: 'A. Trainee', u2: 'R. Okafor' } as Record<string, string>)[id ?? ''],
  initialsOf: (id?: string) => ({ u1: 'AT', u2: 'RO' } as Record<string, string>)[id ?? ''],
  timeOf: (at: number) => new Date(at).toISOString().slice(11, 16),
};
