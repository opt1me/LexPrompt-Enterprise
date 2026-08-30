import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `uid` comes from core rather than being redeclared here: the four lines
// below used to be a seventh byte-identical copy of it, which is the exact
// history `uid.ts`'s own docstring records.
import { ModelError, uid } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import { SCHEMA_VERSION, type Review, type PlaybookVersion } from '../../types';

/**
 * The reviews repository, now a TRANSPORT.
 *
 * The STORAGE half of this file moved to `apps/api/test/reviews.pg.test.ts`,
 * where a real Postgres proves it: the `_seq` tiebreak, the sort, the whole-
 * record round trip with sixty findings, the absent-key cases, and — the one
 * this table exists to get right — that a stale save is refused rather than
 * applied over a human's verification.
 *
 * What stays here is what the browser still owns: which request each export
 * makes, the repair-on-read funnel and its `playbookVersionId` back-fill,
 * `saveReview`'s deep clone, the VERSION THIS BROWSER REMEMBERS (which has
 * no server-side counterpart — it exists precisely because a `Review` built
 * from a run cannot carry one), and the debounced saver, whose behaviour is
 * unchanged by the transport and whose tests needed no edit beyond the
 * transport itself.
 */

const transport = makeFakeTransport();
vi.mock('../api/client', () => transportModule(transport));

const {
  listReviews, getReview, saveReview, deleteReview, createDebouncedReviewSaver,
  forgetReviewVersion,
} = await import('./reviews');

function makePlaybook(): PlaybookVersion {
  return {
    id: 'v1', playbookId: 'pb-1', version: 1, name: 'Lease Review', contractType: 'Lease',
    systemPrompt: 's', formatPrompt: 'f',
    clauses: [{ id: 'c1', title: 'Break', extractPrompt: 'What is the break right?' }],
    changeSummary: '', publishedAt: 1_700_000_000_000, publishedByUserId: 'u1',
    schemaVersion: SCHEMA_VERSION,
  };
}

function makeReview(over: Partial<Review> = {}): Review {
  return {
    id: 'rev-1', matterId: 'matter-1',
    playbookSnapshot: makePlaybook(),
    documentIds: ['doc-1'],
    target: { kind: 'documents', documentIds: ['doc-1'] },
    findings: {},
    modelId: 'test-model',
    startedAt: 1_700_000_000_000,
    createdByUserId: 'owner-1',
    playbookVersionId: 'v1',
    ...over,
  };
}

/** The server's answer to a save: the record it stored, with the version it
 *  allocated. `echoWrites` cannot do this — the version is the server's to
 *  state, and the whole point of the tests below is what the browser does
 *  with the one it is given. */
function serverEchoes(version: number): void {
  transport.responses.set('/v1/reviews/rev-1', undefined);
  transport.responses.delete('/v1/reviews/rev-1');
  transport.responses.set('/v1/reviews/rev-1', { ...makeReview(), version });
}

beforeEach(() => {
  transport.reset();
  forgetReviewVersion('rev-1');
  // A playbook with no published versions answers 200 with an EMPTY LIST,
  // not 404 — `buildVersionIndex` calls `listVersions` for every review with
  // no `playbookVersionId`.
  transport.fallback = path => (path.endsWith('/versions') ? [] : undefined);
});

afterEach(() => forgetReviewVersion('rev-1'));

