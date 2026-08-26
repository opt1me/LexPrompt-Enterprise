import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyRun, runReview, retryCell, runProgress } from './runReview';
import type { DocumentFile, Settings, Template, Finding } from '../../types';

vi.mock('./extractClause', () => ({ extractClause: vi.fn() }));
const { extractClause } = await import('./extractClause');

const settings: Settings = { apiKey: 'k', modelId: 'm', concurrency: 2 };

const template: Template = {
  id: 't1', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: 's', formatPrompt: 'f',
  clauses: [
    { id: 'c1', title: 'Term', prompt: 'p1' },
    { id: 'c2', title: 'Law', prompt: 'p2' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

function doc(id: string): DocumentFile {
  return { id, name: `${id}.pdf`, kind: 'pdf', text: 'body', file: new File([''], `${id}.pdf`) };
}

const ok = (clauseId: string): Finding =>
  ({ clauseId, status: 'done', summary: 'ok', citations: ['q'] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractClause).mockImplementation(async (_d, c) => ok(c.id));
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
    const originalPrompt = template.clauses[0].prompt;
    template.clauses[0].prompt = 'MUTATED';
    expect(run.templateSnapshot.clauses[0].prompt).toBe(originalPrompt);
    template.clauses[0].prompt = originalPrompt;
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
    vi.mocked(extractClause).mockImplementation(async (_d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom' }
        : ok(c.id));

    const docs = [doc('d1')];
    const run = await runReview(emptyRun(template, docs), docs, settings, () => {});

    expect(run.findings.d1.c1.status).toBe('error');
    expect(run.findings.d1.c2.status).toBe('done');
    expect(runProgress(run)).toEqual({ done: 2, total: 2, errors: 1 });
  });

  it('respects the concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(extractClause).mockImplementation(async (_d, c) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return ok(c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    await runReview(emptyRun(template, docs), docs, { ...settings, concurrency: 2 }, () => {});
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    vi.mocked(extractClause).mockImplementation(async (_d, c) => {
      await new Promise(r => setTimeout(r, 10));
      return ok(c.id);
    });

    const docs = [doc('d1'), doc('d2'), doc('d3')];
    const promise = runReview(emptyRun(template, docs), docs, settings, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 15);

    await expect(promise).rejects.toThrow(/abort/i);
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
    vi.mocked(extractClause).mockImplementation(async (_d, c) =>
      c.id === 'c1'
        ? { clauseId: c.id, status: 'error', citations: [], error: 'boom' }
        : ok(c.id));

    const docs = [doc('d1')];
    const failed = await runReview(emptyRun(template, docs), docs, settings, () => {});

    vi.mocked(extractClause).mockClear();
    vi.mocked(extractClause).mockImplementation(async (_d, c) => ok(c.id));
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
