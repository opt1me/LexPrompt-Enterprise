import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { VersionHistory } from './VersionHistory';
import { SCHEMA_VERSION, type PlaybookVersion } from '../../types';
import { TEST_AUDIENCE } from '../../test/dispositionShapes';

function version(n: number, changeSummary: string): PlaybookVersion {
  return {
    id: `v${n}`,
    playbookId: 'pb1',
    version: n,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 's',
    formatPrompt: 'f',
    clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'p' }],
    changeSummary,
    publishedAt: 1_700_000_000_000 + n,
    publishedByUserId: 'u1',
    schemaVersion: SCHEMA_VERSION,
  };
}

const v1 = version(1, '');
const v2 = version(2, 'Added a break-notice position');
const noop = () => {};

describe('VersionHistory', () => {
  it('lists every version with its number and change summary', () => {
    const out = mount(<VersionHistory versions={[v2, v1]} onClose={noop} />).textContent!;
    expect(out).toContain('v2');
    expect(out).toContain('Added a break-notice position');
    expect(out).toContain('v1');
  });

  // v1 has nothing it could have changed from, so its summary is
  // legitimately empty — and a blank line reads as a rendering failure
  // where a sentence reads as the fact it is.
  it('says in words why the first version has no change summary', () => {
    const out = mount(<VersionHistory versions={[v1]} onClose={noop} />).textContent!;
    expect(out).toMatch(/no change summary/i);
  });

  // A published version is immutable (spec §2): editing produces a NEW
  // version, because a review that says "ran against v4" must be able to
  // prove what v4 was.
  it('offers no way to edit a published version', () => {
    const el = mount(<VersionHistory versions={[v1, v2]} onClose={noop} />);
    expect(el.innerHTML).not.toMatch(/edit this version/i);
    expect(buttonNamed(el, /^edit/i)).toBeUndefined();
  });

  // CLAUDE.md: every screen that loads from IndexedDB distinguishes "empty"
  // from "broken", renders the error branch INSTEAD of the content, and
  // offers a retry.
  it('renders an error branch instead of the list when loading failed', () => {
    const onRetry = vi.fn();
    const el = mount(
      <VersionHistory versions={[]} error="Versions could not be read." onRetry={onRetry} onClose={noop} />,
    );
    expect(el.textContent).not.toMatch(/nothing published yet/i);
    expect(el.textContent).toMatch(/could not be read/i);
    click(buttonNamed(el, /retry/i));
    expect(onRetry).toHaveBeenCalled();
  });

  // The guard used to be `error && onRetry`, so a caller with a failure and
  // no retry handler fell through to the empty state and told the reader
  // "nothing published yet" about a playbook with two published versions.
  // A dead end that says what went wrong beats a lie that reads as a fact.
  it('still says the load failed when the caller offers no retry', () => {
    const el = mount(<VersionHistory versions={[]} error="Versions could not be read." onClose={noop} />);
    expect(el.textContent).toMatch(/could not be read/i);
    expect(el.textContent).not.toMatch(/nothing published yet/i);
    expect(buttonNamed(el, /retry/i)).toBeUndefined();
  });

  // Third state, and the third way to get "empty" wrong: a load still in
  // flight must not read as a playbook with no history.
  it('says it is still loading rather than showing the empty state', () => {
    const out = mount(<VersionHistory versions={[]} loading onClose={noop} />).textContent!;
    expect(out).toMatch(/loading/i);
    expect(out).not.toMatch(/nothing published yet/i);
  });

  it('says plainly when a playbook has no published version yet', () => {
    const out = mount(<VersionHistory versions={[]} onClose={noop} />).textContent!;
    expect(out).toMatch(/nothing published yet/i);
  });

  it('closes through the caller', () => {
    const onClose = vi.fn();
    const el = mount(<VersionHistory versions={[v1]} onClose={onClose} />);
    click(buttonNamed(el, /close/i));
    expect(onClose).toHaveBeenCalled();
  });

  // Task 10: spec §8 / DoD #6 — "a timeline of published versions ... and
  // the matters that used each".
  it('names the matters that used each version', () => {
    const out = mount(
      <VersionHistory versions={[v1]} matterNamesByVersion={{ [v1.id]: ['Acme HQ lease'] }} onClose={noop} />,
    ).textContent!;
    expect(out).toContain('Acme HQ lease');
  });

  // A blank cell reads as a rendering failure; "not used by any review yet"
  // reads as the fact it is. Also proven with the map entirely absent — the
  // fallback for "no caller has gathered reviews" must read the same as
  // "gathered, and it's genuinely empty".
  it('says plainly when no matter has used a version yet', () => {
    expect(mount(<VersionHistory versions={[v1]} matterNamesByVersion={{}} onClose={noop} />).textContent)
      .toMatch(/not used|no reviews/i);
    expect(mount(<VersionHistory versions={[v1]} onClose={noop} />).textContent)
      .toMatch(/not used|no reviews/i);
  });

  /*
   * THESE TWO CHANGED DIRECTION (cross-stage seam review, M2).
   *
   * They pinned "Published by you" for every version with an author, on
   * ruling R1 — one local profile, so the only person who could have
   * published is the person reading. R1 is superseded, and THIS is the screen
   * where that matters most: publishing is the one `partner` write in the
   * whole route table (`POST /v1/playbooks/:id/versions`), so a reviewer
   * cannot publish and a partner can. A reviewer opening version history read
   * "v3 … Published by you" over a partner's changed standard position, with
   * no way to find who actually did it.
   *
   * The raw id is still never printed — that half of the old test is kept.
   */
  it('names the person who published a version, never the reader and never the raw id', () => {
    const out = mount(
      <VersionHistory versions={[v1]} onClose={noop} audience={TEST_AUDIENCE} />,
    ).textContent!;
    expect(out).toContain('Published by A. Trainee');
    expect(out).not.toContain('by you');
    expect(out).not.toContain('u1');
  });

  it('says an id it cannot resolve is one this workspace does not name', () => {
    const stranger = { ...v1, publishedByUserId: 'vzcsj71fs7mtalycwr' };
    const out = mount(
      <VersionHistory versions={[stranger]} onClose={noop} audience={TEST_AUDIENCE} />,
    ).textContent!;
    expect(out).toContain('Published by someone this workspace does not name');
    expect(out).not.toContain('vzcsj71fs7mtalycwr');
  });

  it('says a version with NO recorded author is one the record does not name', () => {
    // It no longer says NOTHING. An author line that disappears reads as
    // "nobody published this", which is the blank-CSV-cell defect at a new
    // surface — and the two absences are different facts: an id the directory
    // could not resolve is about the directory, no id at all is about the
    // record.
    const noAuthor = { ...v1, publishedByUserId: '' };
    const out = mount(
      <VersionHistory versions={[noAuthor]} onClose={noop} audience={TEST_AUDIENCE} />,
    ).textContent!;
    expect(out).toContain('Published by someone this record does not name');
  });
});
