import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkspaceSettings } from '@lexprompt/core';

// The module-mock idiom used by `generateDraft.test.ts` and
// `extractClause.test.ts`: `isAuthFailure` must stay real, since the whole
// point of propagating errors untouched is that it still recognises them.
import { ModelError } from '@lexprompt/core';
import { isAuthFailure } from '../../lib/model/authFailure';

vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('../../lib/model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;
const { suggestField } = await import('./suggestField');

beforeEach(() => vi.clearAllMocks());

const settings: WorkspaceSettings = { modelChoiceId: 'test/model', concurrency: 5 };
const clause = { title: 'Break', extractPrompt: 'Find it.' };

describe('suggestField', () => {
  it('asks for ONE field only', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'Must be unconditional.' });
    await suggestField('riskCriteria', clause, 'Lease', settings);
    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toMatch(/risk/i);
    // A call that regenerates the clause around the field would silently
    // discard the extraction prompt the user already wrote.
    expect(prompt).not.toMatch(/return the whole clause|all fields/i);
  });

  it('names the clause and contract type asked about, per field', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: 'x' });
    await suggestField('extractPrompt', clause, 'Commercial Lease', settings);
    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toMatch(/Commercial Lease/);
    expect(prompt).toMatch(/Break/);
  });

  it('returns the model text, trimmed', async () => {
    vi.mocked(chatJson).mockResolvedValue({ text: '  Six months, no conditions.  ' });
    const text = await suggestField('standardPosition', clause, 'Lease', settings);
    expect(text).toBe('Six months, no conditions.');
  });

  it('throws when the model returns a schema-valid but empty suggestion', async () => {
    // CLAUDE.md: a schema-valid but empty result recorded as success is
    // exactly the failure shape this app has shipped before.
    vi.mocked(chatJson).mockResolvedValue({ text: '   ' });
    await expect(suggestField('riskCriteria', clause, 'Lease', settings)).rejects.toThrow(/empty/i);
  });

  it('propagates an auth failure so isAuthFailure still recognises it', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('rejected', 'sign_in_required', 401));
    await expect(suggestField('riskCriteria', clause, 'Lease', settings)).rejects.toSatisfy(isAuthFailure);
  });

  it('a non-auth failure is NOT reported as an auth error', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));
    await expect(suggestField('riskCriteria', clause, 'Lease', settings)).rejects.not.toSatisfy(isAuthFailure);
  });
});
