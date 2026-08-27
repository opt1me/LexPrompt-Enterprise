import React from 'react';
import { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, buttons, click, type } from '../../test/mount';
import { TemplateEditor } from './TemplateEditor';
import type { PlaybookClause, PlaybookDraft, PlaybookVersion } from '../../types';

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

const noop = () => {};
const wiring = {
  onPublish: noop,
  onExport: noop,
  onShowMegaPrompt: noop,
  onClose: noop,
};

describe('TemplateEditor — a published version is never edited in place', () => {
  it('edits into the draft, never into the published version', async () => {
    const onSaveDraft = vi.fn();
    const publishedV1 = version();
    // A COPY, so "the version was not mutated" is checked against a
    // known-good value rather than against the object the component holds.
    const published: PlaybookVersion = { ...publishedV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    type(nameInput(c), 'Renamed');
    await flush();

    expect(onSaveDraft).toHaveBeenCalled();
    expect(onSaveDraft.mock.calls.at(-1)![0].name).toBe('Renamed');
    // The published version object handed in is untouched — this is the
    // assertion the whole immutability rule rests on.
    expect(published.name).toBe(publishedV1.name);
  });

  it('reordering clauses writes into the draft, not the published version', async () => {
    const onSaveDraft = vi.fn();
    const twoClauseV1 = version({ clauses: structuredClone(twoClauses) });
    const published: PlaybookVersion = { ...twoClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    // The chevrons are icon-only; they are found by the accessible name a
    // screen reader would announce, which is the name they should have.
    click(buttonNamed(c, /move .*down|down/i));
    await flush();

    expect(onSaveDraft.mock.calls.at(-1)![0].clauses.map((cl: PlaybookClause) => cl.id))
      .toEqual(['c2', 'c1']);
    expect(published.clauses.map(cl => cl.id)).toEqual(['c1', 'c2']);
  });

  // Spec §8 asks for drag-based reordering. It is a SECOND affordance over
  // the same reorder path, never a replacement for the chevrons, which are
  // the only one a keyboard can reach.
  it('dragging a clause reorders through the same path, into the draft', async () => {
    const onSaveDraft = vi.fn();
    const threeClauseV1 = version({
      clauses: [
        ...structuredClone(twoClauses),
        { id: 'c3', title: 'Break', extractPrompt: 'Any break right?' },
      ],
    });
    const published: PlaybookVersion = { ...threeClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    const handles = [...c.querySelectorAll('[draggable="true"]')];
    const rows = [...c.querySelectorAll('[draggable="true"]')].map(h => h.closest('.group')!);
    expect(handles).toHaveLength(3);

    // Drag the first clause onto the third — a move no chevron press can
    // make in one step, so this cannot be the chevron path in disguise.
    act(() => { handles[0]!.dispatchEvent(new Event('dragstart', { bubbles: true })); });
    act(() => { rows[2]!.dispatchEvent(new Event('drop', { bubbles: true })); });
    await flush();

    expect(onSaveDraft.mock.calls.at(-1)![0].clauses.map((cl: PlaybookClause) => cl.id))
      .toEqual(['c2', 'c3', 'c1']);
    expect(published.clauses.map(cl => cl.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('editing a clause writes into the draft, not the published version', async () => {
    const onSaveDraft = vi.fn();
    const twoClauseV1 = version({ clauses: structuredClone(twoClauses) });
    const published: PlaybookVersion = { ...twoClauseV1 };
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    const titleInputs = [...c.querySelectorAll('input')] as HTMLInputElement[];
    type(titleInputs[1]!, 'Term (edited)');
    await flush();

    expect(onSaveDraft.mock.calls.at(-1)![0].clauses[0].title).toBe('Term (edited)');
    expect(published.clauses[0]!.title).toBe('Term');
  });

  it('edits an existing draft rather than starting a new one from the version', async () => {
    const onSaveDraft = vi.fn();
    const published = version({ name: 'Lease Review' });
    const draft = { ...draftOf(published), name: 'Half-typed name' };
    const c = mount(
      <TemplateEditor version={published} draft={draft} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    expect(nameInput(c).value).toBe('Half-typed name');
    type(fieldFor(c, /system persona/i)!, 'A different persona.');
    await flush();

    // The name the user had already typed survives the next edit.
    expect(onSaveDraft.mock.calls.at(-1)![0].name).toBe('Half-typed name');
    expect(onSaveDraft.mock.calls.at(-1)![0].systemPrompt).toBe('A different persona.');
  });
});

describe('TemplateEditor — publish state', () => {
  it('shows an unpublished-changes state when a draft exists', () => {
    const published = version();
    const c = mount(
      <TemplateEditor version={published} draft={draftOf(published)} onSaveDraft={noop} {...wiring} />,
    );
    expect(c.textContent).toMatch(/unpublished changes/i);
  });

  it('shows no unpublished-changes state when the version is what is on screen', () => {
    const c = mount(
      <TemplateEditor version={version()} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect(c.textContent).not.toMatch(/unpublished changes/i);
    expect(c.textContent).toContain('v1');
  });

  it('says a playbook with no published version has never been published', () => {
    const c = mount(
      <TemplateEditor version={undefined} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect(c.textContent).toMatch(/not published yet/i);
  });

  // Publishing an unchanged version would produce two byte-identical
  // versions minutes apart — the exact corruption already found in a real
  // library, which the version history then cannot explain.
  it('offers no publish when there is nothing unpublished to publish', () => {
    const c = mount(
      <TemplateEditor version={version()} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect(buttonNamed(c, /publish/i)?.disabled).toBe(true);
  });

  it('publishes through the caller when there are unpublished changes', () => {
    const onPublish = vi.fn();
    const published = version();
    const c = mount(
      <TemplateEditor
        version={published}
        draft={draftOf(published)}
        onSaveDraft={noop}
        {...wiring}
        onPublish={onPublish}
      />,
    );
    const publish = buttonNamed(c, /publish/i)!;
    expect(publish.disabled).toBe(false);
    click(publish);
    expect(onPublish).toHaveBeenCalled();
  });

  // Task 3 put a "What changed? (required after v1)" input in the header as
  // a stopgap, because Save published a version. PublishDialog owns that
  // field now, and two homes for one field is how they drift apart.
  it('no longer asks what changed in the header', () => {
    const published = version();
    const c = mount(
      <TemplateEditor version={published} draft={draftOf(published)} onSaveDraft={noop} {...wiring} />,
    );
    expect(c.querySelector('[aria-label="What changed?"]')).toBeNull();
    expect(c.textContent).not.toMatch(/required after v1/i);
  });
});

describe('TemplateEditor — the mode toggle is gone (R-D1)', () => {
  it('offers no Standard/Risk mode toggle', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect(buttons(c).some(b => /risk mode|standard mode/i.test(b.textContent || ''))).toBe(false);
  });

  // R-D1: the PRESENCE of these fields, not a flag, decides whether a review
  // assesses risk — so a hidden field would be a hidden decision.
  it('always shows the risk fields, and says that their content is what decides', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={noop} {...wiring} />,
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
      <TemplateEditor version={published} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect([...c.querySelectorAll('textarea')].filter(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? '')).length).toBe(2);
  });

  it('writes a typed position into the draft as an authored one', async () => {
    const onSaveDraft = vi.fn();
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    const positionFields = [...c.querySelectorAll('textarea')].filter(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? ''));
    type(positionFields[0] as HTMLTextAreaElement, 'A 6-month break notice.');
    await flush();

    expect(onSaveDraft.mock.calls.at(-1)![0].clauses[0].standardPosition).toEqual({
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
    const onSaveDraft = vi.fn();
    const clauses: PlaybookClause[] = [
      {
        id: 'c1',
        title: 'Term',
        extractPrompt: 'What is the term?',
        standardPosition: { text: 'A 6-month break notice.', origin: 'authored', reviewedByHuman: true },
      },
    ];
    const c = mount(
      <TemplateEditor version={version({ clauses })} draft={undefined} onSaveDraft={onSaveDraft} {...wiring} />,
    );

    const positionField = [...c.querySelectorAll('textarea')].find(t =>
      /standard position/i.test(t.closest('div')?.textContent ?? ''))!;
    type(positionField, '');
    await flush();

    const saved = onSaveDraft.mock.calls.at(-1)![0] as PlaybookDraft;
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
        onSaveDraft={noop}
        {...wiring}
        health={{ c1: { kind: 'held', supporting: 3, total: 4 } }}
      />,
    );
    expect(c.textContent).toContain('HELD 3 of 4');
  });

  it('claims nothing about health the caller has not supplied', () => {
    const published = version({ clauses: structuredClone(twoClauses) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onSaveDraft={noop} {...wiring} />,
    );
    expect(c.textContent).not.toMatch(/untested|held|conceded/i);
  });
});
