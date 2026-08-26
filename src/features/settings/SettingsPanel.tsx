import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Settings } from '../../types';
import { saveSettings } from '../../lib/storage';
import { listModels, type ModelInfo } from '../../lib/openrouter';
import { Button } from '../../components/Button';

export interface SettingsPanelProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

type ModelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: ModelInfo[] };

/** Sorts schema-capable models first; both groups keep their incoming (API) order otherwise. */
function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    if (a.supportsStructuredOutput === b.supportsStructuredOutput) return 0;
    return a.supportsStructuredOutput ? -1 : 1;
  });
}

function formatPricePerMillion(price: number | null): string {
  if (price === null) return 'variable';
  if (price === 0) return 'free';
  return `$${(price * 1_000_000).toFixed(2)}/M tokens`;
}

function formatContextLength(length: number): string {
  if (length >= 1000) return `${Math.round(length / 1000)}K ctx`;
  return `${length} ctx`;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'loading' });

  const loadModels = () => {
    setModelsState({ status: 'loading' });
    listModels()
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
    <div className="p-8 max-w-2xl mx-auto h-full overflow-y-auto">
      <h2 className="text-3xl font-bold text-white mb-2">Settings</h2>
      <p className="text-gray-400 mb-8">Connect an OpenRouter account to run reviews.</p>

      <div className="space-y-6">
        <section className="bg-[#1a1a1a] p-6 rounded-xl border border-white/10 space-y-4">
          <h3 className="font-bold text-white">OpenRouter API key</h3>

          <div>
            <label className="block text-xs text-gray-500 mb-1 uppercase font-bold">API key</label>
            <input
              type="password"
              value={settings.apiKey}
              onChange={e => update({ apiKey: e.target.value })}
              placeholder="sk-or-v1-..."
              className="w-full p-3 bg-black/50 border border-white/10 rounded text-white font-mono text-sm focus:border-violet-500 outline-none"
            />
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
            >
              Get an API key <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="flex items-start gap-2 p-3 bg-black/30 border border-white/5 rounded-lg">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <p className="text-xs text-gray-400 leading-relaxed">
              Your key is stored only in this browser's local storage and is sent only to OpenRouter
              when making a request. It is never sent anywhere else.
            </p>
          </div>
        </section>

        <section className="bg-[#1a1a1a] p-6 rounded-xl border border-white/10 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-white">Model</h3>
            {modelsState.status === 'ready' && (
              <button
                onClick={loadModels}
                className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
                title="Refresh model list"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            )}
          </div>

          {modelsState.status === 'loading' && (
            <div className="text-sm text-gray-400 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading models…
            </div>
          )}

          {modelsState.status === 'error' && (
            <div className="space-y-3">
              <p className="text-sm text-red-400">{modelsState.message}</p>
              <Button variant="ghost" onClick={loadModels}>Retry</Button>
            </div>
          )}

          {modelsState.status === 'ready' && (
            <select
              value={settings.modelId}
              onChange={e => update({ modelId: e.target.value })}
              className="w-full p-3 bg-black/50 border border-white/10 rounded text-white text-sm focus:border-violet-500 outline-none"
            >
              <option value="" disabled>Select a model…</option>
              {modelsState.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id} — {formatContextLength(m.contextLength)} — {formatPricePerMillion(m.promptPrice)} prompt
                  {!m.supportsStructuredOutput ? ' — may not honour output schemas' : ''}
                </option>
              ))}
            </select>
          )}
        </section>

        <section className="bg-[#1a1a1a] p-6 rounded-xl border border-white/10 space-y-3">
          <div className="flex items-center justify-between">
            <label className="font-bold text-white">Parallel requests</label>
            <span className="text-sm text-gray-400">{settings.concurrency}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={settings.concurrency}
            onChange={e => update({ concurrency: Number(e.target.value) })}
            className="w-full accent-violet-500"
          />
          <p className="text-xs text-gray-500">
            How many clauses to extract at once during a review. Higher is faster but more likely
            to hit rate limits.
          </p>
        </section>
      </div>
    </div>
  );
}
