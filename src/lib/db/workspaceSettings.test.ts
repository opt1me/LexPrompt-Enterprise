import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';

const apiGet = vi.fn();
const apiSend = vi.fn();

vi.mock('../api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiSend: (...args: unknown[]) => apiSend(...args),
}));

const { getWorkspaceSettings, saveWorkspaceSettings } = await import('./workspaceSettings');

const WS = { modelChoiceId: 'uk-gpt', concurrency: 5, version: 1, updatedAt: 1_700_000_000_000 };

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
});

describe('getWorkspaceSettings', () => {
  it('reads /v1/workspace/settings', async () => {
    apiGet.mockResolvedValue(WS);
    expect(await getWorkspaceSettings()).toEqual(WS);
    expect(apiGet).toHaveBeenCalledWith('/v1/workspace/settings');
  });

  it('propagates a failure rather than answering with a default-looking result', async () => {
    const boom = new ModelError('down', 'network', 0);
    apiGet.mockRejectedValue(boom);
    await expect(getWorkspaceSettings()).rejects.toBe(boom);
  });
});

describe('saveWorkspaceSettings', () => {
  it('PUTs the patch, including the version it read', async () => {
    apiSend.mockResolvedValue({ ...WS, version: 2 });
    await saveWorkspaceSettings({ modelChoiceId: 'us-claude', version: 1 });
    expect(apiSend).toHaveBeenCalledWith(
      'PUT', '/v1/workspace/settings', { modelChoiceId: 'us-claude', version: 1 },
    );
  });

  it('propagates a conflict rather than reporting it as saved', async () => {
    const stale = new ModelError('stale', 'conflict', 409);
    apiSend.mockRejectedValue(stale);
    await expect(saveWorkspaceSettings({ modelChoiceId: 'us-claude', version: 1 })).rejects.toBe(stale);
  });
});
