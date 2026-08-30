import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  DispositionWriteResult, FindingsPage,
} from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';

/**
 * THE BROWSER'S COPY OF WHAT THE STORE SAID ABOUT A JUDGEMENT.
 *
 * Not "it makes a request". What is worth testing is the one rule this cache
 * exists to keep: **a card's actor comes from a disposition the server
 * stated, never from anything this browser composed.** Everything below is
 * some version of that — the read fills it, a confirmed write updates it
 * from the ANSWER rather than from the request, forgetting a review forgets
 * it, and a cell nobody has read reads as unknown rather than as untouched.
 */

const transport = makeFakeTransport();
vi.mock('./client', () => transportModule(transport));

const {
  getFindings, dispositionFor, setDisposition, forgetFindingVersions, dispositionVersionFor,
} = await import('./findings');

const OKAFOR = 'u-okafor';
const TRAINEE = 'u-trainee';

const PAGE: FindingsPage = {
  findings: {
    d1: {
      c1: { clauseId: 'c1', status: 'done', summary: 'Capped at fees.', citations: [],
        verification: { state: 'rejected', reason: 'Uncapped in 14.2.', byUserId: OKAFOR, at: 1_000 },
        notes: [] },
      c2: { clauseId: 'c2', status: 'done', summary: 'Silent.', citations: [],
        verification: { state: 'unchecked' }, notes: [] },
    },
  },
  dispositions: {
    d1: {
      c1: {
        disposition: {
          reviewId: 'rev-1', findingsKey: 'd1', clauseId: 'c1', state: 'rejected',
          reason: 'Uncapped in 14.2.', byUserId: OKAFOR, at: 1_000, changedCount: 2, version: 3,
        },
        last: {
          id: 9, fromState: 'verified', toState: 'rejected', reason: 'Uncapped in 14.2.',
          cause: 'human', byUserId: OKAFOR, at: 1_000,
        },
      },
      // Never touched: a disposition the server DID state, with no event.
      c2: {
        disposition: {
          reviewId: 'rev-1', findingsKey: 'd1', clauseId: 'c2', state: 'unchecked',
          changedCount: 0, version: 1,
        },
      },
    },
  },
  dispositionVersions: { d1: { c1: 3, c2: 1 } },
  findingVersions: { d1: { c1: 1, c2: 1 } },
  version: 4,
};

beforeEach(() => {
  transport.reset();
  forgetFindingVersions('rev-1');
  transport.responses.set('/v1/reviews/rev-1/findings', PAGE);
});

describe('the disposition the read reported', () => {
  it('remembers the disposition and the event that produced it', async () => {
    await getFindings('rev-1');
    const d = dispositionFor('rev-1', 'd1', 'c1')!;
    expect(d.disposition.state).toBe('rejected');
    expect(d.disposition.byUserId).toBe(OKAFOR);
    expect(d.disposition.changedCount).toBe(2);
    // "was Verified", with no second request — §8's whole reason for
    // carrying the event with the read.
    expect(d.last!.fromState).toBe('verified');
  });

  it('keeps a never-touched cell as a disposition with no event, not as nothing', async () => {
    await getFindings('rev-1');
    const d = dispositionFor('rev-1', 'd1', 'c2')!;
    expect(d.disposition.changedCount).toBe(0);
    expect('last' in d).toBe(false);
    expect('byUserId' in d.disposition).toBe(false);
  });

  it('answers undefined for a cell this browser has NOT read', async () => {
    // Different from "nobody has touched it", which is `changedCount: 0` —
    // a fact the server stated. `undefined` means this browser has not been
    // told, and a caller that flattened the two would render "Not checked"
    // over a clause it knows nothing about.
    await getFindings('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c-unknown')).toBeUndefined();
    expect(dispositionFor('rev-2', 'd1', 'c1')).toBeUndefined();
  });

  it('takes a write s ANSWER, not what the write asked for', async () => {
    /*
     * Await-then-apply, on the attribution as well as on the state. The
     * mutation this exists for: update the cache from `change` instead of
     * from `result`, and a verification would show its new state with the
     * PREVIOUS actor and the previous event beside it — a card claiming a
     * person made a judgement they did not.
     */
    await getFindings('rev-1');
    const answer: DispositionWriteResult = {
      disposition: {
        reviewId: 'rev-1', findingsKey: 'd1', clauseId: 'c1', state: 'verified',
        byUserId: TRAINEE, at: 2_000, changedCount: 3, version: 4,
      },
      event: {
        id: 10, fromState: 'rejected', toState: 'verified', cause: 'human',
        byUserId: TRAINEE, at: 2_000,
      },
    };
    transport.responses.set('/v1/reviews/rev-1/findings/d1/c1/disposition', answer);
    await setDisposition('rev-1', 'd1', 'c1', { state: 'verified' });

    const d = dispositionFor('rev-1', 'd1', 'c1')!;
    expect(d.disposition.byUserId).toBe(TRAINEE);
    expect(d.disposition.changedCount).toBe(3);
    expect(d.last!.fromState).toBe('rejected');
    // …and the version cache moved with it, so the next write is not
    // refused as stale.
    expect(dispositionVersionFor('rev-1', 'd1', 'c1')).toBe(4);
  });

  it('replaces the review s dispositions on a re-read rather than merging them', async () => {
    // A disposition still held for a cell the server no longer reports would
    // be an attribution line for a finding that is gone.
    await getFindings('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c2')).toBeDefined();
    transport.responses.set('/v1/reviews/rev-1/findings', {
      ...PAGE,
      dispositions: { d1: { c1: PAGE.dispositions.d1.c1 } },
    });
    await getFindings('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c1')).toBeDefined();
    expect(dispositionFor('rev-1', 'd1', 'c2')).toBeUndefined();
  });

  it('forgets a review s dispositions when it forgets its versions', async () => {
    await getFindings('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c1')).toBeDefined();
    forgetFindingVersions('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c1')).toBeUndefined();
  });

  it('survives a server that sends no dispositions map at all', async () => {
    // A tab left open across a deploy reads an older response. It must not
    // throw; it must simply know nothing, which `dispositionFor` already
    // expresses as `undefined`.
    forgetFindingVersions('rev-1');
    const { dispositions: _dispositions, ...older } = PAGE;
    transport.responses.set('/v1/reviews/rev-1/findings', older);
    await getFindings('rev-1');
    expect(dispositionFor('rev-1', 'd1', 'c1')).toBeUndefined();
  });
});
