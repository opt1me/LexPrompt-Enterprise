import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '../../test/mount';
import { ReviewVersionLine } from './ReviewVersionLine';
import { publishVersion, getVersion } from '../../lib/db/playbookVersions';
import { deletePlaybook } from '../../lib/db/playbooks';
import { saveReview, getReview } from '../../lib/db/reviews';
import { migrateDraft } from '../../lib/db/playbookMigration';
import { closeDb } from '../../lib/db/open';
import type { PlaybookVersion, Review } from '../../types';

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
  function draftFrom(version: PlaybookVersion) {
    return migrateDraft(version, version.name);
  }

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
    const v1 = await publishVersion('pb-dangling', draftFrom(makeVersionInput()), 'u1');
    await saveReview(makeReview(v1.id));

    // Task 3's cascade: deleting the playbook removes its versions with it,
    // but `getReview` must still return the review with its id intact
    // (R-D15) rather than clearing it — reviewed at the storage layer in
    // `reviews.test.ts`; this test picks up from there and drives the
    // result into the actual rendering decision.
    await deletePlaybook('pb-dangling');

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
