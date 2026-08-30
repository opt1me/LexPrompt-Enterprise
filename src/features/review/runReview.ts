import { unchecked, uid, findingsKeyFor, isCollectionTarget } from '@lexprompt/core';
import type { CollectionMember } from '@lexprompt/core';
import type { DocumentFile, Finding, ReviewRun, ReviewTarget, PlaybookVersion } from '../../types';

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
export function emptyRun(template: PlaybookVersion, docs: DocumentFile[], target?: ReviewTarget): ReviewRun {
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
    // `template` is always a real, already-published `PlaybookVersion` by
    // the time it reaches here (App.tsx's callers source it from
    // `getPlaybookContent`/`activeTemplate`), so its `id` IS the version
    // this run is running against — not invented here. Conditional, never
    // set to `undefined`, for the same `structuredClone`-preserves-the-key
    // reason `reviewFromRun` guards the mirrored field in `App.tsx`.
    ...(template.id ? { playbookVersionId: template.id } : {}),
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

/*
 * `runReview` AND `retryCell` ARE GONE (Tasks 18 and 20).
 *
 * They were the browser's review engine: `runReview` fanned `extractClause`
 * across a document x clause matrix with bounded concurrency, and
 * `retryCell` re-ran one cell. Both are the server's now — a run is
 * `POST /v1/reviews/:id/runs` and a retry is
 * `POST /v1/reviews/:id/findings/:key/:clause/retry` — which is what makes
 * the work outlive the tab that asked for it, and what makes "one writer
 * per finding" true rather than hoped for.
 *
 * They did not move as code. `apps/api/src/run/worker.ts` leases one cell
 * per transaction and calls the SAME `extractClause` /
 * `extractCollectionClause` out of `@lexprompt/core` (§13 Stage 0's whole
 * point: one review engine, two processes). What is deleted here is the
 * orchestration, not the extraction.
 *
 * What stays in this file is what the BROWSER still owns: `emptyRun`, the
 * optimistic shape a just-clicked run renders between the click and the
 * server's first answer; `runProgress` and `countNoContent`, which read a
 * run that is already on screen; and `CollectionRunInput`, which the
 * collection run flow still builds.
 *
 * The abort machinery went with them. A cancellation is a request now
 * (`POST /v1/runs/:id/cancel`), and `cancelPendingCells` lives server-side
 * in `run/lifecycle.ts` — where it can also tell a run somebody STOPPED
 * from one that was reaped, which an `AbortController` never could.
 */

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
