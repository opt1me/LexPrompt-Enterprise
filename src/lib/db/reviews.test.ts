import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listReviews, getReview, saveReview, deleteReview, createDebouncedReviewSaver,
} from './reviews';
import { publishVersion, getVersion } from './playbookVersions';
import { deletePlaybook } from './playbooks';
import { migrateDraft } from './playbookMigration';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { Review, PlaybookVersion, PlaybookDraft } from '../../types';

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.reviews);
});

afterEach(() => closeDb());

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makePlaybook(): PlaybookVersion {
  return {
    id: uid(),
    playbookId: 'pb-1',
    version: 1,
    name: 'NDA',
    contractType: 'NDA',
    systemPrompt: 'Be careful.',
    formatPrompt: 'Quote verbatim.',
    clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'What is the term?' }],
    changeSummary: '',
    publishedAt: Date.now(),
    publishedByUserId: 'owner-1',
    schemaVersion: 6,
  };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: uid(),
    matterId: 'matter-1',
    playbookSnapshot: makePlaybook(),
    documentIds: ['doc-1'],
    target: { kind: 'documents', documentIds: ['doc-1'] },
    findings: {},
    modelId: 'test-model',
    startedAt: Date.now(),
    createdByUserId: 'owner-1',
    ...overrides,
  };
}

describe('review CRUD', () => {
  it('starts empty', async () => {
    expect(await listReviews('matter-1')).toEqual([]);
  });

  it('saves and reads back a review', async () => {
    const r = makeReview();
    await saveReview(r);
    expect((await getReview(r.id))?.modelId).toBe('test-model');
    expect((await listReviews(r.matterId)).map(x => x.id)).toEqual([r.id]);
  });

  it('updates in place rather than duplicating', async () => {
    const r = makeReview();
    await saveReview(r);
    await saveReview({ ...r, completedAt: Date.now() });
    const all = await listReviews(r.matterId);
    expect(all.length).toBe(1);
    expect(all[0].completedAt).toBeDefined();
  });

  it('returns null for an unknown id', async () => {
    expect(await getReview('nope')).toBeNull();
  });

  it('deletes', async () => {
    const r = makeReview();
    await saveReview(r);
    await deleteReview(r.id);
    expect(await getReview(r.id)).toBeNull();
    expect(await listReviews(r.matterId)).toEqual([]);
  });

  it('only lists reviews for the requested matter', async () => {
    const a = makeReview({ matterId: 'matter-a' });
    const b = makeReview({ matterId: 'matter-b' });
    await Promise.all([saveReview(a), saveReview(b)]);
    expect((await listReviews('matter-a')).map(x => x.id)).toEqual([a.id]);
  });

  it('lists most-recently-started first, deterministically on a same-millisecond tie', async () => {
    const a = await saveReview(makeReview({ startedAt: 1 }));
    await saveReview(makeReview({ startedAt: 2 }));
    await saveReview({ ...a, startedAt: 3 });
    expect((await listReviews('matter-1'))[0].id).toBe(a.id);
  });

  it('assigns distinct sequence numbers to concurrent saves and orders them deterministically', async () => {
    const a = makeReview();
    const b = makeReview();
    await Promise.all([saveReview(a), saveReview(b)]);

    const db = await getDb();
    const [rawA, rawB] = await Promise.all([
      db.get(STORES.reviews, a.id) as Promise<Review & { _seq: number }>,
      db.get(STORES.reviews, b.id) as Promise<Review & { _seq: number }>,
    ]);
    expect(rawA._seq).not.toBe(rawB._seq);

    const tie = Date.now();
    await db.put(STORES.reviews, { ...rawA, startedAt: tie });
    await db.put(STORES.reviews, { ...rawB, startedAt: tie });
    const winnerId = rawA._seq > rawB._seq ? a.id : b.id;
    expect((await listReviews('matter-1'))[0].id).toBe(winnerId);
  });

  it('rejects rather than resolving to [] when the database fails, so "no reviews" can be told apart from "db failed"', async () => {
    const db = await getDb();
    const spy = vi.spyOn(db, 'getAllFromIndex').mockRejectedValue(new Error('boom'));
    try {
      await expect(listReviews('matter-1')).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
  });

  it('saveReview allocates seq and put in one transaction, not two', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await saveReview(makeReview());
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith(STORES.reviews, 'readwrite');
    txSpy.mockRestore();
  });

  it('returns a pre-B review with its citations upgraded and every finding unchecked', async () => {
    const legacy = {
      ...makeReview({ id: 'rev-legacy' }),
      findings: {
        'doc-1': {
          'clause-1': { clauseId: 'clause-1', status: 'done', summary: 's', citations: ['a quote here'] },
        },
      },
    };
    const db = await getDb();
    await db.put(STORES.reviews, legacy as never);

    const read = await getReview('rev-legacy');
    expect(read!.findings['doc-1']['clause-1'].citations)
      .toEqual([{ quote: 'a quote here', documentId: 'doc-1' }]);
    expect(read!.findings['doc-1']['clause-1'].verification).toEqual({ state: 'unchecked' });
  });

  it('migrates on listReviews too, not only on getReview', async () => {
    const legacy = {
      ...makeReview({ id: 'rev-legacy-2', matterId: 'matter-legacy' }),
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'done', citations: ['another quote'] } } },
    };
    const db = await getDb();
    await db.put(STORES.reviews, legacy as never);

    const [read] = await listReviews('matter-legacy');
    expect(read.findings['doc-1']['clause-1'].citations)
      .toEqual([{ quote: 'another quote', documentId: 'doc-1' }]);
  });
});

