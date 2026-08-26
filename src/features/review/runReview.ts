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

function withFinding(run: ReviewRun, docId: string, finding: Finding): ReviewRun {
  return {
    ...run,
    findings: {
      ...run.findings,
      [docId]: { ...run.findings[docId], [finding.clauseId]: finding },
    },
  };
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
  if (!clause) return run;

  let current = withFinding(run, doc.id, { clauseId, status: 'running', citations: [] });
  onUpdate(current);

  const finding = await extractClause(doc, clause, run.templateSnapshot, settings);
  current = withFinding(current, doc.id, finding);
  onUpdate(current);
  return current;
}
