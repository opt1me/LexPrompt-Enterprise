import React from 'react';
import { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, buttons, click, type } from '../../test/mount';
import { TemplateEditor } from './TemplateEditor';
import type { PlaybookClause, PlaybookDraft, PlaybookVersion, Settings } from '../../types';
import { getDb, closeDb } from '../../lib/db/open';
import { STORES } from '../../lib/db/schema';
import {
  newPlaybook, savePlaybook, saveDraft, getPlaybook, getPlaybookContent, draftFromVersion,
} from '../../lib/db/playbooks';
import { publishVersion } from '../../lib/db/playbookVersions';

// No text()/flush()/fieldMatching() helper exists in `src/test/mount`; these
// are local selectors, the same way PositionComparison.test.tsx writes its
// own. `flush` is this project's idiom for letting an async handler settle
// (see src/App.interrupted.test.tsx).
const flush = () => act(async () => { await Promise.resolve(); });
const nameInput = (c: HTMLElement) => c.querySelector('input') as HTMLInputElement;
const fieldFor = (c: HTMLElement, label: RegExp) =>
  [...c.querySelectorAll('textarea')].find(t =>
    label.test(t.closest('div')?.textContent ?? '')) as HTMLTextAreaElement | undefined;

function version(overrides: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'v1',
    playbookId: 'pb1',
    version: 1,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 'You are a reviewer.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    changeSummary: '',
    publishedAt: 1000,
    publishedByUserId: 'u1',
    schemaVersion: 6,
    ...overrides,
  };
}

const twoClauses: PlaybookClause[] = [
  { id: 'c1', title: 'Term', extractPrompt: 'What is the term?' },
  { id: 'c2', title: 'Rent', extractPrompt: 'What is the rent?' },
];

function draftOf(v: PlaybookVersion): PlaybookDraft {
  return {
    name: v.name,
    contractType: v.contractType,
    systemPrompt: v.systemPrompt,
    formatPrompt: v.formatPrompt,
    clauses: structuredClone(v.clauses),
    changeSummary: '',
  };
}

/** A draft that genuinely DIFFERS from its version. `draftOf(v)` is
 *  byte-identical to `v`, which is now the "nothing to publish" case. */
function editedDraftOf(v: PlaybookVersion): PlaybookDraft {
  return { ...draftOf(v), name: `${v.name} (edited)` };
}

const noop = () => {};
const testSettings: Settings = { apiKey: 'k', modelId: 'test/model', concurrency: 5 };
const wiring = {
  onPersistDraft: noop,
  onShowVersionHistory: noop,
  onPublish: noop,
  onExport: noop,
  onShowMegaPrompt: noop,
  onClose: noop,
  settings: testSettings,
};

