import React from 'react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, buttonNamed, buttons, click } from '../../test/mount';
import type { PlaybookClause, PlaybookDraft, PlaybookVersion } from '../../types';
import type { WorkspaceSettings } from '@lexprompt/core';

// The module-mock idiom used by `TemplateEditor.suggestions.test.tsx`:
// `isAuthFailure` must stay real, since the whole point of propagating errors
// untouched is that it still recognises them.
vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('../../lib/model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;
const { TemplateEditor } = await import('./TemplateEditor');

beforeEach(() => vi.clearAllMocks());

const flush = () => act(async () => { await Promise.resolve(); });
const labelled = (c: HTMLElement, name: string) =>
  c.querySelector(`[aria-label="${name}"]`) as HTMLTextAreaElement;

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

const oneClause: PlaybookClause[] = [
  { id: 'c1', title: 'Term', extractPrompt: 'What is the term?' },
];

const noop = () => {};
const testSettings: WorkspaceSettings = { modelChoiceId: 'test/model', concurrency: 5 };
const wiring = {
  onPersistDraft: noop,
  onShowVersionHistory: noop,
  onPublish: noop,
  onExport: noop,
  onShowMegaPrompt: noop,
  onClose: noop,
  settings: testSettings,
};

const editor = (onDraftChange: (d: PlaybookDraft) => void = noop) => mount(
  <TemplateEditor
    version={version({ clauses: structuredClone(oneClause) })}
    draft={undefined}
    onDraftChange={onDraftChange}
    {...wiring}
  />,
);

/** Asks for a suggestion on each named field of the one clause, in turn. */
async function suggestFields(c: HTMLElement, fields: [RegExp, string][]) {
  for (const [button, text] of fields) {
    vi.mocked(chatJson).mockResolvedValueOnce({ text });
    click(buttonNamed(c, button)!);
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

const EXTRACT = /draft the extraction instruction for term/i;
const RISK = /draft the risk criteria for term/i;
const POSITION = /draft the standard position for term/i;

// ── Part B1: "Add all" over suggested clauses.
//
// The owner: "it becomes annoying to have to verify each and every one, one
// by one." A bulk control is an EXPLICIT act, which is the only thing the
// one-at-a-time rule was ever protecting — see the changed test in
// `TemplateEditor.suggestions.test.tsx`.
describe('TemplateEditor — adding every suggested clause at once', () => {
  it('adds every suggestion in one write, and clears the list', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Rent Review', 'Assignment', 'Alienation'] });
    const onDraftChange = vi.fn();
    const c = editor(onDraftChange);

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    const addAll = buttonNamed(c, /add all/i)!;
    expect(addAll.textContent).toMatch(/add all 3/i);
    click(addAll);

    // ONE draft change carrying ALL of them. Three separate appends would
    // each be computed from the same working copy, and only the last would
    // survive — "Add all 3" would add one clause and say it added three.
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]![0] as PlaybookDraft;
    expect(next.clauses.map(cl => cl.title))
      .toEqual(['Term', 'Rent Review', 'Assignment', 'Alienation']);
    // Distinct ids, the same rule a hand-added clause obeys.
    expect(new Set(next.clauses.map(cl => cl.id)).size).toBe(4);
    // And nothing is left proposed.
    expect(buttonNamed(c, /add all/i)).toBeUndefined();
    expect(c.textContent).not.toMatch(/Alienation/);
  });

  it('offers no bulk control over a single suggestion', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Rent Review'] });
    const c = editor();

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    expect(c.textContent).toMatch(/Rent Review/);
    // The proposal's own "Add clause" is the whole of it — a "use all" over
    // one item is noise.
    expect(buttonNamed(c, /add all/i)).toBeUndefined();
  });

  it('adds nothing until the bulk control is pressed', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Rent Review', 'Assignment'] });
    const onDraftChange = vi.fn();
    const c = editor(onDraftChange);

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    expect(buttonNamed(c, /add all/i)).toBeTruthy();
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});

// ── Part B2: accepting every showing suggestion on one clause.
describe('TemplateEditor — accepting every suggestion on a clause at once', () => {
  it('writes every showing suggestion into its own field, in one write', async () => {
    const onDraftChange = vi.fn();
    const c = editor(onDraftChange);

    await suggestFields(c, [
      [EXTRACT, 'A sharper extraction instruction.'],
      [RISK, 'Risky when the term exceeds five years.'],
      [POSITION, 'A 6-month break notice, no conditions.'],
    ]);

    const useAll = buttonNamed(c, /use all/i)!;
    expect(useAll.textContent).toMatch(/use all 3/i);
    click(useAll);

    // One write, not three: three sequential accepts would each be computed
    // from the same stale working copy and the last would win, so a control
    // saying "Use all 3" would silently take one.
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const clause = (onDraftChange.mock.calls[0]![0] as PlaybookDraft).clauses[0]!;
    expect(clause.extractPrompt).toBe('A sharper extraction instruction.');
    expect(clause.riskCriteria).toBe('Risky when the term exceeds five years.');
    // Provenance survives the bulk route exactly as it does the single one:
    // the words came from the model, and only `reviewedByHuman` records that
    // a person then took them.
    expect(clause.standardPosition).toEqual({
      text: 'A 6-month break notice, no conditions.',
      origin: 'ai-drafted',
      reviewedByHuman: true,
    });
    // Every accepted box is gone, and no unaccepted one is left behind.
    expect(c.textContent).not.toMatch(/not accepted/i);
  });

  it('takes only the suggestions actually showing, leaving the untouched fields alone', async () => {
    const onDraftChange = vi.fn();
    const c = editor(onDraftChange);

    await suggestFields(c, [
      [EXTRACT, 'A sharper extraction instruction.'],
      [POSITION, 'A 6-month break notice, no conditions.'],
    ]);

    click(buttonNamed(c, /use all/i)!);

    const clause = (onDraftChange.mock.calls[0]![0] as PlaybookDraft).clauses[0]!;
    expect(clause.extractPrompt).toBe('A sharper extraction instruction.');
    expect(clause.standardPosition!.text).toBe('A 6-month break notice, no conditions.');
    // No suggestion was ever asked for here, so nothing may be written to it.
    expect('riskCriteria' in clause).toBe(false);
  });

  it('offers no bulk control over a single showing suggestion', async () => {
    const c = editor();
    await suggestFields(c, [[EXTRACT, 'A sharper extraction instruction.']]);
    expect(c.textContent).toMatch(/not accepted/i);
    expect(buttonNamed(c, /use all/i)).toBeUndefined();
    // The box's own control is still there.
    expect(buttonNamed(c, /use this/i)).toBeTruthy();
  });

  it('drops back to no bulk control once all but one suggestion is dismissed', async () => {
    const c = editor();
    await suggestFields(c, [
      [EXTRACT, 'A sharper extraction instruction.'],
      [RISK, 'Risky when the term exceeds five years.'],
    ]);
    expect(buttonNamed(c, /use all/i)).toBeTruthy();

    // The first "I'll write it myself" belongs to the extract box.
    click(buttons(c).find(b => /i.ll write it/i.test(b.textContent || ''))!);
    expect(buttonNamed(c, /use all/i)).toBeUndefined();
  });
});

// ── The rule the bulk controls must not weaken.
//
// Accepting is the ONLY thing that writes a suggestion into a field. A bulk
// accept is a wider accept, not a looser one — saving must still adopt
// nothing.
//
// Mutation-tested: make `acceptFieldSuggestions` run on mount, or make the
// save path read `fieldSuggestions`, and this fails on `onDraftChange`.
describe('TemplateEditor — a save still adopts nothing that was not accepted', () => {
  it('leaves all three fields untouched when a save happens with three suggestions on screen', async () => {
    const onPersistDraft = vi.fn();
    const onDraftChange = vi.fn();
    const c = mount(
      <TemplateEditor
        version={version({ clauses: structuredClone(oneClause) })}
        draft={undefined}
        onDraftChange={onDraftChange}
        {...wiring}
        onPersistDraft={onPersistDraft}
        unsavedChanges
      />,
    );

    await suggestFields(c, [
      [EXTRACT, 'A sharper extraction instruction.'],
      [RISK, 'Risky when the term exceeds five years.'],
      [POSITION, 'A 6-month break notice, no conditions.'],
    ]);
    // The bulk control is on screen and has NOT been pressed.
    expect(buttonNamed(c, /use all 3/i)).toBeTruthy();

    click(buttonNamed(c, /save draft/i)!);

    expect(onPersistDraft).toHaveBeenCalledTimes(1);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(labelled(c, 'Extract').value).toBe('What is the term?');
    expect(labelled(c, 'Risky when').value).toBe('');
    expect(labelled(c, 'Our standard position').value).toBe('');
    // And the suggestions are still sitting there, still marked unaccepted.
    expect(c.textContent).toMatch(/not accepted/i);
  });

  it('adopts no proposed clause when a save happens with an "Add all" on screen', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Rent Review', 'Assignment'] });
    const onPersistDraft = vi.fn();
    const onDraftChange = vi.fn();
    const c = mount(
      <TemplateEditor
        version={version({ clauses: structuredClone(oneClause) })}
        draft={undefined}
        onDraftChange={onDraftChange}
        {...wiring}
        onPersistDraft={onPersistDraft}
        unsavedChanges
      />,
    );

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();
    expect(buttonNamed(c, /add all 2/i)).toBeTruthy();

    click(buttonNamed(c, /save draft/i)!);

    expect(onPersistDraft).toHaveBeenCalledTimes(1);
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});
