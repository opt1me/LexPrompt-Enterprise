import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyRun, runReview, retryCell, runProgress, countNoContent } from './runReview';
import type { DocumentFile, Settings, Template, Finding, ReviewTarget, ReviewRun } from '../../types';
import type { CollectionMember } from '../../lib/collectionOrder';

vi.mock('./extractClause', () => ({ extractClause: vi.fn() }));
const { extractClause } = await import('./extractClause');

vi.mock('./extractCollectionClause', () => ({ extractCollectionClause: vi.fn() }));
const { extractCollectionClause } = await import('./extractCollectionClause');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 2 };

const template: Template = {
  id: 't1', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: 's', formatPrompt: 'f',
  clauses: [
    { id: 'c1', title: 'Term', extractPrompt: 'p1' },
    { id: 'c2', title: 'Law', extractPrompt: 'p2' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

function doc(id: string): DocumentFile {
  return { id, name: `${id}.pdf`, kind: 'pdf', text: 'body', file: new File([''], `${id}.pdf`) };
}

const ok = (documentId: string, clauseId: string): Finding =>
  ({
    clauseId, status: 'done', summary: 'ok',
    citations: [{ quote: 'q', documentId }],
    verification: { state: 'unchecked' }, notes: [],
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractClause).mockImplementation(async (d, c) => ok(d.id, c.id));
});

describe('emptyRun', () => {
  it('seeds a pending finding for every document/clause pair', () => {
    const run = emptyRun(template, [doc('d1'), doc('d2')]);
    expect(Object.keys(run.findings)).toEqual(['d1', 'd2']);
    expect(run.findings.d1.c1.status).toBe('pending');
    expect(runProgress(run)).toEqual({ done: 0, total: 4, errors: 0 });
  });

  it('snapshots the template so later edits do not rewrite history', () => {
    const run = emptyRun(template, [doc('d1')]);
    // Mutate a field nested inside an existing clause object, not the
    // top-level clauses array — a shallow copy (`{...template, clauses:
    // [...template.clauses]}`) would still share this inner clause object
    // and would let this mutation leak through, incorrectly passing.
    const originalPrompt = template.clauses[0].extractPrompt;
    template.clauses[0].extractPrompt = 'MUTATED';
    expect(run.templateSnapshot.clauses[0].extractPrompt).toBe(originalPrompt);
    template.clauses[0].extractPrompt = originalPrompt;
  });

  // Regression pin (Task 6A): a documents-target run must seed EXACTLY as
  // it always has — one entry per document per clause, keyed by document
  // id — whether or not a target is passed explicitly. Every existing
  // caller passes no target at all.
  it('for a documents target, seeds exactly as before: one entry per document per clause, keyed by document id', () => {
    const run = emptyRun(template, [doc('d1'), doc('d2')]);
    expect(Object.keys(run.findings).sort()).toEqual(['d1', 'd2']);
    expect(run.findings.d1.c1.status).toBe('pending');
    expect(run.findings.d1.c2.status).toBe('pending');
    expect(run.findings.d2.c1.status).toBe('pending');
    expect(run.findings.d2.c2.status).toBe('pending');
    expect(runProgress(run)).toEqual({ done: 0, total: 4, errors: 0 });
    expect(run.target).toEqual({ kind: 'documents', documentIds: ['d1', 'd2'] });
  });

  it('for a collection target, seeds ONE entry per clause keyed by the collection id, none by document id', () => {
    const target: ReviewTarget = { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] };
    const run = emptyRun(template, [doc('d1'), doc('d2')], target);
    expect(Object.keys(run.findings)).toEqual(['coll-1']);
    expect(run.findings['coll-1'].c1.status).toBe('pending');
    expect(run.findings['coll-1'].c2.status).toBe('pending');
    expect(run.findings.d1).toBeUndefined();
    expect(run.findings.d2).toBeUndefined();
    expect(runProgress(run)).toEqual({ done: 0, total: 2, errors: 0 });
    // The seeded run carries its target, so a consumer never has to guess.
    expect(run.target).toEqual(target);
  });
});

describe('emptyRun + runReview: a collection run writes under the key it was seeded with', () => {
  it('leaves no cell pending — this is the assertion that would have caught Task 6A\'s hole', async () => {
    const target: ReviewTarget = { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] };
    const members: CollectionMember<DocumentFile>[] = [
      { document: doc('d1'), documentId: 'd1', kind: 'original', position: 1 },
      { document: doc('d2'), documentId: 'd2', kind: 'varies', position: 2 },
    ];
    vi.mocked(extractCollectionClause).mockImplementation(async (_members, clause) => ({
      clauseId: clause.id, status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [],
    }));

    const docs = [doc('d1'), doc('d2')];
    const run = await runReview(
      emptyRun(template, docs, target),
      docs,
      settings,
      () => {},
      undefined,
      { target, members },
    );

    // If emptyRun had seeded per-document instead (the hole this task
    // closes), d1/d2 would still hold their never-touched 'pending' seeds
    // alongside the collection's own 'coll-1' results.
    expect(Object.keys(run.findings)).toEqual(['coll-1']);
    const statuses = Object.values(run.findings).flatMap(byClause => Object.values(byClause).map(f => f.status));
    expect(statuses).not.toContain('pending');
    expect(statuses).toEqual(['done', 'done']);
  });
});