describe('TemplateEditor — a published version is never edited in place', () => {
  it('edits into the draft, never into the published version', async () => {
    const onDraftChange = vi.fn();
    const publishedV1 = version();
    // A COPY, so "the version was not mutated" is checked against a
    // known-good value rather than against the object the component holds.
    const published: PlaybookVersion = { ...publishedV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    type(nameInput(c), 'Renamed');
    await flush();

    expect(onDraftChange).toHaveBeenCalled();
    expect(onDraftChange.mock.calls.at(-1)![0].name).toBe('Renamed');
    // The published version object handed in is untouched — this is the
    // assertion the whole immutability rule rests on.
    expect(published.name).toBe(publishedV1.name);
  });

  it('reordering clauses writes into the draft, not the published version', async () => {
    const onDraftChange = vi.fn();
    const twoClauseV1 = version({ clauses: structuredClone(twoClauses) });
    const published: PlaybookVersion = { ...twoClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    // The chevrons are icon-only; they are found by the accessible name a
    // screen reader would announce, which is the name they should have.
    click(buttonNamed(c, /move .*down|down/i));
    await flush();

    expect(onDraftChange.mock.calls.at(-1)![0].clauses.map((cl: PlaybookClause) => cl.id))
      .toEqual(['c2', 'c1']);
    expect(published.clauses.map(cl => cl.id)).toEqual(['c1', 'c2']);
  });

  // Spec §8 asks for drag-based reordering. It is a SECOND affordance over
  // the same reorder path, never a replacement for the chevrons, which are
  // the only one a keyboard can reach.
  it('dragging a clause reorders through the same path, into the draft', async () => {
    const onDraftChange = vi.fn();
    const threeClauseV1 = version({
      clauses: [
        ...structuredClone(twoClauses),
        { id: 'c3', title: 'Break', extractPrompt: 'Any break right?' },
      ],
    });
    const published: PlaybookVersion = { ...threeClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    const handles = [...c.querySelectorAll('[draggable="true"]')];
    const rows = [...c.querySelectorAll('[draggable="true"]')].map(h => h.closest('.group')!);
    expect(handles).toHaveLength(3);

    // Drag the first clause onto the third — a move no chevron press can
    // make in one step, so this cannot be the chevron path in disguise.
    act(() => { handles[0]!.dispatchEvent(new Event('dragstart', { bubbles: true })); });
    act(() => { rows[2]!.dispatchEvent(new Event('drop', { bubbles: true })); });
    await flush();

    expect(onDraftChange.mock.calls.at(-1)![0].clauses.map((cl: PlaybookClause) => cl.id))
      .toEqual(['c2', 'c3', 'c1']);
    expect(published.clauses.map(cl => cl.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('editing a clause writes into the draft, not the published version', async () => {
    const onDraftChange = vi.fn();
    const twoClauseV1 = version({ clauses: structuredClone(twoClauses) });
    const published: PlaybookVersion = { ...twoClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    const titleInputs = [...c.querySelectorAll('input')] as HTMLInputElement[];
    type(titleInputs[1]!, 'Term (edited)');
    await flush();

    expect(onDraftChange.mock.calls.at(-1)![0].clauses[0].title).toBe('Term (edited)');
    expect(published.clauses[0]!.title).toBe('Term');
  });

  it('edits an existing draft rather than starting a new one from the version', async () => {
    const onDraftChange = vi.fn();
    const published = version({ name: 'Lease Review' });
    const draft = { ...draftOf(published), name: 'Half-typed name' };
    const c = mount(
      <TemplateEditor version={published} draft={draft} onDraftChange={onDraftChange} {...wiring} />,
    );

    expect(nameInput(c).value).toBe('Half-typed name');
    type(fieldFor(c, /system persona/i)!, 'A different persona.');
    await flush();

    // The name the user had already typed survives the next edit.
    expect(onDraftChange.mock.calls.at(-1)![0].name).toBe('Half-typed name');
    expect(onDraftChange.mock.calls.at(-1)![0].systemPrompt).toBe('A different persona.');
  });
});

describe('TemplateEditor — publish state', () => {
  it('shows an unpublished-changes state when the draft differs from the version', () => {
    const published = version();
    const c = mount(
      <TemplateEditor version={published} draft={editedDraftOf(published)} onDraftChange={noop} {...wiring} />,
    );
    expect(c.textContent).toMatch(/unpublished changes/i);
  });

  // m2. The guard used to be `draft !== undefined`, so typing a character
  // into the name and deleting it again left Publish enabled over content
  // byte-identical to v1 — while the comment beside it claimed the guard
  // was what stopped two identical versions a millisecond apart. It stops
  // the UNEDITED case now as well as the untouched one.
  it('offers no publish for a draft byte-identical to the published version', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={draftOf(published)} onDraftChange={noop} {...wiring} />,
    );
    expect(buttonNamed(c, /publish/i)?.disabled).toBe(true);
    expect(c.textContent).not.toMatch(/unpublished changes/i);
  });

  it('shows no unpublished-changes state when the version is what is on screen', () => {
    const c = mount(
      <TemplateEditor version={version()} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(c.textContent).not.toMatch(/unpublished changes/i);
    expect(c.textContent).toContain('v1');
  });

  it('says a playbook with no published version has never been published', () => {
    const c = mount(
      <TemplateEditor version={undefined} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(c.textContent).toMatch(/not published yet/i);
  });

  // Publishing an unchanged version would produce two byte-identical
  // versions minutes apart — the exact corruption already found in a real
  // library, which the version history then cannot explain.
  it('offers no publish when there is nothing unpublished to publish', () => {
    const c = mount(
      <TemplateEditor version={version()} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(buttonNamed(c, /publish/i)?.disabled).toBe(true);
  });

  it('publishes through the caller when there are unpublished changes', () => {
    const onPublish = vi.fn();
    const published = version();
    const c = mount(
      <TemplateEditor
        version={published}
        draft={editedDraftOf(published)}
        onDraftChange={noop}
        {...wiring}
        onPublish={onPublish}
      />,
    );
    const publish = buttonNamed(c, /publish/i)!;
    expect(publish.disabled).toBe(false);
    click(publish);
    expect(onPublish).toHaveBeenCalled();
  });

  // Spec 8: the editor gains "a link to version history". It was absent
  // (review M3) — the author could publish v4 from this screen with no way
  // from it to see what v1–v3 said, in the sub-project whose whole point is
  // being able to answer that.
  it('links to the version history', () => {
    const onShowVersionHistory = vi.fn();
    const c = mount(
      <TemplateEditor
        version={version()}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        onShowVersionHistory={onShowVersionHistory}
      />,
    );
    click(buttonNamed(c, /version history/i));
    expect(onShowVersionHistory).toHaveBeenCalledTimes(1);
  });

  // A playbook with no published version has no history, and a live link to
  // an empty screen is a promise the app cannot keep.
  it('does not offer version history for a playbook that has never been published', () => {
    const c = mount(
      <TemplateEditor version={undefined} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(buttonNamed(c, /version history/i)?.disabled).toBe(true);
  });

  // Task 3 put a "What changed? (required after v1)" input in the header as
  // a stopgap, because Save published a version. PublishDialog owns that
  // field now, and two homes for one field is how they drift apart.
  it('no longer asks what changed in the header', () => {
    const published = version();
    const c = mount(
      <TemplateEditor version={published} draft={editedDraftOf(published)} onDraftChange={noop} {...wiring} />,
    );
    expect(c.querySelector('[aria-label="What changed?"]')).toBeNull();
    expect(c.textContent).not.toMatch(/required after v1/i);
  });
});

// Minor 5 (integrity review). The editor used to write `riskTolerance: ''`
// on an emptied field rather than deleting the key, so `hasUnpublishedContent`
// — which compares against `draftFromVersion`'s omitted key for an unset
// tolerance — saw a real diff. A published playbook with no Global Risk
// Tolerance, typed into and cleared again, kept reporting "unpublished
// changes" and left Publish enabled over a draft that reviews identically to
// what is already published.
describe('TemplateEditor — Global Risk Tolerance ("" vs absent, Minor 5)', () => {
  it('deletes the key, rather than writing "", when the field is emptied', async () => {
    const published = version();
    let latest: PlaybookDraft | undefined;
    function Harness() {
      const [draft, setDraft] = React.useState<PlaybookDraft | undefined>(undefined);
      return (
        <TemplateEditor
          version={published}
          draft={draft}
          onDraftChange={(d) => { latest = d; setDraft(d); }}
          {...wiring}
        />
      );
    }
    const c = mount(<Harness />);

    type(fieldFor(c, /global risk tolerance/i)!, 'Risk-averse on liability.');
    await flush();
    type(fieldFor(c, /global risk tolerance/i)!, '');
    await flush();

    expect('riskTolerance' in latest!).toBe(false);
    // And the editor agrees there is nothing left to publish.
    expect(buttonNamed(c, /publish/i)?.disabled).toBe(true);
    expect(c.textContent).not.toMatch(/unpublished changes/i);
  });

  it('keeps a real value when the field is left non-empty', async () => {
    const published = version();
    let latest: PlaybookDraft | undefined;
    function Harness() {
      const [draft, setDraft] = React.useState<PlaybookDraft | undefined>(undefined);
      return (
        <TemplateEditor
          version={published}
          draft={draft}
          onDraftChange={(d) => { latest = d; setDraft(d); }}
          {...wiring}
        />
      );
    }
    const c = mount(<Harness />);

    type(fieldFor(c, /global risk tolerance/i)!, 'Risk-averse on liability.');
    await flush();

    expect(latest!.riskTolerance).toBe('Risk-averse on liability.');
  });
});

// m3. `Date.now().toString()` gave two clauses added inside one
// millisecond the SAME id — and `run.findings[key][clauseId]` and the
// health map are both keyed by it, so one finding would answer for two
// clauses. CLAUDE.md names this exact pattern as `uid()`'s cautionary tale.
describe('TemplateEditor — added clauses get distinct ids', () => {
  it('mints a distinct id for each added clause, even two added in the same millisecond', async () => {
    const published = version();
    const seen: PlaybookDraft[] = [];
    function Harness() {
      const [draft, setDraft] = React.useState<PlaybookDraft | undefined>(undefined);
      return (
        <TemplateEditor
          version={published}
          draft={draft}
          onDraftChange={(d) => { seen.push(d); setDraft(d); }}
          {...wiring}
        />
      );
    }
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_730_000_000_000);
    try {
      const c = mount(<Harness />);
      click(buttonNamed(c, /add clause/i));
      await flush();
      click(buttonNamed(c, /add clause/i));
      await flush();
      const ids = seen.at(-1)!.clauses.map(cl => cl.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// Task 9A / R-D16. Persistence is on EXPLICIT INTENT, never per keystroke:
// per-keystroke writes contradict the in-memory discard semantics Task 3's
// fix round established, which five App tests cover.
describe('TemplateEditor — saving a draft is an explicit act', () => {
  it('offers a Save draft control that asks the caller to persist the working copy', () => {
    const onPersistDraft = vi.fn();
    const published = version();
    const c = mount(
      <TemplateEditor
        version={published}
        draft={editedDraftOf(published)}
        onDraftChange={noop}
        {...wiring}
        onPersistDraft={onPersistDraft}
        unsavedChanges
      />,
    );
    const save = buttonNamed(c, /save draft/i)!;
    expect(save.disabled).toBe(false);
    click(save);
    expect(onPersistDraft).toHaveBeenCalledTimes(1);
  });

  it('does not write per keystroke: typing asks for a draft change, never a save', async () => {
    const onPersistDraft = vi.fn();
    const onDraftChange = vi.fn();
    const published = version();
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={onDraftChange}
        {...wiring}
        onPersistDraft={onPersistDraft}
      />,
    );
    type(nameInput(c), 'Renamed');
    await flush();
    expect(onDraftChange).toHaveBeenCalled();
    expect(onPersistDraft).not.toHaveBeenCalled();
  });

  // Nothing unsaved means nothing to save. A control that is always live
  // invites a write that stores what is already stored.
  it('disables Save draft when there is nothing unsaved', () => {
    const published = version();
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        unsavedChanges={false}
      />,
    );
    expect(buttonNamed(c, /save draft/i)?.disabled).toBe(true);
  });
});

describe('TemplateEditor — the mode toggle is gone (R-D1)', () => {
  it('offers no Standard/Risk mode toggle', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(buttons(c).some(b => /risk mode|standard mode/i.test(b.textContent || ''))).toBe(false);
  });

  // R-D1: the PRESENCE of these fields, not a flag, decides whether a review
  // assesses risk — so a hidden field would be a hidden decision.
  it('always shows the risk fields, and says that their content is what decides', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(fieldFor(c, /risk tolerance/i)).toBeTruthy();
    expect(fieldFor(c, /risk scorer/i)).toBeTruthy();
    expect(c.textContent).toMatch(/every clause/i);
    expect(c.textContent).toMatch(/no risk criteria are sent/i);
  });
});

describe('TemplateEditor — standard positions', () => {
  it('shows a standard-position field per clause', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect([...c.querySelectorAll('textarea')].filter(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? '')).length).toBe(2);
  });

  it('writes a typed position into the draft as an authored one', async () => {
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    const positionFields = [...c.querySelectorAll('textarea')].filter(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? ''));
    type(positionFields[0] as HTMLTextAreaElement, 'A 6-month break notice.');
    await flush();

    expect(onDraftChange.mock.calls.at(-1)![0].clauses[0].standardPosition).toEqual({
      text: 'A 6-month break notice.',
      origin: 'authored',
      reviewedByHuman: true,
    });
    expect(published.clauses[0]!.standardPosition).toBeUndefined();
  });

  // `structuredClone` — how IndexedDB writes every record — PRESERVES an
  // `undefined`-valued key, so clearing a position by setting it to
  // `undefined` would leave a clause that still answers yes to
  // `'standardPosition' in clause`.
  it('clearing a position deletes the key rather than setting it undefined', async () => {
    const onDraftChange = vi.fn();
    const clauses: PlaybookClause[] = [
      {
        id: 'c1',
        title: 'Term',
        extractPrompt: 'What is the term?',
        standardPosition: { text: 'A 6-month break notice.', origin: 'authored', reviewedByHuman: true },
      },
    ];
    const c = mount(
      <TemplateEditor version={version({ clauses })} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    const positionField = [...c.querySelectorAll('textarea')].find(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? ''))!;
    type(positionField, '');
    await flush();

    const saved = onDraftChange.mock.calls.at(-1)![0] as PlaybookDraft;
    expect('standardPosition' in saved.clauses[0]!).toBe(false);
  });

  // "we have no house rule here" and "we have one and it is untested" are
  // different facts; the health summary is what tells them apart.
  it('shows the health of a position when the caller supplies it', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        health={{ c1: { kind: 'held', supporting: 3, total: 4 } }}
      />,
    );
    expect(c.textContent).toContain('HELD 3 of 4');
  });

  // CLAUDE.md: a load failure renders an error state, never an empty map.
  // An empty map renders as no chips at all, which reads as "we asked and
  // there is nothing" — and a defaulted one would read as UNTESTED, which
  // is a claim about the firm's positions rather than about the app.
  //
  // The `health` prop is supplied DELIBERATELY, and is the whole test. The
  // rule being asserted is "instead of the chips, never alongside them",
  // and a caller that passed no map at all could not render a chip however
  // broken the guard was — which is why this test proved nothing until the
  // map went in. A partial scan that errored after building some entries is
  // also the realistic shape of the failure.
  it('says the review scan failed rather than quietly showing no health at all', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        health={{ c1: { kind: 'held', supporting: 3, total: 4 } }}
        healthError="Your reviews could not be read, so position health is unknown. Try again."
        onRetryHealth={noop}
      />,
    );
    expect(c.textContent).toMatch(/could not be read/i);
    expect(c.textContent).not.toMatch(/untested|held|conceded/i);
  });

  // Same defect as `VersionHistory`'s: `healthError && onRetryHealth` meant
  // a caller with a failure and no retry rendered the chips as though the
  // scan had succeeded and found nothing — the empty-versus-broken
  // confusion, produced by the guard written to prevent it.
  it('still says the scan failed when the caller offers no retry', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        health={{ c1: { kind: 'held', supporting: 3, total: 4 } }}
        healthError="Your reviews could not be read."
      />,
    );
    expect(c.textContent).toMatch(/could not be read/i);
    expect(c.textContent).not.toMatch(/untested|held|conceded/i);
  });

  it('offers a retry for the failed review scan', () => {
    const onRetryHealth = vi.fn();
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        healthError="Your reviews could not be read."
        onRetryHealth={onRetryHealth}
      />,
    );
    click(buttonNamed(c, /retry/i));
    expect(onRetryHealth).toHaveBeenCalled();
  });

  it('claims nothing about health the caller has not supplied', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(c.textContent).not.toMatch(/untested|held|conceded/i);
  });
});