describe('the requests each export makes', () => {
  it('lists a matter s reviews from /v1/matters/:id/reviews, in the server s order', async () => {
    transport.responses.set('/v1/matters/matter-1/reviews', [
      makeReview({ id: 'b', startedAt: 2 }), makeReview({ id: 'a', startedAt: 1 }),
    ]);
    expect((await listReviews('matter-1')).map(r => r.id)).toEqual(['b', 'a']);
  });

  it('reads one from /v1/reviews/:id', async () => {
    transport.responses.set('/v1/reviews/rev-1', makeReview());
    expect((await getReview('rev-1'))!.id).toBe('rev-1');
  });

  it('PUTs the whole record to /v1/reviews/:id', async () => {
    serverEchoes(1);
    await saveReview(makeReview());
    expect(transport.sent[0].method).toBe('PUT');
    expect(transport.sent[0].path).toBe('/v1/reviews/rev-1');
  });

  it('DELETEs /v1/reviews/:id', async () => {
    transport.responses.set('/v1/reviews/rev-1', makeReview());
    await deleteReview('rev-1');
    expect(transport.deleted).toEqual(['/v1/reviews/rev-1']);
  });

  it('escapes an id in every path it builds', async () => {
    const id = 'a/b c?d';
    transport.responses.set('/v1/reviews/a%2Fb%20c%3Fd', makeReview({ id }));
    await getReview(id);
    await saveReview(makeReview({ id }));
    await deleteReview(id);
    expect(transport.sent[0].path).toBe('/v1/reviews/a%2Fb%20c%3Fd');
    expect(transport.deleted).toEqual(['/v1/reviews/a%2Fb%20c%3Fd']);
    transport.responses.set('/v1/matters/a%2Fb%20c%3Fd/reviews', []);
    expect(await listReviews(id)).toEqual([]);
  });
});

describe('the version this browser last SAW', () => {
  it('sends NO version on the first save of a review it has never seen', async () => {
    // The absence is the claim "I believe this is a create", and the route
    // reads it that way: a create colliding with an existing row is refused
    // rather than overwriting it.
    serverEchoes(1);
    await saveReview(makeReview());
    expect('version' in (transport.sent[0].body as Review)).toBe(false);
  });

  it('sends the version the server returned on the NEXT save', async () => {
    // THE REASON THIS EXISTS. `reviewFromRun` builds a `Review` from a run,
    // and a run has nowhere to carry an optimistic-concurrency token — so
    // without this every save after the first would arrive as a create and
    // be refused, and a run would stop persisting after two seconds.
    serverEchoes(1);
    await saveReview(makeReview());
    serverEchoes(2);
    // A review built afresh from a run: no version on it at all.
    await saveReview(makeReview());
    expect((transport.sent[1].body as Review).version).toBe(1);
  });

  it('prefers what it last saw over a stale version carried on the record', async () => {
    // A `Review` held in component state since a screen opened can carry a
    // version this browser has already superseded with its own writes.
    serverEchoes(5);
    await saveReview(makeReview());
    serverEchoes(6);
    await saveReview(makeReview({ version: 2 }));
    expect((transport.sent[1].body as Review).version).toBe(5);
  });

  it('learns the version from a READ as well as from a write', async () => {
    transport.responses.set('/v1/reviews/rev-1', { ...makeReview(), version: 9 });
    await getReview('rev-1');
    await saveReview(makeReview());
    expect((transport.sent[0].body as Review).version).toBe(9);
  });

  it('learns it from a LIST too, so a review opened from a matter saves correctly', async () => {
    transport.responses.set('/v1/matters/matter-1/reviews', [{ ...makeReview(), version: 4 }]);
    await listReviews('matter-1');
    transport.responses.set('/v1/reviews/rev-1', { ...makeReview(), version: 5 });
    await saveReview(makeReview());
    expect((transport.sent[0].body as Review).version).toBe(4);
  });

  it('forgets it once the review is deleted', async () => {
    transport.responses.set('/v1/reviews/rev-1', { ...makeReview(), version: 3 });
    await getReview('rev-1');
    await deleteReview('rev-1');
    serverEchoes(1);
    await saveReview(makeReview());
    expect('version' in (transport.sent[0].body as Review)).toBe(false);
  });

  it('does NOT paper over a colleague s write — a refused save stays refused', async () => {
    // The remembered version is what THIS browser last saw. Another tab
    // writing moves the server past it, so the next save from here is
    // refused rather than applied — which is the whole point, because what
    // it would overwrite is a verification only a human can set.
    serverEchoes(1);
    await saveReview(makeReview());
    const refused = new ModelError('This was changed since you opened it.', 'conflict', 409);
    transport.failures.set('/v1/reviews/rev-1', refused);
    await expect(saveReview(makeReview())).rejects.toBe(refused);
    // …and it does not silently start sending a different version to get
    // past it on the next attempt.
    await expect(saveReview(makeReview())).rejects.toBe(refused);
    expect((transport.sent[1].body as Review).version).toBe(1);
    expect((transport.sent[2].body as Review).version).toBe(1);
  });
});

