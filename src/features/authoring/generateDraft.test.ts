import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Settings } from '../../types';
import type { DraftFormValues } from './generateDraft';
import type { FewShotSource } from './fewShot';

// The real idiom, used by `src/features/review/extractClause.test.ts` and
// its siblings. Only the gateway client is stubbed; `isAuthFailure` lives in
// its own module and the auth tests below depend on its real behaviour, not
// a stub of it.
import { ModelError } from '@lexprompt/core';
import { isAuthFailure } from '../../lib/model/authFailure';

vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('../../lib/model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;
const { generateDraft } = await import('./generateDraft');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { modelChoiceId: 'test/model', concurrency: 5 };

const form: DraftFormValues = { contractType: 'Commercial Lease' };

function mockChatJson(value: unknown): void {
  vi.mocked(chatJson).mockResolvedValue(value);
}

function mockChatJsonRejection(error: unknown): void {
  vi.mocked(chatJson).mockRejectedValue(error);
}

function authRejection(status: 401 | 403) {
  return status === 401
    ? new ModelError('Your session has expired. Sign in again.', 'sign_in_required', 401)
    : new ModelError('Your account is not permitted to use LexPrompt.', 'not_permitted', 403);
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

  // Minor 3 (integrity review). This clause's fields eventually reach an
  // IMMUTABLE `PlaybookVersion` record, and `structuredClone` — how
  // IndexedDB writes every record — PRESERVES an `undefined`-valued key, so
  // an unconditional `riskCriteria: trimmedString(...)` here used to make a
  // published clause answer `'riskCriteria' in clause` with `true` while
  // holding `undefined`. `toEqual` cannot see this (it treats an absent key
  // and an `undefined`-valued one as equal) — `'in'` is the only check that
  // actually distinguishes them, per CLAUDE.md.
  it('leaves riskCriteria absent, not undefined, when the model gives none', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect('riskCriteria' in draft.clauses[0]).toBe(false);
  });

  it('keeps riskCriteria when the model gives one', async () => {
    mockChatJson({ clauses: [{ title: 'A', extract_prompt: 'a', risk_criteria: 'Flag uncapped liability.' }] });
    const draft = await generateDraft(form, '', [], settings);
    expect(draft.clauses[0].riskCriteria).toBe('Flag uncapped liability.');
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
    // `isAuthFailure` (`lib/model/authFailure.ts`) is the shared predicate; do not
    // re-derive "was this a 401" from a message string.
    mockChatJsonRejection(authRejection(401));
    await expect(generateDraft(form, '', [], settings)).rejects.toSatisfy(isAuthFailure);
  });

  it('a non-auth failure is NOT reported as an auth error', async () => {
    // Otherwise every 500 sends the user to Settings to fix a key that is
    // fine, which is the same class of wrong advice as telling them to
    // reload when reloading cannot help.
    mockChatJsonRejection(new Error('502 Bad Gateway'));
    await expect(generateDraft(form, '', [], settings)).rejects.not.toSatisfy(isAuthFailure);
  });
});
