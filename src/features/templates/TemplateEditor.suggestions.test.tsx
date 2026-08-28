import React from 'react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import type { PlaybookClause, PlaybookDraft, PlaybookVersion, Settings } from '../../types';

// The module-mock idiom used by `suggestField.test.ts` / `generateDraft.test.ts`:
// `isAuthFailure` must stay real, since the whole point of propagating errors
// untouched is that it still recognises them.
import { ModelError } from '@lexprompt/core';

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

/** Every editable field carries the accessible name it is labelled with,
 *  so a test names the field rather than the markup shape around it. The
 *  relayout renamed the visible labels to the handoff's shorter ones
 *  ("Extract", "Risky when"), and the old helper matched on the OLD label
 *  text via `closest('div')`. `FIELD_LABEL` in `suggestField.ts` — which
 *  names the field in the prompt AND in each suggest button's accessible
 *  name — is deliberately unchanged, so the button queries below still read
 *  "extraction instruction". */
const labelled = (c: HTMLElement, name: string) =>
  c.querySelector(`[aria-label="${name}"]`) as HTMLTextAreaElement;

const testSettings: Settings = { modelChoiceId: 'test/model', concurrency: 5 };

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
const wiring = {
  onPersistDraft: noop,
  onShowVersionHistory: noop,
  onPublish: noop,
  onExport: noop,
  onShowMegaPrompt: noop,
  onClose: noop,
  settings: testSettings,
};

describe('TemplateEditor — per-field suggestions (Part A)', () => {
  it('shows a requested suggestion as unaccepted, and does not touch the field', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'What is the fixed term, in months?' });
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();

    expect(c.textContent).toMatch(/What is the fixed term, in months\?/);
    expect(c.textContent).toMatch(/not accepted/i);
    // The actual field is untouched — only the suggestion box shows the text.
    expect(labelled(c, 'Extract').value).toBe('What is the term?');
  });

  // This is the whole point of Part A (CLAUDE.md / FieldSuggestion's own doc
  // comment): accepting is the ONLY thing that ever writes a suggestion into
  // a field. A save must never adopt an unaccepted suggestion on its own
  // behalf.
  it('a suggestion displayed but not accepted leaves the field unchanged after a save', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'A completely different prompt.' });
    const onPersistDraft = vi.fn();
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={onDraftChange}
        {...wiring}
        onPersistDraft={onPersistDraft}
        unsavedChanges
      />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();
    expect(c.textContent).toMatch(/A completely different prompt\./);

    // Save, without ever clicking Accept.
    click(buttonNamed(c, /save draft/i)!);

    expect(onPersistDraft).toHaveBeenCalledTimes(1);
    // Nothing about the save adopted the suggestion into the working copy.
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(labelled(c, 'Extract').value).toBe('What is the term?');
  });

  it('accepting writes the suggestion into the field and clears the suggestion', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'A fresh extraction instruction.' });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();
    click(buttonNamed(c, /use this/i)!);

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0].clauses[0].extractPrompt).toBe('A fresh extraction instruction.');
    expect(c.textContent).not.toMatch(/not accepted/i);
  });

  it('accepting a standard-position suggestion records ai-drafted provenance, reviewed by the human who accepted it', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'A 6-month break notice, no conditions.' });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the standard position for term/i)!);
    await flush();
    click(buttonNamed(c, /use this/i)!);

    expect(onDraftChange.mock.calls[0]![0].clauses[0].standardPosition).toEqual({
      text: 'A 6-month break notice, no conditions.',
      origin: 'ai-drafted',
      reviewedByHuman: true,
    });
  });

  it('dismissing a suggestion discards it and never touches the field', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'Ignore me.' });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the risk criteria for term/i)!);
    await flush();
    click(buttonNamed(c, /i.ll write it/i)!);

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(c.textContent).not.toMatch(/Ignore me\./);
  });

  it('regenerating replaces the displayed suggestion without ever touching the field', async () => {
    vi.mocked(chatJson)
      .mockResolvedValueOnce({ text: 'First draft of the criteria.' })
      .mockResolvedValueOnce({ text: 'Second draft of the criteria.' });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the risk criteria for term/i)!);
    await flush();
    expect(c.textContent).toMatch(/First draft of the criteria\./);

    click(buttonNamed(c, /try again/i)!);
    await flush();

    expect(c.textContent).toMatch(/Second draft of the criteria\./);
    expect(c.textContent).not.toMatch(/First draft of the criteria\./);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it('a failed suggestion leaves the field exactly as typed and says so', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('The model returned an empty suggestion. Try again, or write it yourself.'));
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();

    expect(c.textContent).toMatch(/empty suggestion/i);
    expect(labelled(c, 'Extract').value).toBe('What is the term?');
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  // Major (Task 8 review): a rejected key is not a per-clause problem a
  // retry can fix — it must route to Settings via `onAuthError`, exactly as
  // `ChatPanel`/`DraftForm` do, never render as inline text beside the
  // field. Mutation-tested: removing the `isAuthFailure` check in
  // `requestFieldSuggestion`'s catch makes this fail because `onAuthError`
  // is never called and the rejection message appears inline instead.
  it('a rejected API key routes to Settings instead of rendering inline', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('Unauthorized', 'sign_in_required', 401));
    const onAuthError = vi.fn();
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={onDraftChange}
        {...wiring}
        onAuthError={onAuthError}
      />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(c.textContent).not.toMatch(/unauthorized/i);
    expect(labelled(c, 'Extract').value).toBe('What is the term?');
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("one field's suggestion does not disturb another's", async () => {
    vi.mocked(chatJson)
      .mockResolvedValueOnce({ text: 'Extract prompt suggestion.' })
      .mockResolvedValueOnce({ text: 'Risk criteria suggestion.' });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /draft the extraction instruction for term/i)!);
    await flush();
    click(buttonNamed(c, /draft the risk criteria for term/i)!);
    await flush();

    expect(c.textContent).toMatch(/Extract prompt suggestion\./);
    expect(c.textContent).toMatch(/Risk criteria suggestion\./);

    // Accepting the risk-criteria suggestion must not clear or adopt the
    // extract-prompt one sitting right beside it.
    click(buttonNamed(c, /use this/i)!); // there is exactly one "Use this" per suggestion box; the first DOM one belongs to extractPrompt
    expect(onDraftChange.mock.calls[0]![0].clauses[0].extractPrompt).toBe('Extract prompt suggestion.');
    expect(c.textContent).toMatch(/Risk criteria suggestion\./);
  });
});

