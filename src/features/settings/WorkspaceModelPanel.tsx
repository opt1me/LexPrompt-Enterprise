import React, { useEffect, useRef, useState } from 'react';
import { jurisdictionLabel, type AllowedModel, type WorkspaceSettings } from '@lexprompt/core';
import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { getWorkspaceSettings, saveWorkspaceSettings } from '../../lib/db/workspaceSettings';
import type { RoleState } from '../../lib/role';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Button } from '../../components/Button';
import { ModelPicker, NO_MODELS_CONFIGURED, type ModelChoicePatch } from './ModelPicker';

export interface WorkspaceModelPanelProps {
  /** Gates the picker vs. the read-only line — the courtesy half only. The
   *  API already refuses a non-admin `PUT` (`ROUTE_POLICY`); this is a dead
   *  control, not the control. */
  role: RoleState;
  /** Fires once a write actually lands, so a caller threading the workspace
   *  choice into a live review (`App.tsx`) can pick up the new
   *  `modelChoiceId` without a second fetch. */
  onSaved?: (settings: WorkspaceSettings) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; settings: WorkspaceSettings };

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;

/**
 * §6.6: the workspace's model choice, and its concurrency, both admin
 * configuration now rather than a per-browser preference.
 *
 * Every signed-in role reads `GET /v1/workspace/settings` (any caller may
 * see what runs their reviews); only an admin gets the picker. §6.6's
 * capability fields (`modelSupportsImages` etc.) never appear here — they
 * are resolved by `App.tsx`'s own cross-reference against the allowlist for
 * the review engine's use, not something this settings screen needs to show.
 */
