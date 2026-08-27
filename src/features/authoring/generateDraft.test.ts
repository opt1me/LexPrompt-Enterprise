import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Settings } from '../../types';
import type { DraftFormValues } from './generateDraft';
import type { FewShotSource } from './fewShot';

// The real idiom, used by `src/features/review/extractClause.test.ts` and its
// siblings: a module mock with an `importActual` spread. `isAuthError` is a
// genuine export of `openrouter.ts` and the auth tests below depend on its
// real behaviour, not a stub of it.
vi.mock('../../lib/openrouter', async () => {
  const actual = await vi.importActual<typeof import('../../lib/openrouter')>('../../lib/openrouter');
  return { ...actual, chatJson: vi.fn() };
});
const { chatJson, isAuthError, OpenRouterError } = await import('../../lib/openrouter');
const { generateDraft } = await import('./generateDraft');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { apiKey: 'k', modelId: 'test/model', concurrency: 5 };

const form: DraftFormValues = { contractType: 'Commercial Lease' };

function mockChatJson(value: unknown): void {
  vi.mocked(chatJson).mockResolvedValue(value);
}

function mockChatJsonRejection(error: unknown): void {
  vi.mocked(chatJson).mockRejectedValue(error);
}

function authRejection(status: 401 | 403) {
  return new OpenRouterError('Your OpenRouter API key was rejected', status);
}

describe('generateDraft', () => {
  it('repairs a clause with a title and no extract prompt, rather than dropping it', async () => {
    mockChatJson({ clauses: [{ title: 'Break' }, { title: 'Rent', extract_prompt: 'Find the rent.' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect(draft.clauses.map((c) => c.title)).toEqual(['Break', 'Rent']);
    expect(draft.clauses[0].extractPrompt).toBe('');
    expect(draft.clauses[0].disposition).toBe('unreviewed');
  });

  it('drops a clause with no title at all — there is nothing to review', async () => {
    mockChatJson({ clauses: [{ extract_prompt: 'Find something.' }, { title: 'Rent', extract_prompt: 'x' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect(draft.clauses.map((c) => c.title)).toEqual(['Rent']);
  });

  it('does not pad to the requested clause count', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }, { title: 'B', extract_prompt: 'b' }] });
    const draft = await generateDraft({ ...form, targetClauseCount: 18 }, '', [], settings);
    expect(draft.clauses).toHaveLength(2);
  });

  it('marks every proposed standard position ai-drafted and unreviewed', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a', standard_position: 'We ask for six months.' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect(draft.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false,
    });
  });

  it('leaves standardPosition absent when the model gives none', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect('standardPosition' in draft.clauses[0]).toBe(false);
  });

  it('every clause arrives unreviewed and unedited', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect(draft.clauses[0].disposition).toBe('unreviewed');
    expect(draft.clauses[0].edited).toBe(false);
  });

  it('throws a specific error when the model returns no usable clauses', async () => {
    // Spec S7: this must NOT open an empty review screen that looks like a
    // draft of nothing.
    mockChatJson({ clauses: [] });
    await expect(generateDraft(form, '', [], settings)).rejects.toThrow(/no clauses/i);
  });

  it('throws the same specific error when every returned clause is dropped for having no title', async () => {
    mockChatJson({ clauses: [{ extract_prompt: 'x' }, { extract_prompt: 'y' }] });
    await expect(generateDraft(form, '', [], settings)).rejects.toThrow(/no clauses/i);
  });

  it('records the sources it learned from, for the provenance line', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
    const draft = await generateDraft(
      form, 'material', [{ kind: 'playbook', id: 'p', name: 'Lease v4' } as FewShotSource], settings,
    );
    expect(draft.learnedFrom).toEqual(['Lease v4']);
  });

  it('marks a rejected key as an auth error, so the caller can route to Settings', async () => {
    // Spec §7: "A 401/403 routes to Settings, as everywhere else in this app."
    // `generateDraft` does not navigate — it reports, and the route decides.
    // `isAuthError` from `openrouter.ts` is the shared predicate; do not
    // re-derive "was this a 401" from a message string.
    mockChatJsonRejection(authRejection(401));
    await expect(generateDraft(form, '', [], settings)).rejects.toSatisfy(isAuthError);
  });

  it('a non-auth failure is NOT reported as an auth error', async () => {
    // Otherwise every 500 sends the user to Settings to fix a key that is
    // fine, which is the same class of wrong advice as telling them to
    // reload when reloading cannot help.
    mockChatJsonRejection(new Error('502 Bad Gateway'));
    await expect(generateDraft(form, '', [], settings)).rejects.not.toSatisfy(isAuthError);
  });
});
