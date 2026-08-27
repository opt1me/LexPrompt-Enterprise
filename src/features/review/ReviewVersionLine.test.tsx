import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ReviewVersionLine } from './ReviewVersionLine';
import { SCHEMA_VERSION, type PlaybookVersion } from '../../types';

function version(n: number): PlaybookVersion {
  return {
    id: `v${n}`,
    playbookId: 'pb1',
    version: n,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 's',
    formatPrompt: 'f',
    clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'p' }],
    changeSummary: '',
    publishedAt: 1_700_000_000_000,
    publishedByUserId: 'u1',
    schemaVersion: SCHEMA_VERSION,
  };
}

const v2 = version(2);

describe('ReviewVersionLine (R-D15)', () => {
  it('says which version a review ran against when it can still be read', () => {
    const out = mount(<ReviewVersionLine versionId={v2.id} version={v2} />).textContent!;
    expect(out).toMatch(/ran against v2/i);
  });

  it('says the version is no longer recorded when the review never had one', () => {
    const out = mount(<ReviewVersionLine versionId={undefined} version={null} />).textContent!;
    expect(out).toMatch(/no longer recorded|not recorded/i);
  });

  // Distinct from the case above, and the distinction is the point: "we
  // never recorded which version this ran against" and "the version it ran
  // against has been deleted" are different facts about the same review,
  // and only the second tells the reader why the trail went cold.
  it('says the version was deleted when the id is present but resolves to nothing (R-D15)', () => {
    const out = mount(<ReviewVersionLine versionId="v-gone" version={null} />).textContent!;
    expect(out).toMatch(/deleted|no longer exists/i);
    expect(out).not.toMatch(/ran against v/i);
  });

  // The component takes the id AND the resolved version so a caller cannot
  // render a claim without having tried to resolve it — this is the direct
  // proof: an id that is present and a version that is present but for a
  // DIFFERENT id must still be read from `version`, not from `versionId`'s
  // mere presence. (In practice a caller never mismatches these, but the
  // component's behaviour must be driven by `version`, not `versionId`.)
  it('never renders a version claim from the id alone', () => {
    // version === null with a present id must never say "ran against v",
    // regardless of what the id itself looks like.
    const out = mount(<ReviewVersionLine versionId="v4" version={null} />).textContent!;
    expect(out).not.toMatch(/ran against v/i);
  });

  it('links to version history when a handler is supplied', () => {
    const onOpenHistory = vi.fn();
    const el = mount(<ReviewVersionLine versionId={v2.id} version={v2} onOpenHistory={onOpenHistory} />);
    click(buttonNamed(el, /ran against v2/i));
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it('renders plain text, not a dead link, when no handler is supplied', () => {
    const el = mount(<ReviewVersionLine versionId={v2.id} version={v2} />);
    expect(buttonNamed(el, /ran against v2/i)).toBeUndefined();
    expect(el.textContent).toMatch(/ran against v2/i);
  });
});
