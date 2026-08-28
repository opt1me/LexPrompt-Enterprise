import React from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Settings } from '../../types';
import { saveSettings } from '../../lib/storage';
import { ModelPicker } from './ModelPicker';
import { INFERENCE_PRIVACY, STORAGE_PRIVACY } from '../../lib/privacyCopy';

export interface SettingsPanelProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

/**
 * Settings, with no API key on it.
 *
 * The key section, the "Get an API key" link and `API_KEY_PRIVACY` are gone
 * because the thing they described is gone: the browser holds no provider
 * credential, and a screen that asks for one over a service that ignores it
 * is a confidently-wrong UI sitting on top of a live secret. `loadSettings`
 * deletes any key an earlier version stored; App raises the one-time notice.
 *
 * The free-text model box went with it (S15). A user cannot name a model, so
 * the only control here is a choice off the operator's own allowlist.
 */
export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    onChange(next);
  };

  return (
    <div className="p-8 max-w-2xl mx-auto h-full overflow-y-auto bg-paper">
      <h2 className="font-prose text-screen-title text-ink-1 mb-2">Settings</h2>
      <p className="font-ui text-ui text-ink-3 mb-8">
        Choose the model your firm has configured for reviews.
      </p>

      <div className="space-y-6">
        <section className="bg-card p-6 rounded-panel border border-rule space-y-4">
          <h3 className="font-prose text-section text-ink-1">Model</h3>
          {/* The "Where your requests go" block lives inside ModelPicker,
              which is the only thing here holding the loaded allowlist entry.
              Lifting it out would mean a second copy of "which model is
              selected" for the two halves of one screen to disagree over. */}
          <ModelPicker settings={settings} onChange={update} />
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

        <section className="bg-card p-6 rounded-panel border border-rule space-y-3">
          <div className="flex items-center justify-between">
            <label className="font-prose text-section text-ink-1">Parallel requests</label>
            <span className="font-ui text-ui text-ink-3">{settings.concurrency}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={settings.concurrency}
            onChange={e => update({ concurrency: Number(e.target.value) })}
            className="w-full accent-accent"
          />
          <p className="font-ui text-ui-sm text-ink-4">
            How many clauses to extract at once during a review. Higher is faster but more likely
            to hit rate limits.
          </p>
        </section>
      </div>
    </div>
  );
}
