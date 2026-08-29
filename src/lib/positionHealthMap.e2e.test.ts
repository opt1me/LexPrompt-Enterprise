import { describe, it, expect, afterEach } from 'vitest';
import { buildPositionHealthMap } from './positionHealthMap';
import { positionHealthLabel } from './positionHealth';
import { saveReview, getReview, listReviews } from './db/reviews';
import { closeDb } from './db/open';
import { SCHEMA_VERSION } from '../types';
import type { Finding, PlaybookDraft, PlaybookVersion, Review } from '../types';

afterEach(() => closeDb());

// The critical fix found in browser verification: every layer here —
// `publishVersion`, `saveReview`/`getReview`/`listReviews` (and the
// `migrateReviewRecord`/`migrateFinding` repair they funnel every read
// through), and `buildPositionHealthMap` — was individually correct and
// individually tested. The defect (`migrateFinding` silently dropping
// `positionOutcome`/`positionRationale` on every read) lived only in the
// SEAM between them, which is exactly why a green unit suite at every layer
// did not catch it. This test drives a real save/reopen round trip through
// the actual `getReview`/`listReviews` path — the same path the app's own
// screens use — rather than constructing an already-migrated `Review` object
// by hand, so a regression in the read path fails THIS test even though
// every layer's own unit tests stay green.
describe('end to end: a verified meets survives a real save/reopen and is counted HELD', () => {
  function draft(): PlaybookDraft {
    return {
      name: 'Lease Review',
      contractType: 'Lease',
      systemPrompt: 's',
      formatPrompt: 'f',
      clauses: [
        {
          id: 'c1',
          title: 'Break notice',
          extractPrompt: 'What is the break notice period?',
          standardPosition: { text: 'We ask for six months.', origin: 'authored', reviewedByHuman: true },
        },
      ],
      changeSummary: '',
    };
  }

  it('reads HELD 1 of 1 after saveReview -> getReview -> buildPositionHealthMap', async () => {
    // Built here rather than published through a store. Stage 2 Task 13 made
    // publishing one route running one Postgres transaction, proved against
    // a real database in `apps/api/test/playbooks.pg.test.ts`; what this
    // test is about is the SEAM below it — `saveReview`/`getReview` and the
    // `migrateReviewRecord`/`migrateFinding` repair they funnel every read
    // through — and a version is a fixture to that, not a subject.
    const version: PlaybookVersion = {
      ...draft(),
      id: 'v-e2e-health',
      playbookId: 'pb-e2e-health',
      version: 1,
      publishedAt: Date.now(),
      publishedByUserId: 'u1',
      schemaVersion: SCHEMA_VERSION,
    };

    const finding: Finding = {
      clauseId: 'c1',
      status: 'done',
      summary: 'The break notice period is six months.',
      citations: [],
      verification: { state: 'verified', byUserId: 'u1', at: version.publishedAt + 1 },
      notes: [],
      positionOutcome: 'meets',
      positionRationale: 'Matches our standard exactly.',
    };

    const review: Review = {
      id: 'rev-e2e-health',
      matterId: 'matter-e2e-health',
      playbookSnapshot: version,
      documentIds: ['doc-1'],
      target: { kind: 'documents', documentIds: ['doc-1'] },
      findings: { 'doc-1': { c1: finding } },
      modelId: 'test-model',
      startedAt: Date.now(),
      createdByUserId: 'u1',
      playbookVersionId: version.id,
    };

    await saveReview(review);

    // Reopen through the SAME two read paths the app itself uses: `getReview`
    // for a single opened review, and `listReviews` for the cross-matter scan
    // `loadPositionHealth` (App.tsx) performs. Both funnel through `stripSeq`
    // -> `migrateReviewRecord` -> `migrateFinding`.
    const reopened = await getReview(review.id);
    const listed = await listReviews('matter-e2e-health');
    expect(reopened).not.toBeNull();
    expect(listed).toHaveLength(1);

    // Prove the read path itself is what is under test: the outcome and
    // rationale must have actually survived the round trip before asking
    // whether health counts them.
    const reopenedFinding = reopened!.findings['doc-1']['c1'];
    expect(reopenedFinding.positionOutcome).toBe('meets');
    expect(reopenedFinding.positionRationale).toBe('Matches our standard exactly.');

    const map = buildPositionHealthMap({
      clauses: version.clauses,
      versions: [version],
      reviews: listed,
    });

    expect(positionHealthLabel(map['c1'])).toBe('HELD 1 of 1');
  });
});