describe('TemplateEditor — "Suggest what I\'m missing" (Part B, Task 8)', () => {
  // Was: "offers no 'add all' affordance — every clause entering a playbook
  // is a decision", asserting `buttonNamed(c, /add all/i)` is undefined
  // unconditionally. The owner asked for the opposite ("it becomes annoying
  // to have to verify each and every one, one by one"), and the rule that
  // test was protecting is not one-at-a-time — it is that nothing enters the
  // playbook except by an explicit act. "Add all" IS one. What survives is
  // that the control does not exist when there is nothing to batch; see
  // `TemplateEditor.bulk.test.tsx` for the rest.
  it('offers no "add all" affordance when nothing has been suggested', () => {
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );
    expect(buttonNamed(c, /add all/i)).toBeUndefined();
  });

  it('proposes titles for review, added or dismissed one at a time', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Rent Review', 'Assignment'] });
    const onDraftChange = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={onDraftChange} {...wiring} />,
    );

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    expect(c.textContent).toMatch(/Rent Review/);
    expect(c.textContent).toMatch(/Assignment/);

    // Dismissing one leaves the other.
    const dismissButtons = [...c.querySelectorAll('button')].filter(b => /dismiss/i.test(b.textContent || ''));
    click(dismissButtons[0]!);
    expect(onDraftChange).not.toHaveBeenCalled();

    // Adding the remaining one appends a real clause via the ordinary path.
    const addButtons = [...c.querySelectorAll('button')].filter(b => /add clause/i.test(b.textContent || ''));
    click(addButtons[addButtons.length - 1]!);
    const lastCall = onDraftChange.mock.calls.at(-1)![0] as PlaybookDraft;
    expect(lastCall.clauses.some(cl => cl.title === 'Assignment' || cl.title === 'Rent Review')).toBe(true);
  });

  it('reports a generation failure without throwing', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor version={published} draft={undefined} onDraftChange={noop} {...wiring} />,
    );

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    expect(c.textContent).toMatch(/could not check|rate limited/i);
  });

  // Major (Task 8 review): same auth-routing requirement as
  // `requestFieldSuggestion` above, for "Suggest what I'm missing". Entering
  // this editor is not gated by `ensureConfigured`, so this is the first AI
  // trigger a user with no configured key may ever hit. Mutation-tested:
  // removing the `isAuthFailure` check in `requestMissingClauses`'s catch
  // makes this fail because `onAuthError` is never called and the rejection
  // message appears inline instead.
  it('a rejected API key routes to Settings instead of rendering inline', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('Forbidden', 'not_permitted', 403));
    const onAuthError = vi.fn();
    const published = version({ clauses: structuredClone(oneClause) });
    const c = mount(
      <TemplateEditor
        version={published}
        draft={undefined}
        onDraftChange={noop}
        {...wiring}
        onAuthError={onAuthError}
      />,
    );

    click(buttonNamed(c, /suggest what i.m missing/i)!);
    await flush();

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(c.textContent).not.toMatch(/forbidden/i);
  });
});
