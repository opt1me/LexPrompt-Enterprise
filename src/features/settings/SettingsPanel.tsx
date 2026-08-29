import React from 'react';
import { ShieldCheck } from 'lucide-react';
import type { WorkspaceSettings } from '@lexprompt/core';
import type { RoleState } from '../../lib/role';
import { WorkspaceModelPanel } from './WorkspaceModelPanel';
import { INFERENCE_PRIVACY, STORAGE_PRIVACY } from '../../lib/privacyCopy';

export interface SettingsPanelProps {
  /** §7's role gate for the model picker — see `WorkspaceModelPanel`. */
  role: RoleState;
  /** Fires when the workspace's model choice (or concurrency) actually
   *  changes, so `App.tsx` can fold the new choice into its own
   *  `WorkspaceSettings` state without a second fetch — the same reason
   *  `onChange` existed here before Task 18. */
  onWorkspaceSettingsSaved?: (settings: WorkspaceSettings) => void;
}

/**
 * Settings, with no API key on it and — since Task 18 — no per-user model
 * or concurrency preference either.
 *
 * The key section, the "Get an API key" link and `API_KEY_PRIVACY` are gone
 * because the thing they described is gone: the browser holds no provider
 * credential, and a screen that asks for one over a service that ignores it
 * is a confidently-wrong UI sitting on top of a live secret. `loadSettings`
 * deletes any key an earlier version stored; App raises the one-time notice.
 *
 * The model choice and the concurrency limit both moved to
 * `WorkspaceModelPanel` (§6.6): they are workspace configuration an admin
 * sets now, not something this screen reads or writes for the signed-in
 * user. `Settings` (`src/types.ts`) is empty as a result — there is no
 * per-user preference left for this screen to hold state for.
 */
export function SettingsPanel({ role, onWorkspaceSettingsSaved }: SettingsPanelProps) {
  return (
    <div className="p-8 max-w-2xl mx-auto h-full overflow-y-auto bg-paper">
      <h2 className="font-prose text-screen-title text-ink-1 mb-2">Settings</h2>
      <p className="font-ui text-ui text-ink-3 mb-8">
        Choose the model your firm has configured for reviews.
      </p>

      <div className="space-y-6">
        <section className="bg-card p-6 rounded-panel border border-rule space-y-4">
          <h3 className="font-prose text-section text-ink-1">Model</h3>
          <WorkspaceModelPanel role={role} onSaved={onWorkspaceSettingsSaved} />
        </section>

        <section className="bg-card p-6 rounded-panel border border-rule space-y-3">
          <h3 className="font-prose text-section text-ink-1">Where your documents go</h3>
          <div className="flex items-start gap-2 p-3 bg-accent-tint border border-accent-edge rounded-control">
            <ShieldCheck className="w-4 h-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
            <div className="font-ui text-ui-sm text-ink-2 leading-relaxed space-y-2">
              <p>{INFERENCE_PRIVACY}</p>
              {STORAGE_PRIVACY.map(p => <p key={p}>{p}</p>)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
