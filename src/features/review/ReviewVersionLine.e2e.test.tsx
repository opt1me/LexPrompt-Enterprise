import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount } from '../../test/mount';
import { ReviewVersionLine } from './ReviewVersionLine';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import type { PlaybookVersion, Review } from '../../types';

// Stage 2 Task 13 made the playbook repositories HTTP clients, so the
// storage half of this end-to-end test — publish, then delete, and watch the
// version stop resolving — now happens in Postgres and is proved there
// (`apps/api/test/playbooks.pg.test.ts`: "takes its versions with it and
// CLEARS a review's pointer rather than failing on it"). Only the NETWORK is
// replaced here. The real `getVersion`, the real `getReview` and its
// `migrateReviewRecord` repair, and the real component all still run, which
// is what this file was ever for: the wiring between them, not each half's
// own unit test agreeing with the other's.
const transport = makeFakeTransport();
vi.mock('../../lib/api/client', () => transportModule(transport));

const { getVersion } = await import('../../lib/db/playbookVersions');
const { deletePlaybook } = await import('../../lib/db/playbooks');
const { saveReview, getReview } = await import('../../lib/db/reviews');
const { migrateDraft } = await import('../../lib/db/playbookMigration');
const { closeDb } = await import('../../lib/db/open');

beforeEach(() => {
  transport.reset();
  transport.echoWrites = true;
});
afterEach(() => closeDb());

// End-to-end for R-D15's dangling case: `reviews.test.ts` already proves at
// the storage layer that `getReview` keeps a stale `playbookVersionId` and
// that `getVersion` for it returns `null`, but nothing drove that all the
// way through to what actually renders. `reviewMigration` deliberately
// keeps the stale id rather than clearing it (so a caller can still tell
// "never recorded" apart from "recorded, then deleted"), and
// `ReviewVersionLine` is the ONE place that distinction is supposed to turn
// into words — this test is what actually proves the wiring between them,
// rather than each half's own unit tests merely being consistent with each
// other.
describe('a dangling playbookVersionId, read through the real getReview, renders as deleted', () => {
  function makeVersionInput(): PlaybookVersion {
    return {
      id: 'placeholder',
      playbookId: 'pb-dangling',
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

  function makeReview(playbookVersionId: string): Review {
    return {
      id: 'rev-dangling',
      matterId: 'matter-dangling',
      playbookSnapshot: makeVersionInput(),
      documentIds: ['doc-1'],
      target: { kind: 'documents', documentIds: ['doc-1'] },
      findings: {},
      modelId: 'test-model',
      startedAt: Date.now(),
      createdByUserId: 'owner-1',
      playbookVersionId,
    };
  }

  it('renders "deleted", not a version claim and not silence, for a review whose version was deleted', async () => {
    const v1: PlaybookVersion = {
      ...migrateDraft(makeVersionInput(), 'NDA'),
      id: 'v-dangling', playbookId: 'pb-dangling', version: 1,
      publishedAt: Date.now(), publishedByUserId: 'u1', schemaVersion: 7,
    };
    // The version RESOLVES while the playbook is there…
    transport.responses.set(`/v1/versions/${v1.id}`, v1);
    transport.responses.set('/v1/playbooks/pb-dangling', { id: 'pb-dangling' });
    expect(await getVersion(v1.id)).not.toBeNull();
    await saveReview(makeReview(v1.id));

    // Task 3's cascade: deleting the playbook removes its versions with it,
    // but `getReview` must still return the review with its id intact
    // (R-D15) rather than clearing it — reviewed at the storage layer in
    // `reviews.test.ts`; this test picks up from there and drives the
    // result into the actual rendering decision.
    await deletePlaybook('pb-dangling');
    // …and stops resolving once it is gone, which is the cascade proved
    // against a real Postgres and reproduced here as the answer it gives.
    transport.responses.delete(`/v1/versions/${v1.id}`);

    const reopened = await getReview('rev-dangling');
    expect(reopened).not.toBeNull();
    expect(reopened!.playbookVersionId).toBe(v1.id);

    const resolved = await getVersion(reopened!.playbookVersionId!);
    expect(resolved).toBeNull();

    // This is the render decision a caller (App.tsx/ResultsView) makes from
    // exactly those two values — reproduced here directly against the real
    // component so a future change to either the migration's id-keeping
    // behaviour or the component's branch order is caught by an assertion
    // that spans both, not by two separately-green unit tests.
    const out = mount(
      <ReviewVersionLine versionId={reopened!.playbookVersionId} version={resolved} />,
    ).textContent!;
    expect(out).toMatch(/deleted|no longer exists/i);
    expect(out).not.toMatch(/ran against v/i);
    expect(out).not.toMatch(/no longer recorded|not recorded/i);
  });
});