describe('runReview', () => {
  it('fills every cell', async () => {
    const docs = [doc('d1'), doc('d2')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    expect(runProgress(run)).toEqual({ done: 4, total: 4, errors: 0 });
    expect(run.completedAt).toBeGreaterThan(0);
  });

  it('reports progress as each cell lands', async () => {
    const docs = [doc('d1')];
    const seen: number[] = [];
    await runReview(emptyRun(template, docs), docs, settings, r => seen.push(runProgress(r).done));
    expect(seen.at(-1)).toBe(2);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('completes the run when one clause fails', async () => {
    vi.mocked(extractClause).mockImplementation(async (d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom', verification: { state: 'unchecked' }, notes: [] }
        : ok(d.id, c.id));

    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});

    expect(run.findings.d1.c1.status).toBe('error');
    expect(run.findings.d1.c2.status).toBe('done');
    expect(runProgress(run)).toEqual({ done: 2, total: 2, errors: 1 });
  });

  it('respects the concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(extractClause).mockImplementation(async (d, c) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return ok(d.id, c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    await runReview(emptyRun(template, docs), docs, { ...settings, concurrency: 2 }, () => {});
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    vi.mocked(extractClause).mockImplementation(async (d, c) => {
      await new Promise(r => setTimeout(r, 10));
      return ok(d.id, c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const promise = runReview(emptyRun(template, docs), docs, settings, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 15);

    await expect(promise).rejects.toThrow(/abort/i);
  });

  // Important 5: a cancelled run must leave cells in a calm, distinct
  // "cancelled" state rather than an error, and a queued cell that never
  // got a turn must not stay "Pending" forever with no indication the run
  // stopped.
  it('marks cells still pending at the moment of cancellation as cancelled, not left pending forever', async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.mocked(extractClause).mockImplementation(async (d, c) => {
      calls++;
      await new Promise(r => setTimeout(r, 20));
      return ok(d.id, c.id);
    });

    // concurrency 2 over 3 documents x 2 clauses = 6 cells: two start
    // immediately, the rest queue behind them.
    const docs = [doc('d1'), doc('d2'), doc('d3')];
    let last: import('../../types').ReviewRun | undefined;
    const promise = runReview(
      emptyRun(template, docs),
      docs,
      { ...settings, concurrency: 2 },
      r => { last = r; },
      controller.signal,
    );
    // Abort before any cell has had time to resolve (they take 20ms).
    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toThrow(/abort/i);
    expect(calls).toBeLessThan(6);
    const statuses = Object.values(last!.findings).flatMap(byClause => Object.values(byClause).map(f => f.status));
    expect(statuses).not.toContain('pending');
    expect(statuses.filter(s => s === 'cancelled').length).toBeGreaterThan(0);
    expect(last!.cancelledAt).toBeGreaterThan(0);
    expect(last!.completedAt).toBeUndefined();
  });

  it('resolves an in-flight cell to cancelled (not error) when its own extraction rejects with AbortError', async () => {
    const controller = new AbortController();
    vi.mocked(extractClause).mockImplementation(async (d, c) => {
      if (c.id === 'c1') return { clauseId: c.id, status: 'cancelled' as const, citations: [], verification: { state: 'unchecked' }, notes: [] };
      return ok(d.id, c.id);
    });

    const docs = [doc('d1')];
    let last: import('../../types').ReviewRun | undefined;
    const promise = runReview(emptyRun(template, docs), docs, settings, r => { last = r; }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
    // Whatever landed for c1 before the sweep must not be 'error'.
    expect(last!.findings.d1.c1.status).not.toBe('error');
  });

  // Task 16: the run-level count that surfaces the "all/nearly all empty"
  // pattern (see empty-review-investigation.md) has to reflect exactly the
  // findings extractClause flagged as no-content, across every document.
  it('counts no-content findings across the whole run via countNoContent', async () => {
    vi.mocked(extractClause).mockImplementation(async (d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'no content', noContent: true, verification: { state: 'unchecked' }, notes: [] }
        : ok(d.id, c.id));

    const docs = [doc('d1'), doc('d2')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});

    // c1 is flagged noContent for both documents; c2 is a normal done finding.
    expect(countNoContent(run)).toBe(2);
  });

  it('reports zero no-content findings for a fully populated run', async () => {
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    expect(countNoContent(run)).toBe(0);
  });

  it('handles a template with no clauses', async () => {
    const bare = { ...template, clauses: [] };
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(bare, docs), docs, settings, () => {});
    expect(runProgress(run)).toEqual({ done: 0, total: 0, errors: 0 });
  });
});

describe('retryCell', () => {
  it('re-runs one cell and leaves its neighbours untouched', async () => {
    vi.mocked(extractClause).mockImplementation(async (d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom', verification: { state: 'unchecked' }, notes: [] }
        : ok(d.id, c.id));

    const docs = [doc('d1')];
    const failed = await runReview(emptyRun(template, docs), docs, settings, () => {});

    vi.mocked(extractClause).mockClear();
    vi.mocked(extractClause).mockImplementation(async (d, c) => ok(d.id, c.id));
    const retried = await retryCell(failed, docs[0], 'c1', settings, () => {});

    expect(retried.findings.d1.c1.status).toBe('done');
    expect(retried.findings.d1.c2.status).toBe('done');
    // Pin retryCell's own behaviour, isolated from runReview's earlier calls:
    // exactly one call, for the specific clause it was asked to retry.
    expect(extractClause).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractClause).mock.calls[0][1].id).toBe('c1');
  });

  it('is a no-op for an unknown clause id', async () => {
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    const same = await retryCell(run, docs[0], 'nope', settings, () => {});
    expect(same.findings).toEqual(run.findings);
  });
});

// Task 8A: a collection run's retry must call the COLLECTION extractor and
// write under the collection key — never fall back to `extractClause`, which
// would silently replace a synthesised net position with a one-document
// answer.
describe('retryCell — a collection run', () => {
  const target: ReviewTarget = { kind: 'collection', collectionId: 'coll-1', documentIds: ['d1', 'd2'] };
  const members: CollectionMember<DocumentFile>[] = [
    { document: doc('d1'), documentId: 'd1', kind: 'original', position: 1 },
    { document: doc('d2'), documentId: 'd2', kind: 'varies', position: 2 },
  ];

  /** A completed collection run whose c1 already carries a CONFIRMED net
   *  position — the case a re-run must clear. c2 is left pending, to prove
   *  a retry on c1 leaves a neighbouring clause untouched. */
  function seededRun(): ReviewRun {
    const run = emptyRun(template, [doc('d1'), doc('d2')], target);
    return {
      ...run,
      findings: {
        'coll-1': {
          c1: {
            clauseId: 'c1', status: 'done', citations: [],
            verification: { state: 'unchecked' }, notes: [],
            netPosition: { proposed: 'Old position.', state: 'confirmed', byUserId: 'u1', at: 1, trail: [] },
          },
          c2: { clauseId: 'c2', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      },
    };
  }

  it('re-runs the COLLECTION extractor, not extractClause, and writes under the collection key', async () => {
    vi.mocked(extractCollectionClause).mockResolvedValue({
      clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [],
      netPosition: { proposed: 'New position.', state: 'unconfirmed', trail: [] },
    });

    const run = seededRun();
    const retried = await retryCell(run, doc('d1'), 'c1', settings, () => {}, { target, members });

    expect(extractCollectionClause).toHaveBeenCalledTimes(1);
    expect(extractClause).not.toHaveBeenCalled();
    // Written under the collection id, not under 'd1' (the `doc` argument
    // retryCell was handed) — no per-document key was created alongside it.
    expect(Object.keys(retried.findings)).toEqual(['coll-1']);
    expect(retried.findings['coll-1'].c1.status).toBe('done');
    expect(retried.findings['coll-1'].c1.netPosition?.proposed).toBe('New position.');
  });

  it('resets a confirmed net position: the retried finding no longer carries the old confirmation', async () => {
    vi.mocked(extractCollectionClause).mockResolvedValue({
      clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [],
      netPosition: { proposed: 'New position.', state: 'unconfirmed', trail: [] },
    });

    const run = seededRun();
    expect(run.findings['coll-1'].c1.netPosition?.state).toBe('confirmed');

    const retried = await retryCell(run, doc('d1'), 'c1', settings, () => {}, { target, members });

    expect(retried.findings['coll-1'].c1.netPosition?.state).toBe('unconfirmed');
    expect(retried.findings['coll-1'].c1.netPosition && 'byUserId' in retried.findings['coll-1'].c1.netPosition).toBe(false);
  });

  it('leaves a neighbouring clause untouched', async () => {
    vi.mocked(extractCollectionClause).mockResolvedValue({
      clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [],
    });
    const run = seededRun();
    const retried = await retryCell(run, doc('d1'), 'c1', settings, () => {}, { target, members });
    expect(retried.findings['coll-1'].c2).toEqual(run.findings['coll-1'].c2);
  });

  it('with no collection argument, behaves exactly as the standalone path (regression pin)', async () => {
    vi.mocked(extractClause).mockImplementation(async (d, c) => ok(d.id, c.id));
    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});
    const retried = await retryCell(run, docs[0], 'c1', settings, () => {});
    expect(extractClause).toHaveBeenCalled();
    expect(extractCollectionClause).not.toHaveBeenCalled();
    expect(retried.findings.d1.c1.status).toBe('done');
  });
});

describe('runReview finding scaffolding', () => {
  it('seeds every pending cell unchecked with no citations and no notes', () => {
    const run = emptyRun(template, [doc('d1'), doc('d2')]);
    for (const byClause of Object.values(run.findings)) {
      for (const finding of Object.values(byClause)) {
        expect(finding.status).toBe('pending');
        expect(finding.citations).toEqual([]);
        expect(finding.verification).toEqual({ state: 'unchecked' });
        expect(finding.notes).toEqual([]);
      }
    }
  });
});
