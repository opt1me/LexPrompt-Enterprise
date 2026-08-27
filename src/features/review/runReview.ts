import { mapWithConcurrency } from '../../lib/concurrency';
import type { DocumentFile, Finding, ReviewRun, ReviewTarget, Settings, Template } from '../../types';
import { extractClause } from './extractClause';
import { extractCollectionClause } from './extractCollectionClause';
import { unchecked } from '../../lib/verification';
import { uid } from '../../lib/uid';
import type { CollectionMember } from '../../lib/collectionOrder';
import { findingsKeyFor, isCollectionTarget } from '../../lib/reviewTarget';

function pendingFinding(clauseId: string): Finding {
  return { clauseId, status: 'pending', citations: [], verification: unchecked(), notes: [] };
}

/**
 * `target` defaults to a `documents` target over exactly `docs` — so every
 * existing caller (which passes no target at all) keeps seeding one entry
 * per document per clause, keyed by document id, unchanged (a deliberate
 * regression pin: see `runReview.test.ts`).
 *
 * A `collection` target seeds the opposite shape: ONE entry per clause,
 * keyed by the collection id (`findingsKeyFor`) — never one per document.
 * This is what closes Task 6A's hole: before this, `emptyRun` always
 * seeded per document regardless of target, so a collection run's results
 * (written under the collection key by `runReview`'s collection branch)
 * landed beside pending per-document cells that nothing ever touched —
 * stuck on "Pending" forever, with the real results nothing displayed.
 * Seeding through the same `findingsKeyFor` the collection branch writes
 * through means the two can no longer disagree about which key holds a
 * clause's result.
 */
export function emptyRun(template: Template, docs: DocumentFile[], target?: ReviewTarget): ReviewRun {
  const resolvedTarget: ReviewTarget = target ?? { kind: 'documents', documentIds: docs.map(d => d.id) };
  const findings: ReviewRun['findings'] = {};

  if (isCollectionTarget(resolvedTarget)) {
    const key = findingsKeyFor(resolvedTarget);
    findings[key] = {};
    for (const clause of template.clauses) {
      findings[key][clause.id] = pendingFinding(clause.id);
    }
  } else {
    for (const doc of docs) {
      findings[doc.id] = {};
      for (const clause of template.clauses) {
        findings[doc.id][clause.id] = pendingFinding(clause.id);
      }
    }
  }

  return {
    id: uid(),
    // Deep copy: editing the template afterwards must not change what this run claims to have checked.
    templateSnapshot: structuredClone(template),
    documentIds: docs.map(d => d.id),
    target: resolvedTarget,
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
        next = withFinding(next, docId, {
          clauseId: finding.clauseId, status: 'cancelled', citations: [], verification: unchecked(), notes: [],
        });
      }
    }
  }
  return next;
}

/**
 * What a collection run needs beyond the ordinary per-document fan-out: the
 * target that names the collection (so results key by it — `findingsKeyFor`
 * — rather than by any one document) and the ordered, hydrated members every
 * clause is read across in a single call (`orderedMembers`' output; the
 * caller hydrates via `documentFileForReview` before building it, exactly as
 * it already hydrates `docs` for the standalone path).
 *
 * Kept as its own optional parameter rather than folded into `ReviewRun`
 * itself, so the existing per-document path — and every test that calls
 * `runReview` without it — is untouched by this addition.
 */
export interface CollectionRunInput {
  target: Extract<ReviewTarget, { kind: 'collection' }>;
  members: CollectionMember<DocumentFile>[];
}

export async function runReview(
  initial: ReviewRun,
  docs: DocumentFile[],
  settings: Settings,
  onUpdate: (run: ReviewRun) => void,
  signal?: AbortSignal,
  collection?: CollectionRunInput,
): Promise<ReviewRun> {
  const template = initial.templateSnapshot;

  let current = initial;

  try {
    if (collection) {
      // A collection review makes ONE model call per clause over every
      // member together, not one call per document per clause — a different
      // *shape* of work list, not a different engine: same concurrency
      // limiter, same abort handling, same progressive onUpdate emission.
      const key = findingsKeyFor(collection.target);
      await mapWithConcurrency(
        template.clauses,
        settings.concurrency,
        async clause => {
          current = withFinding(current, key, {
            clauseId: clause.id, status: 'running', citations: [], verification: unchecked(), notes: [],
          });
          onUpdate(current);

          const finding = await extractCollectionClause(collection.members, clause, template, settings, signal);
          current = withFinding(current, key, finding);
          onUpdate(current);
        },
        signal,
      );
    } else {
      // The standalone path, unchanged: every document x every clause.
      const cells = docs.flatMap(doc => template.clauses.map(clause => ({ doc, clause })));
      await mapWithConcurrency(
        cells,
        settings.concurrency,
        async ({ doc, clause }) => {
          current = withFinding(current, doc.id, {
            clauseId: clause.id, status: 'running', citations: [], verification: unchecked(), notes: [],
          });
          onUpdate(current);

          const finding = await extractClause(doc, clause, template, settings, signal);
          current = withFinding(current, doc.id, finding);
          onUpdate(current);
        },
        signal,
      );
    }
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

  let current = withFinding(run, doc.id, {
    clauseId, status: 'running', citations: [], verification: unchecked(), notes: [],
  });
  onUpdate(current);

  const finding = await extractClause(doc, clause, run.templateSnapshot, settings);
  current = withFinding(current, doc.id, finding);
  onUpdate(current);
  return current;
}