describe('playbookSnapshot isolation', () => {
  it('is unaffected by mutating a field nested inside a clause object after saving', async () => {
    // The load-bearing case: mutating something NESTED inside the snapshot
    // (not just pushing onto the top-level `clauses` array) after the call
    // must not retroactively change what the review claims to have checked.
    // Over a network there is a real window between the clone and the
    // request going out.
    serverEchoes(1);
    const playbook = makePlaybook();
    const review = makeReview({ playbookSnapshot: playbook });
    const promise = saveReview(review);
    playbook.clauses[0].title = 'Rewritten after the fact';
    await promise;
    const sent = (transport.sent[0].body as Review).playbookSnapshot as PlaybookVersion;
    expect(sent.clauses[0].title).toBe('Break');
  });

  it('is unaffected by pushing a new clause onto the original playbook after saving', async () => {
    serverEchoes(1);
    const playbook = makePlaybook();
    const promise = saveReview(makeReview({ playbookSnapshot: playbook }));
    playbook.clauses.push({ id: 'c2', title: 'Added later', extractPrompt: 'x' });
    await promise;
    const sent = (transport.sent[0].body as Review).playbookSnapshot as PlaybookVersion;
    expect(sent.clauses).toHaveLength(1);
  });
});

describe('repair on read', () => {
  it('returns a pre-B review with its citations upgraded and every finding unchecked', async () => {
    // Every read funnels through the same repair, so a review written before
    // sub-project B is upgraded exactly once no matter which screen asked.
    transport.responses.set('/v1/reviews/rev-1', {
      ...makeReview(),
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'done',
        citations: ['a bare quote'] } } },
    });
    const read = (await getReview('rev-1'))!;
    expect(read.findings['doc-1']['clause-1'].citations)
      .toEqual([{ quote: 'a bare quote', documentId: 'doc-1' }]);
    // Nothing derives a verification, so an upgraded finding is unchecked.
    expect(read.findings['doc-1']['clause-1'].verification.state).toBe('unchecked');
  });

  it('migrates on listReviews too, not only on getReview', async () => {
    transport.responses.set('/v1/matters/matter-1/reviews', [{
      ...makeReview(),
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'done',
        citations: ['another quote'] } } },
    }]);
    const [read] = await listReviews('matter-1');
    expect(read.findings['doc-1']['clause-1'].citations)
      .toEqual([{ quote: 'another quote', documentId: 'doc-1' }]);
  });

  it('back-fills playbookVersionId from the snapshot for a review that never had one', async () => {
    // The pre-D scenario the back-fill exists for: a review saved with no
    // `playbookVersionId` at all, whose frozen snapshot still names the
    // playbook it ran against.
    const bare = makeReview();
    delete bare.playbookVersionId;
    transport.responses.set('/v1/reviews/rev-1', bare);
    transport.responses.set('/v1/playbooks/pb-1/versions', [makePlaybook()]);
    expect((await getReview('rev-1'))!.playbookVersionId).toBe('v1');
  });

  it('costs a review that already has one no extra request at all', async () => {
    transport.responses.set('/v1/reviews/rev-1', makeReview());
    transport.fallback = undefined;
    // No `/v1/playbooks/pb-1/versions` entry, so a lookup would reject.
    await expect(getReview('rev-1')).resolves.not.toBeNull();
  });

  it('leaves playbookVersionId ABSENT when no v1 can be found for the snapshot', async () => {
    // "Never recorded" must stay distinguishable from "recorded, then
    // deleted"; inventing an id here would erase the difference.
    const bare = makeReview();
    delete bare.playbookVersionId;
    transport.responses.set('/v1/reviews/rev-1', bare);
    expect('playbookVersionId' in (await getReview('rev-1'))!).toBe(false);
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a review the server does not have', async () => {
    expect(await getReview('nope')).toBeNull();
  });

  it('propagates a 500 from a read rather than swallowing it into null', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/reviews/rev-1', boom);
    await expect(getReview('rev-1')).rejects.toBe(boom);
  });

  it('rejects rather than resolving to [] when the list fails, so "no reviews" can be told apart', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/matters/matter-1/reviews', boom);
    await expect(listReviews('matter-1')).rejects.toBe(boom);
  });

  it('resolves quietly when the review to delete is not there', async () => {
    await expect(deleteReview('gone')).resolves.toBeUndefined();
  });

  it('propagates any other delete failure', async () => {
    const denied = new ModelError('This needs a LexPrompt role.', 'not_permitted', 403);
    transport.failures.set('/v1/reviews/rev-1', denied);
    await expect(deleteReview('rev-1')).rejects.toBe(denied);
  });
});

