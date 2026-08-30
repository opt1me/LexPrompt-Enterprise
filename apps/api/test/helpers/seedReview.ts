import { expect } from 'vitest';
import { asUser, type TestAccount } from './twoAccounts.ts';

/**
 * ONE REVIEW, ONE CLAUSE, ONE `done` FINDING NOBODY HAS JUDGED YET.
 *
 * Extracted from `twoAccounts.compose.test.ts`, which had the only copy,
 * when a second and a third compose suite needed the same fixture
 * (`replicaFanout`, `livePush`). Extracted at TWO rather than at three, per
 * `CLAUDE.md`'s "when you find yourself writing a second copy, extract it
 * then" — `uid()` is what waiting for the seventh copy looks like.
 *
 * Seeded over HTTP as the signed-in person rather than by reaching into
 * Postgres, so every row it produces carries the attribution the API would
 * actually have given it. The findings map travels on the CREATE — `PUT
 * /v1/reviews/:id` accepts findings for a review this workspace has never
 * seen (`importFindings`) and refuses them on an update — and the import
 * records the authenticated actor and nobody else.
 */
export interface Seeded {
  matterId: string;
  reviewId: string;
  findingsKey: string;
  clauseId: string;
}

const now = (): number => Date.now();

export async function seedOneDoneFinding(
  who: TestAccount, label = 'seeded review',
): Promise<Seeded> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const seeded: Seeded = {
    matterId: `s-${stamp}`,
    reviewId: `s-${stamp}-review`,
    findingsKey: 'd1',
    clauseId: 'c1',
  };

  const matter = await asUser(who, 'PUT', `/v1/matters/${seeded.matterId}`,
    { name: label, createdAt: now() });
  expect(matter.status, await matter.text()).toBe(200);

  const review = await asUser(who, 'PUT', `/v1/reviews/${seeded.reviewId}`, {
    matterId: seeded.matterId,
    playbookSnapshot: { id: 'p1', name: label, clauses: [] },
    // No documents: these suites are about WHO changed a judgement and how
    // fast it arrives, and a document would add an upload, a parse and a
    // blob to a test that asserts nothing about any of them.
    // `findingsKeyFor` returns the key itself for a `documents` target, so
    // 'd1' is a key this review's own target explains.
    target: { kind: 'documents', documentIds: [] },
    documentIds: [],
    modelId: 'test-model',
    startedAt: now(),
    findings: {
      [seeded.findingsKey]: {
        [seeded.clauseId]: {
          clauseId: seeded.clauseId,
          status: 'done',
          summary: 'Liability is capped at the fees paid in the preceding 12 months.',
          citations: [],
        },
      },
    },
  });
  expect(review.status, await review.text()).toBe(200);
  return seeded;
}

export const dispositionPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/disposition`;

export const notesPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/notes`;

/**
 * Removes what a suite created. `test:pg` and `test:compose` share ONE
 * database, and a suite that leaves state behind breaks a different file
 * with a message pointing at the wrong feature.
 *
 * The review first: a matter delete cascades, but deleting in dependency
 * order means a failure names the record that actually resisted rather than
 * a foreign key.
 */
export async function removeSeeded(who: TestAccount, seeded: Seeded): Promise<void> {
  await asUser(who, 'DELETE', `/v1/reviews/${seeded.reviewId}`);
  await asUser(who, 'DELETE', `/v1/matters/${seeded.matterId}`);
}