// Task 4: a review records the playbook version it ran against.
//
// `draftFrom` maps a `PlaybookVersion`-shaped fixture onto a `PlaybookDraft`
// by calling `migrateDraft` (Task 3) rather than hand-rolling a second copy
// of that mapping.
function draftFrom(version: PlaybookVersion): PlaybookDraft {
  return migrateDraft(version, version.name);
}

describe('Review.playbookVersionId (Task 4)', () => {
  it('reopening a review reads the version it ran against, not the current one', async () => {
    const v1 = await publishVersion('pb-1', draftFrom(makePlaybook()), 'u1');
    const review = await saveReview(makeReview({ playbookVersionId: v1.id }));
    await publishVersion('pb-1', { ...draftFrom(makePlaybook()), changeSummary: 'later' }, 'u1');

    const reopened = await getReview(review.id);
    const version = await getVersion(reopened!.playbookVersionId!);
    expect(version!.version).toBe(1);
  });

  // Exercises `buildVersionIndex`'s own back-fill path directly (the other
  // tests in this block set `playbookVersionId` explicitly, which short-
  // circuits it before it ever recovers a playbook id from the snapshot).
  // This is the actual pre-D scenario the back-fill exists for: a review
  // saved with no `playbookVersionId` at all, whose frozen snapshot still
  // names the playbook it ran against.
  it('back-fills playbookVersionId on read for a review that never had one, from its own snapshot', async () => {
    // A playbook id of its own, not the shared 'pb-1' the rest of this
    // describe block uses: `playbookVersions` is never cleared between
    // tests in this file, and `buildVersionIndex` specifically looks for
    // the version numbered 1 — colliding with 'pb-1' would pick up an
    // earlier test's v1 instead of this one's.
    const playbook = { ...makePlaybook(), playbookId: 'pb-backfill-once' };
    const v1 = await publishVersion('pb-backfill-once', draftFrom(playbook), 'u1');
    const review = await saveReview(makeReview({ playbookSnapshot: playbook })); // no playbookVersionId

    const reopened = await getReview(review.id);
    expect(reopened!.playbookVersionId).toBe(v1.id);
  });

  // R-D15: the id may DANGLE, not merely be absent. Task 3 made deleting a
  // playbook cascade to its versions, so a review that ran against a
  // deleted playbook's version still carries an id that resolves to
  // nothing. Nothing may render "ran against v4" from the id's presence
  // alone; the version must be fetched and a miss handled honestly.
  it('a review whose version was deleted still opens, and says the version is gone', async () => {
    const v1 = await publishVersion('pb-1', draftFrom(makePlaybook()), 'u1');
    const review = await saveReview(makeReview({ playbookVersionId: v1.id }));
    await deletePlaybook('pb-1'); // cascades to its versions (Task 3, R-D13)

    const reopened = await getReview(review.id);
    // The id is still there — it is a record of what ran, not a live handle —
    // but it no longer resolves, and the caller must not present it as one.
    expect(reopened!.playbookVersionId).toBe(v1.id);
    expect(await getVersion(v1.id)).toBeNull();
    // and the review is still readable, on its snapshot, exactly as a review
    // whose DOCUMENT was deleted still opens (spec §9's reasoning, one level up)
    expect(reopened!.playbookSnapshot.clauses).toBeDefined();
  });
});