describe('createDebouncedReviewSaver', () => {
  // KEPT from the IndexedDB version, with no assertion edited: the saver's
  // behaviour is a property of its own timers and is unchanged by which
  // store `saveReview` writes to. Only the fixture underneath moved.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not persist immediately on scheduleSave', () => {
    serverEchoes(1);
    createDebouncedReviewSaver(2000).scheduleSave(makeReview());
    expect(transport.sent).toEqual([]);
  });

  it('persists the latest scheduled state once the debounce interval elapses', async () => {
    serverEchoes(1);
    const saver = createDebouncedReviewSaver(2000);
    saver.scheduleSave(makeReview({ modelId: 'first' }));
    saver.scheduleSave(makeReview({ modelId: 'second' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.sent).toHaveLength(1);
    expect((transport.sent[0].body as Review).modelId).toBe('second');
  });

  it('THROTTLES rather than resetting, so a continuous run still saves', async () => {
    // The shipped comment is emphatic and the behaviour is unchanged by the
    // transport: `onUpdate` fires continuously through a run, so a
    // reset-on-every-call debounce could in principle never fire — i.e.
    // never save mid-run at all, which is the crash-loses-the-whole-run
    // failure this exists to prevent.
    serverEchoes(1);
    const saver = createDebouncedReviewSaver(2000);
    for (let i = 0; i < 10; i++) {
      saver.scheduleSave(makeReview({ modelId: `update-${i}` }));
      await vi.advanceTimersByTimeAsync(500);
    }
    // 5000ms of continuous updates at a 2000ms interval: it fired, and it
    // fired at most once per interval.
    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    expect(transport.sent.length).toBeLessThanOrEqual(3);
  });

  it('saveNow persists immediately and cancels a pending debounced save', async () => {
    serverEchoes(1);
    const saver = createDebouncedReviewSaver(2000);
    saver.scheduleSave(makeReview({ modelId: 'scheduled' }));
    await saver.saveNow(makeReview({ modelId: 'now' }));
    expect(transport.sent).toHaveLength(1);
    expect((transport.sent[0].body as Review).modelId).toBe('now');
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.sent).toHaveLength(1);
  });

  it('saveNow returns its promise as-is, so a failure there is never swallowed', async () => {
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    transport.failures.set('/v1/reviews/rev-1', boom);
    await expect(createDebouncedReviewSaver(2000).saveNow(makeReview())).rejects.toBe(boom);
  });

  it('dispose cancels a pending save without persisting it', async () => {
    serverEchoes(1);
    const saver = createDebouncedReviewSaver(2000);
    saver.scheduleSave(makeReview());
    saver.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.sent).toEqual([]);
  });

  it('hands a failed debounced save to onError rather than losing it', async () => {
    // NEWLY LOAD-BEARING. The debounced write is fire-and-forget — nothing
    // awaits it, so a rejection cannot surface on a promise any caller
    // holds. Over a local disk that was rare; over a network it fires, and
    // one of the failures is a 409 refusing this save because somebody
    // else's landed first.
    const refused = new ModelError('This was changed since you opened it.', 'conflict', 409);
    transport.failures.set('/v1/reviews/rev-1', refused);
    const onError = vi.fn();
    const saver = createDebouncedReviewSaver(2000, onError);
    const review = makeReview();
    saver.scheduleSave(review);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(refused);
    // The review it FAILED to save is handed over too, so a caller can say
    // which one is at risk.
    expect((onError.mock.calls[0][1] as Review).id).toBe('rev-1');
  });
});
