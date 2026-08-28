import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Settings } from '../../types';

// The module-mock idiom used by `suggestField.test.ts` / `generateDraft.test.ts`:
// `isAuthFailure` must stay real, since the whole point of propagating errors
// untouched is that it still recognises them.
import { ModelError } from '@lexprompt/core';
import { isAuthFailure } from '../../lib/model/authFailure';

vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('../../lib/model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;
const { suggestMissingClauses } = await import('./suggestMissingClauses');

beforeEach(() => vi.clearAllMocks());

const settings: Settings = { modelChoiceId: 'test/model', concurrency: 5 };

describe('suggestMissingClauses', () => {
  it('does not propose a clause the playbook already has', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Break', 'Rent Review', 'Assignment'] });
    const out = await suggestMissingClauses(['Break', 'break '], 'Lease', settings);
    // Case- and whitespace-insensitive: a model proposing "break" against an
    // existing "Break" is proposing nothing.
    expect(out).toEqual(['Rent Review', 'Assignment']);
  });

  it('returns an empty list rather than throwing when nothing is missing', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Break'] });
    expect(await suggestMissingClauses(['Break'], 'Lease', settings)).toEqual([]);
  });

  it('dedupes the model repeating the same gap twice in one response', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: ['Assignment', ' assignment ', 'Assignment'] });
    expect(await suggestMissingClauses([], 'Lease', settings)).toEqual(['Assignment']);
  });

  it('proposes titles only, asking the model not to draft the rest of a clause', async () => {
    vi.mocked(chatJson).mockResolvedValue({ titles: [] });
    await suggestMissingClauses(['Break'], 'Lease', settings);
    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toMatch(/titles only/i);
    expect(prompt).not.toMatch(/extract_prompt|risk_criteria|standard_position/i);
  });

  it('treats a malformed response as no proposals rather than throwing', async () => {
    vi.mocked(chatJson).mockResolvedValue({});
    expect(await suggestMissingClauses(['Break'], 'Lease', settings)).toEqual([]);
  });

  it('propagates an auth failure so isAuthFailure still recognises it', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('rejected', 'sign_in_required', 401));
    await expect(suggestMissingClauses(['Break'], 'Lease', settings)).rejects.toSatisfy(isAuthFailure);
  });

  it('a non-auth failure is NOT reported as an auth error', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));
    await expect(suggestMissingClauses(['Break'], 'Lease', settings)).rejects.not.toSatisfy(isAuthFailure);
  });
});
