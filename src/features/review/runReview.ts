import { mapWithConcurrency } from '../../lib/concurrency';
import type { DocumentFile, Finding, ReviewRun, Settings, Template } from '../../types';
import { extractClause } from './extractClause';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function emptyRun(template: Template, docs: DocumentFile[]): ReviewRun {
  const findings: ReviewRun['findings'] = {};
  for (const doc of docs) {
    findings[doc.id] = {};
    for (const clause of template.clauses) {
      findings[doc.id][clause.id] = { clauseId: clause.id, status: 'pending', citations: [] };
    }
  }
  return {
    id: uid(),
    // Deep copy: editing the template afterwards must not change what this run claims to have checked.
    templateSnapshot: structuredClone(template),
    documentIds: docs.map(d => d.id),
    findings,
    startedAt: Date.now(),
  };
}

export function runProgress(run: ReviewRun): { done: number; total: number; errors: number } {
  let done = 0;
  let total = 0;
  let errors = 0;
  for (const byClause of Object.values(run.findings)) {
    for (const finding of Object.values(byClause)) {
      total++;
      if (finding.status === 'done' || finding.status === 'error') done++;
      if (finding.status === 'error') errors++;
    }
  }
  return { done, total, errors };
}

/**
 * How many clause instances across the whole run (every document x every
 * clause) came back with `noContent: true` — a schema-valid but empty
 * response from `extractClause`. A single one of these among otherwise
 * populated findings is unremarkable (see empty-review-investigation.md);
 * this exists so run-level UI can show the raw count and let the user judge
 * whether the pattern looks like "a clause or two is genuinely silent" or
 * "this document didn't get reviewed at all."
 */
export function countNoContent(run: ReviewRun): number {
  let count = 0;
  for (const byClause of Object.values(run.findings)) {
    for (const finding of Object.values(byClause)) {
      if (finding.noContent) count++;
    }
  }
  return count;
}

function withFinding(run: ReviewRun, docId: string, finding: Finding): ReviewRun {
  return {
    ...run,
    findings: {
      ...run.findings,
      [docId]: { ...run.findings[docId], [finding.clauseId]: finding },
    },
  };
}

function isAbort(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError') ||
    (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Marks every cell still `pending` at the moment a run is cancelled as
 * `cancelled` instead. Without this, a queued cell that never got a turn
 * before `AbortController.abort()` fired stayed "Pending" forever — with
 * nothing on screen to say the run had actually stopped, contradicting
 * App.tsx's own (correct) treatment of an abort as a deliberate stop, not a
 * failure. `running` cells are not swept here: each one resolves through
 * `extractClause`'s own AbortError handling to a `cancelled` Finding on its
 * own, via the normal `onUpdate` call below.
 */
function cancelPendingCells(run: ReviewRun): ReviewRun {
  let next = run;
  for (const [docId, byClause] of Object.entries(run.findings)) {
    for (const finding of Object.values(byClause)) {
      if (finding.status === 'pending') {
        next = withFinding(next, docId, { clauseId: finding.clauseId, status: 'cancelled', citations: [] });
      }
    }
  }
  return next;
}

export async function runReview(
  initial: ReviewRun,
  docs: DocumentFile[],
  settings: Settings,
  onUpdate: (run: ReviewRun) => void,
  signal?: AbortSignal,
): Promise<ReviewRun> {
  const template = initial.templateSnapshot;
  const cells = docs.flatMap(doc => template.clauses.map(clause => ({ doc, clause })));

  let current = initial;

  try {
    await mapWithConcurrency(
      cells,
      settings.concurrency,
      async ({ doc, clause }) => {
        current = withFinding(current, doc.id, {
          clauseId: clause.id, status: 'running', citations: [],
        });
        onUpdate(current);

        const finding = await extractClause(doc, clause, template, settings, signal);
        current = withFinding(current, doc.id, finding);
        onUpdate(current);
      },
      signal,
    );
  } catch (error) {
    if (isAbort(error)) {
      current = { ...cancelPendingCells(current), cancelledAt: Date.now() };
      onUpdate(current);
    }
    throw error;
  }

  current = { ...current, completedAt: Date.now() };
  onUpdate(current);
  return current;
}

export async function retryCell(
  run: ReviewRun,
  doc: DocumentFile,
  clauseId: string,
  settings: Settings,
  onUpdate: (run: ReviewRun) => void,
): Promise<ReviewRun> {
  const clause = run.templateSnapshot.clauses.find(c => c.id === clauseId);
  // Deliberately return the identical `run` reference: an unknown clause id
  // is a genuine no-op, and a caller memoising on identity (e.g. React)
  // should see no change rather than being handed a fresh object that
  // triggers a pointless re-render.
  if (!clause) return run;

  let current = withFinding(run, doc.id, { clauseId, status: 'running', citations: [] });
  onUpdate(current);

  const finding = await extractClause(doc, clause, run.templateSnapshot, settings);
  current = withFinding(current, doc.id, finding);
  onUpdate(current);
  return current;
}