describe('playbookSnapshot isolation', () => {
  it('is unaffected by mutating a field nested inside a clause object after saving', async () => {
    // The load-bearing case: mutating something NESTED inside the snapshot
    // (not just pushing onto the top-level `clauses` array) after save must
    // not retroactively change what the review claims to have checked. A
    // test that only pushes a new top-level clause would pass against a
    // shallow copy of `playbookSnapshot` and prove nothing.
    const playbook = makePlaybook();
    const originalPrompt = playbook.clauses[0].extractPrompt;
    const r = makeReview({ playbookSnapshot: playbook });

    const saved = await saveReview(r);
    playbook.clauses[0].extractPrompt = 'MUTATED';

    // The value returned from saveReview in this same tick must not have
    // leaked a reference to the caller's clause object.
    expect(saved.playbookSnapshot.clauses[0].extractPrompt).toBe(originalPrompt);

    // And the persisted copy, read back fresh from the store, must also be
    // unaffected.
    const reread = await getReview(r.id);
    expect(reread?.playbookSnapshot.clauses[0].extractPrompt).toBe(originalPrompt);
  });

  it('is unaffected by pushing a new clause onto the original playbook after saving', async () => {
    const playbook = makePlaybook();
    const r = makeReview({ playbookSnapshot: playbook });
    await saveReview(r);

    playbook.clauses.push({ id: 'c2', title: 'New', extractPrompt: 'New?' });

    const reread = await getReview(r.id);
    expect(reread?.playbookSnapshot.clauses.length).toBe(1);
  });
});