// Integrity review (D/E), Major 1. The "byte-identical draft" case above is
// built by hand and so never travels through the store; the real editor's
// draft always has. `saveDraft` writes `changeSummary: ''` (that is all
// `draftFromVersion` ever produces — the publish summary is collected
// separately by `PublishDialog`), and a read that rewrote a blank summary
// made EVERY reopened draft differ from its version, whatever it said. That
// is how a real library ended up with a byte-identical v1/v2 pair.
describe('TemplateEditor — a draft that has been through the store (Major 1)', () => {
  it('offers no publish for a saved draft reopened byte-identical to its version', async () => {
    const db = await getDb();
    await db.clear(STORES.playbooks);
    await db.clear(STORES.playbookVersions);
    try {
      const identity = newPlaybook('Lease Review');
      const v1 = await publishVersion(identity.id, {
        name: 'Lease Review',
        contractType: 'Lease',
        systemPrompt: 'You are a reviewer.',
        formatPrompt: 'Quote verbatim.',
        clauses: structuredClone(twoClauses),
        changeSummary: '',
      }, 'u1');
      const saved = await savePlaybook({ ...identity, currentVersionId: v1.id });
      // Exactly what the editor's "Save draft" writes for an edit typed and
      // then undone: the working copy of the published version, unchanged.
      await saveDraft(saved, draftFromVersion(v1));

      // Reopened the way `loadPlaybookForEdit` does it — both sides read
      // back out of the store, not carried over in memory.
      const reopened = await getPlaybook(identity.id);
      const publishedVersion = await getPlaybookContent(identity.id);
      expect(reopened!.draft).toBeTruthy();

      const c = mount(
        <TemplateEditor
          version={publishedVersion!} draft={reopened!.draft} onDraftChange={noop} {...wiring}
        />,
      );
      expect(buttonNamed(c, /publish/i)?.disabled).toBe(true);
      expect(c.textContent).not.toMatch(/unpublished changes/i);
    } finally {
      await closeDb();
    }
  });
});
