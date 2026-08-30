import { describe, it, expect } from 'vitest';
import { emptyRun, runProgress } from './runReview';
import type { DocumentFile, PlaybookVersion, ReviewTarget } from '../../types';

const template: PlaybookVersion = {
  id: 't1', name: 'T', contractType: 'NDA',
  systemPrompt: 's', formatPrompt: 'f',
  clauses: [
    { id: 'c1', title: 'Term', extractPrompt: 'p1' },
    { id: 'c2', title: 'Law', extractPrompt: 'p2' },
  ],
  playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
};

function doc(id: string): DocumentFile {
  return { id, name: `${id}.pdf`, kind: 'pdf', text: 'body', file: new File([''], `${id}.pdf`) };
}


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

/*
 * `runReview`'s AND `retryCell`'s SUITES ARE GONE WITH THEM (Tasks 18 and
 * 20).
 *
 * What they proved — the fan-out, the concurrency ceiling, the abort that
 * leaves no cell pending forever, the collection run keyed by the
 * collection, the retry that resets a confirmed net position — is proved
 * against a real Postgres now, in `runWorker.pg.test.ts`,
 * `runLifecycle.pg.test.ts` and `rerunReset.pg.test.ts`, over the SAME
 * extractors out of `@lexprompt/core`.
 *
 * `emptyRun`'s cases stay: it is what the browser still owns, the
 * optimistic shape a just-clicked run renders between the click and the
 * server's first answer. Its collection case is the one that would have
 * caught Task 6A's hole, and it is still here.
 */