// Real timers throughout: fake-indexeddb schedules every request completion
// via a real setImmediate/setTimeout(fn, 0) internally (see
// `fake-indexeddb`'s `lib/scheduling.js`), so `vi.useFakeTimers()` would
// freeze the database itself, not just this helper's debounce timer — any
// `getDb()`/store call made while fake timers are active hangs until the
// fake clock is advanced past every nested internal timer, which is
// exactly the kind of coupling these tests should not depend on. Using a
// short real `debounceMs` and a real `wait()` exercises the same logic
// without that trap.
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createDebouncedReviewSaver', () => {
  it('does not persist immediately on scheduleSave', async () => {
    const saver = createDebouncedReviewSaver(200);
    const r = makeReview();
    saver.scheduleSave(r);
    try {
      expect(await getReview(r.id)).toBeNull();
    } finally {
      // Dispose so this test's real, still-armed 200ms timer cannot fire
      // during a later test and pollute that test's own save-count spy.
      saver.dispose();
    }
  });

  it('persists the latest scheduled state once the debounce interval elapses', async () => {
    const saver = createDebouncedReviewSaver(30);
    const r = makeReview();
    try {
      saver.scheduleSave(r);
      saver.scheduleSave({ ...r, findings: { 'doc-1': {} } });

      await wait(80);

      const found = await getReview(r.id);
      expect(found).not.toBeNull();
      expect(found?.findings).toEqual({ 'doc-1': {} });
    } finally {
      saver.dispose();
    }
  });

  it('does not fire more than once per debounce interval even under continuous updates', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    try {
      const saver = createDebouncedReviewSaver(60);
      const r = makeReview();

      // Simulate onUpdate firing every 15ms for ~150ms straight — well
      // inside "continuous", the pattern a naive reset-on-every-call
      // debounce would starve on (the timer would never go quiet enough to
      // fire until updates stop).
      for (let i = 0; i < 10; i++) {
        saver.scheduleSave({ ...r, findings: { tick: {} } });
        await wait(15);
      }
      await wait(80); // let the last-armed timer fire
      saver.dispose(); // belt-and-braces: guarantee nothing is left armed for a later test

      // Count only actual writes: `getReview`/`getDb` internally open their
      // own incidental 'readonly' transactions on this store via the `idb`
      // library's convenience wrappers, which this filter must not conflate
      // with a real save.
      const reviewSaveCalls = txSpy.mock.calls.filter(c => c[0] === STORES.reviews && c[1] === 'readwrite').length;
      // By ~230ms of continuous updates into a 60ms interval, at least one
      // save must have landed — a crash here costs seconds, not the whole
      // run — but nowhere near one per update (10 updates).
      expect(reviewSaveCalls).toBeGreaterThanOrEqual(1);
      expect(reviewSaveCalls).toBeLessThan(10);
      expect(await getReview(r.id)).not.toBeNull();
    } finally {
      txSpy.mockRestore();
    }
  });

  it('saveNow persists immediately and cancels a pending debounced save', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    const writeCount = () => txSpy.mock.calls.filter(c => c[0] === STORES.reviews && c[1] === 'readwrite').length;
    try {
      const saver = createDebouncedReviewSaver(60);
      const r = makeReview();
      saver.scheduleSave(r);
      const completed = { ...r, completedAt: Date.now() };
      await saver.saveNow(completed);

      expect((await getReview(r.id))?.completedAt).toBe(completed.completedAt);
      const savesAfterSaveNow = writeCount();
      expect(savesAfterSaveNow).toBe(1);

      // Let the (cancelled) pending timer's window pass; it must not fire
      // and overwrite the completed save with stale in-progress state.
      await wait(100);
      expect(writeCount()).toBe(savesAfterSaveNow);
      expect((await getReview(r.id))?.completedAt).toBe(completed.completedAt);
      saver.dispose();
    } finally {
      txSpy.mockRestore();
    }
  });

  it('dispose cancels a pending save without persisting it', async () => {
    const saver = createDebouncedReviewSaver(30);
    const r = makeReview();
    saver.scheduleSave(r);
    saver.dispose();

    await wait(80);
    expect(await getReview(r.id)).toBeNull();
  });

  it('reports a failed debounced save via onError instead of an unhandled rejection', async () => {
    // scheduleSave's eventual write is fire-and-forget (nothing awaits it),
    // so a rejection there cannot surface on any promise a caller holds —
    // it must be caught internally or it becomes an unhandled rejection.
    const db = await getDb();
    const original = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      if (args[0] === STORES.reviews && args[1] === 'readwrite') {
        throw new Error('boom');
      }
      return (original as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.transaction);

    let unhandled: unknown = 'not set';
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const errors: Array<{ error: unknown; review: Review }> = [];
    const saver = createDebouncedReviewSaver(30, (error, review) => {
      errors.push({ error, review });
    });

    try {
      const r = makeReview();
      saver.scheduleSave(r);
      await wait(80);

      expect(errors.length).toBe(1);
      expect(errors[0].review.id).toBe(r.id);
      expect((errors[0].error as Error).message).toBe('boom');

      // The failed write must not have landed.
      txSpy.mockRestore();
      expect(await getReview(r.id)).toBeNull();

      // Give a would-be unhandled rejection a chance to surface as one.
      await wait(0);
      expect(unhandled).toBe('not set');
    } finally {
      saver.dispose();
      txSpy.mockRestore();
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