export function WorkspaceModelPanel({ role, onSaved }: WorkspaceModelPanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = () => {
    setState({ status: 'loading' });
    getWorkspaceSettings()
      .then(settings => setState({ status: 'ready', settings }))
      .catch((err: unknown) => setState({
        status: 'error',
        message: err instanceof Error && err.message
          ? `Workspace settings could not be loaded: ${err.message}`
          : 'Workspace settings could not be loaded. Try again.',
      }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="font-ui text-ui text-ink-3 flex items-center gap-2" data-busy="true" aria-live="polite">
        Loading workspace settings…
      </div>
    );
  }

  if (state.status === 'error') {
    return <LoadErrorPanel message={state.message} onRetry={load} compact />;
  }

  const isAdmin = role.status === 'known' && role.role === 'admin';

  if (!isAdmin) {
    return <ReadOnlyModel modelChoiceId={state.settings.modelChoiceId} />;
  }

  return (
    <AdminModelForm
      settings={state.settings}
      onSaved={(saved) => { setState({ status: 'ready', settings: saved }); onSaved?.(saved); }}
    />
  );
}

/**
 * The reviewer/partner view: what runs their reviews, and that it is not
 * theirs to change — never a dropdown that looks live but silently refuses
 * on click, which is the "dead button, undisclosed" shape CLAUDE.md warns
 * against. Loads the allowlist itself (three states, same as `ModelPicker`)
 * because it needs the chosen entry's provider and jurisdiction, which
 * `WorkspaceSettings` alone does not carry.
 */
function ReadOnlyModel({ modelChoiceId }: { modelChoiceId: string }) {
  type ModelsState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; models: AllowedModel[] };
  const [state, setState] = useState<ModelsState>({ status: 'loading' });

  const load = () => {
    setState({ status: 'loading' });
    gatewayModelClient.listModels()
      .then(models => setState({ status: 'ready', models }))
      .catch((err: unknown) => setState({
        status: 'error',
        message: err instanceof Error && err.message
          ? `The list of models could not be loaded: ${err.message}`
          : 'The list of models could not be loaded. Try again.',
      }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="font-ui text-ui text-ink-3 flex items-center gap-2" data-busy="true" aria-live="polite">
        Loading…
      </div>
    );
  }
  if (state.status === 'error') {
    return <LoadErrorPanel message={state.message} onRetry={load} compact />;
  }
  // A real configuration ("your administrator has configured no models"),
  // never folded into the failure above — the blank-CSV-cell defect one
  // screen earlier, applied here.
  if (state.models.length === 0) {
    return <p className="font-ui text-ui text-ink-2 leading-relaxed">{NO_MODELS_CONFIGURED}</p>;
  }
  const chosen = state.models.find(m => m.id === modelChoiceId);
  if (!chosen) {
    return (
      <p className="font-ui text-ui text-ink-2 leading-relaxed">
        No model has been chosen for this workspace yet. This is set by an administrator.
      </p>
    );
  }
  return (
    <p className="font-ui text-ui text-ink-2 leading-relaxed">
      Reviews run on <span className="font-semibold text-ink-1">{chosen.label}</span>,
      served by {chosen.provider} — {jurisdictionLabel(chosen.jurisdiction)}
      {' '}(processed in {chosen.jurisdiction.label}). This is set by an administrator.
    </p>
  );
}

/** The admin view: the same `ModelPicker` every account used to see,
 *  writing through to `PUT /v1/workspace/settings` instead of
 *  `localStorage`, plus the concurrency limit that moved into the same row.
 *  Each write states the `version` it read (P9); a stale one is refused and
 *  reported rather than silently reapplied over someone else's change. */
function AdminModelForm({
  settings, onSaved,
}: { settings: WorkspaceSettings; onSaved: (s: WorkspaceSettings) => void }) {
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [savingModel, setSavingModel] = useState(false);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The version this form actually READ — re-synced whenever a fresh
  // `settings` prop lands (a successful save, or a reload), so a second
  // write in the same session states the version the FIRST write produced,
  // not the one this form opened with.
  const versionRef = useRef(settings.version);
  useEffect(() => {
    versionRef.current = settings.version;
    setConcurrency(settings.concurrency);
  }, [settings.version, settings.concurrency]);

  const commit = async (
    patch: Partial<Pick<WorkspaceSettings, 'modelChoiceId' | 'modelChoiceLabel' | 'modelChoiceModel' | 'concurrency'>>,
    setBusy: (b: boolean) => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveWorkspaceSettings({
        // The model fields travel ONLY when the model is what changed
        // (Part 2A m7). Re-sending the stored choice on a concurrency-only
        // save made the "Parallel requests" Save on a fresh workspace — where
        // the stored choice is `''` — answer *"A model choice is required."*,
        // a 400 naming a field the admin never touched. Omitting them says
        // what is true: this write is not about the model.
        ...(patch.modelChoiceId === undefined ? {} : {
          modelChoiceId: patch.modelChoiceId,
          modelChoiceLabel: patch.modelChoiceLabel,
          modelChoiceModel: patch.modelChoiceModel,
        }),
        concurrency: patch.concurrency,
        // A real fetch always sets `version` — this form only ever renders
        // over a `state.status === 'ready'` load — but the TYPE keeps it
        // optional (see `WorkspaceSettings`'s own note), so `?? 0` here is a
        // type-level fallback, never a value this code path actually needs:
        // an admin who could reach this form always read a real version
        // first.
        version: versionRef.current ?? 0,
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace settings could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const onModelChange = (patch: ModelChoicePatch) => {
    void commit(
      { modelChoiceId: patch.modelChoiceId, modelChoiceLabel: patch.modelChoiceLabel, modelChoiceModel: patch.modelChoiceModel },
      setSavingModel,
    );
  };

  return (
    <div className="space-y-4">
      <ModelPicker modelChoiceId={settings.modelChoiceId} onChange={onModelChange} />
      {savingModel && <p className="font-ui text-ui-sm text-ink-3">Saving…</p>}
      {error && <p role="alert" className="font-ui text-ui text-risk-high">{error}</p>}

      <div className="space-y-1 pt-2 border-t border-rule">
        <div className="flex items-center justify-between">
          <label htmlFor="workspace-concurrency" className="font-prose text-section text-ink-1">
            Parallel requests
          </label>
          <span className="font-ui text-ui text-ink-3">{concurrency}</span>
        </div>
        <input
          id="workspace-concurrency"
          type="range"
          min={MIN_CONCURRENCY}
          max={MAX_CONCURRENCY}
          step={1}
          value={concurrency}
          onChange={e => setConcurrency(Number(e.target.value))}
          aria-label="Parallel requests"
          className="w-full accent-accent"
        />
        <p className="font-ui text-ui-sm text-ink-4">
          How many clauses to extract at once during a review, for every reviewer in this
          workspace. Higher is faster but more likely to hit rate limits.
        </p>
        <Button
          variant="ghost"
          onClick={() => commit({ concurrency }, setSavingConcurrency)}
          disabled={concurrency === settings.concurrency || savingConcurrency}
          loading={savingConcurrency}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
