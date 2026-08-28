import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Settings } from '../../types';
import { saveSettings } from '../../lib/storage';
import type { AllowedModel } from '@lexprompt/core';
import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { Button } from '../../components/Button';
import { API_KEY_PRIVACY, STORAGE_PRIVACY } from '../../lib/privacyCopy';

export interface SettingsPanelProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

type ModelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: AllowedModel[] };

/** Sorts schema-capable models first; both groups keep their incoming
 *  (allowlist) order otherwise. */
function sortModels(models: AllowedModel[]): AllowedModel[] {
  return [...models].sort((a, b) => {
    if (a.supportsStructuredOutput === b.supportsStructuredOutput) return 0;
    return a.supportsStructuredOutput ? -1 : 1;
  });
}

function formatContextLength(length: number): string {
  if (length >= 1000) return `${Math.round(length / 1000)}K ctx`;
  return `${length} ctx`;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'loading' });

  const loadModels = () => {
    setModelsState({ status: 'loading' });
    gatewayModelClient.listModels()
      .then(models => setModelsState({ status: 'ready', models: sortModels(models) }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load models.';
        setModelsState({ status: 'error', message });
      });
  };

  // Fetched once on mount and cached in component state.
  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    onChange(next);
  };

  return (
    <div className="p-8 max-w-2xl mx-auto h-full overflow-y-auto bg-paper">
      <h2 className="font-prose text-screen-title text-ink-1 mb-2">Settings</h2>
      <p className="font-ui text-ui text-ink-3 mb-8">Connect an OpenRouter account to run reviews.</p>

      <div className="space-y-6">
        <section className="bg-card p-6 rounded-panel border border-rule space-y-4">
          <h3 className="font-prose text-section text-ink-1">OpenRouter API key</h3>

          <div>
            <label className="block font-mono text-label uppercase text-ink-4 mb-1">API key</label>
            <input
              type="password"
              value={settings.apiKey}
              onChange={e => update({ apiKey: e.target.value })}
              placeholder="sk-or-v1-..."
              className="w-full p-3 bg-card border border-rule-strong rounded-control font-mono text-ui text-ink-1 focus:ring-1 focus:ring-accent outline-none"
            />
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-ui text-ui-sm text-accent hover:text-accent-strong"
            >
              Get an API key <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          </div>

          <div className="flex items-start gap-2 p-3 bg-accent-tint border border-accent-edge rounded-control">
            <ShieldCheck className="w-4 h-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
            <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
              {API_KEY_PRIVACY}
            </p>
          </div>
        </section>

        <section className="bg-card p-6 rounded-panel border border-rule space-y-3">
          <h3 className="font-prose text-section text-ink-1">Where your documents go</h3>
          <div className="flex items-start gap-2 p-3 bg-accent-tint border border-accent-edge rounded-control">
            <ShieldCheck className="w-4 h-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
            <div className="font-ui text-ui-sm text-ink-2 leading-relaxed space-y-2">
              {STORAGE_PRIVACY.map(p => <p key={p}>{p}</p>)}
            </div>
          </div>
        </section>

        <section className="bg-card p-6 rounded-panel border border-rule space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-prose text-section text-ink-1">Model</h3>
            {modelsState.status === 'ready' && (
              <button
                onClick={loadModels}
                className="font-ui text-ui-sm text-ink-3 hover:text-ink-1 flex items-center gap-1"
                title="Refresh model list"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Refresh
              </button>
            )}
          </div>

          {modelsState.status === 'loading' && (
            <div className="font-ui text-ui text-ink-3 flex items-center gap-2" data-busy="true" aria-live="polite">
              <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading models…
            </div>
          )}

          {modelsState.status === 'error' && (
            <div className="space-y-3">
              <p className="font-ui text-ui text-risk-high">{modelsState.message}</p>
              <Button variant="ghost" onClick={loadModels}>Retry</Button>
              {/* Important 8: a failed model list must not brick the app —
                  `isConfigured` (App.tsx) only requires a non-empty modelId,
                  so a manually entered one still works. Its capabilities are
                  unknown until the list loads again, and are treated
                  conservatively everywhere they gate behaviour
                  (extractClause, ChatPanel). */}
              <div className="pt-2 border-t border-rule">
                <label className="block font-mono text-label uppercase text-ink-4 mb-1">
                  Or enter a model id manually
                </label>
                <input
                  type="text"
                  defaultValue={settings.modelId}
                  onBlur={e => {
                    const modelId = e.target.value.trim();
                    if (modelId === settings.modelId) return;
                    update({
                      modelId,
                      modelSupportsImages: undefined,
                      modelSupportsStructuredOutput: undefined,
                      modelContextLength: undefined,
                    });
                  }}
                  placeholder="e.g. openai/gpt-4o"
                  className="w-full p-3 bg-card border border-rule-strong rounded-control font-mono text-ui text-ink-1 focus:ring-1 focus:ring-accent outline-none"
                />
                <p className="font-ui text-ui-sm text-risk-med mt-1">
                  The model list couldn't be loaded, so this can't be validated against it. Use the
                  exact OpenRouter model id (see{' '}
                  <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong">
                    openrouter.ai/models
                  </a>
                  ).
                </p>
              </div>
            </div>
          )}

          {modelsState.status === 'ready' && (
            <select
              value={settings.modelId}
              onChange={e => {
                const modelId = e.target.value;
                const match = modelsState.models.find(m => m.id === modelId);
                update({
                  modelId,
                  modelSupportsImages: match?.supportsImages,
                  modelSupportsStructuredOutput: match?.supportsStructuredOutput,
                  modelContextLength: match?.contextLength,
                });
              }}
              className="w-full p-3 bg-card border border-rule-strong rounded-control font-ui text-ui text-ink-1 focus:ring-1 focus:ring-accent outline-none"
            >
              <option value="" disabled>Select a model…</option>
              {modelsState.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id} — {formatContextLength(m.contextLength)}
                  {!m.supportsStructuredOutput ? ' — may not honour output schemas' : ''}
                </option>
              ))}
            </select>
          )}
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
