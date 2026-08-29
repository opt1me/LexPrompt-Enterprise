import type { WorkspaceSettings } from '@lexprompt/core';
import { apiGet, apiSend } from '../api/client';

/**
 * The workspace's model choice, server side (§6.6, Task 18) — an HTTP
 * client over `apps/api`'s `/v1/workspace/settings`, following the same
 * shape every other repository in `src/lib/db/` follows since Stage 2
 * (`matters.ts`'s own docstring is the template): a failure is a failure,
 * never an empty or default-looking result.
 *
 * There is no local fallback and no minted default here, for the same
 * reason `profile.ts` stopped minting a person: `WorkspaceSettings` is an
 * administrator's decision, not something this module may invent when the
 * network is down. `getWorkspaceSettings` rejects on any failure; a caller
 * that cannot read it must say so, not proceed as if nothing were chosen.
 */
export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  return apiGet<WorkspaceSettings>('/v1/workspace/settings');
}

/**
 * `version` is required — the caller must state which version it read, the
 * same optimistic-concurrency shape `saveMatter` follows, so a stale write
 * (another admin, or another tab) is refused (P9) rather than silently
 * overwriting a decision this caller never saw.
 *
 * `concurrency` is optional: omitting it PRESERVES whatever value is
 * already stored (`workspaceSettings.ts` on the server reads the current
 * row before it decides, precisely so that changing only the model does not
 * also reset a concurrency limit a previous admin set).
 */
export async function saveWorkspaceSettings(patch: {
  modelChoiceId: string;
  modelChoiceLabel?: string;
  modelChoiceModel?: string;
  concurrency?: number;
  version: number;
}): Promise<WorkspaceSettings> {
  return apiSend<WorkspaceSettings>('PUT', '/v1/workspace/settings', patch);
}
