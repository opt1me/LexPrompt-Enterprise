import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { jurisdictionLabel, type AllowedModel } from '@lexprompt/core';
import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { isStaleModelChoice, MODEL_CHOICE_STALE } from '../../lib/model/modelChoice';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import type { Settings } from '../../types';

/**
 * The banner shown when the selected allowlist entry is the offline
 * `recorded` provider (§5.1).
 *
 * Exported as data rather than inlined so Task 26's sweep can assert the
 * exact words. Non-dismissible on purpose: `recorded` is the one adapter in
 * the stack that can produce a fluent, plausible answer that no model ever
 * generated, which is precisely the failure mode this app's founding rule is
 * about. A banner a reader can hide is a banner that is not there for the
 * one screenshot that ends up in advice.
 */
export const RECORDED_PROVIDER_NOTICE = {
  heading: 'These answers are recorded fixtures, not a model.',
  body:
    'LexPrompt is configured with the offline recorded provider. Nothing here has been read '
    + 'by an AI, and nothing here is about your documents.',
} as const;

export const NO_MODELS_CONFIGURED =
  'No model has been configured for this workspace yet. An administrator sets these up; '
  + 'LexPrompt cannot run a review until one exists.';

export interface ModelChoicePatch {
  modelChoiceId: string;
  /** Recorded alongside the id so nothing persisted has to name the alias —
   *  see `modelProvenanceName`. The id says which allowlist entry was
   *  chosen; these say what it was, on the day it was chosen. */
  modelChoiceLabel: string;
  modelChoiceModel: string;
  modelSupportsImages: boolean;
  modelSupportsStructuredOutput: boolean;
  modelContextLength: number;
}

export interface ModelPickerProps {
  settings: Settings;
  onChange: (patch: ModelChoicePatch) => void;
}

type ModelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; models: AllowedModel[] };

/**
 * Every option, in the same form, with none unlabelled.
 *
 * Two facts, deliberately both: `jurisdictionLabel`'s bloc-and-region form
 * (`UK · UK South`), which is what the audit record and the operator's own
 * configuration speak in, and the same thing said in words, which a two-
 * letter code is not. Labelling only the entries a reader might find
 * surprising would make the ABSENCE of a label mean something — the blank-
 * CSV-cell defect, one screen earlier.
 *
 * Factual, never evaluative. Whether a jurisdiction is acceptable was
 * settled by the operator's contracts and their
 * `GATEWAY_ALLOWED_JURISDICTIONS`; every entry on this list has already
 * passed that gate, so this screen states where processing happens and
 * passes no judgement on it — no warning icon, no risk colour, no "outside
 * the UK/EU".
 */
export function optionLabel(m: AllowedModel): string {
  return `${m.label} — ${jurisdictionLabel(m.jurisdiction)} — Processed in ${m.jurisdiction.label}`;
}

function whereRequestsGo(m: AllowedModel): string {
  return `Reviews run on ${m.label}, served by ${m.provider}. `
    + `Requests are processed in ${m.jurisdiction.label} (${jurisdictionLabel(m.jurisdiction)}).`;
}

function patchFor(m: AllowedModel): ModelChoicePatch {
  return {
    modelChoiceId: m.id,
    modelChoiceLabel: m.label,
    modelChoiceModel: m.model,
    modelSupportsImages: m.supportsImages,
    modelSupportsStructuredOutput: m.supportsStructuredOutput,
    modelContextLength: m.contextLength,
  };
}

/**
 * The model choice, over the operator's allowlist — three load states, told
 * apart.
 *
 * `loading` is a busy row, `error` is a `LoadErrorPanel` with a Retry, and a
 * successful but EMPTY list is its own third state: neither an error panel
 * nor an empty select, because "your administrator has not configured a
 * model" and "we could not ask" are different facts and only one of them is
 * something an administrator needs to hear about.
 *
 * There is no free-text model box and no "or enter a model id manually"
 * fallback (S15). A user who could name a model could name an unreviewed
 * egress destination, so a failed list means no choice can be made — not
 * that the choice falls back to typing one.
 */
export function ModelPicker({ settings, onChange }: ModelPickerProps) {
  const [state, setState] = useState<ModelsState>({ status: 'loading' });
  // At most one automatic commit per mount, so a parent that ignores
  // `onChange` cannot be driven in a loop by its own re-renders.
  const committedDefault = useRef(false);

  const load = () => {
    setState({ status: 'loading' });
    gatewayModelClient.listModels()
      .then(models => setState({ status: 'ready', models }))
      .catch((err: unknown) => {
        // The `ModelError` the gateway client raises already carries wording
        // a reader can act on ("could not reach its server", "sign in
        // again"). `describeLoadError` is not used here: it classifies
        // IndexedDB failures, and replacing this with its generic fallback
        // would throw away the one sentence that says what went wrong.
        const detail = err instanceof Error && err.message ? err.message : '';
        setState({
          status: 'error',
          message: detail
            ? `The list of models could not be loaded: ${detail}`
            : 'The list of models could not be loaded. Try again.',
        });
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = state.status === 'ready' ? state.models : [];
  const chosen = models.find(m => m.id === settings.modelChoiceId);
  // Only when NOTHING is chosen. A stored choice that is no longer on the
  // list must not quietly resolve to a different model: the reviewer would
  // be told a model they never picked ran their review.
  const preselect = settings.modelChoiceId ? undefined : models.find(m => m.isDefault);
  const selected = chosen ?? preselect;
  // Shared with App's own `isConfigured`, through one predicate: the screen
  // saying "nothing is selected" while the shell still waves the user into a
  // review is exactly what two copies of this would produce.
  const staleChoice = state.status === 'ready'
    && isStaleModelChoice(settings.modelChoiceId, models);

  useEffect(() => {
    if (!preselect || committedDefault.current) return;
    // The displayed selection has to be a real one. Showing a model as
    // chosen while `modelChoiceId` stays empty is a screen claiming a
    // configured state the store does not have — and `isConfigured` reads
    // the store.
    committedDefault.current = true;
    onChange(patchFor(preselect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect?.id]);

  return (
    <div className="space-y-4">
      {selected?.provider === 'recorded' && (
        <div
          data-recorded-notice
          className="flex items-start gap-2 p-3 bg-risk-med-tint border border-risk-med-edge rounded-control"
        >
          <AlertTriangle className="w-4 h-4 text-risk-med shrink-0 mt-0.5" aria-hidden="true" />
          <div className="font-ui text-ui-sm text-ink-2 leading-relaxed space-y-1">
            <p className="font-semibold text-ink-1">{RECORDED_PROVIDER_NOTICE.heading}</p>
            <p>{RECORDED_PROVIDER_NOTICE.body}</p>
          </div>
        </div>
      )}

      {state.status === 'loading' && (
        <div
          className="font-ui text-ui text-ink-3 flex items-center gap-2"
          data-busy="true"
          aria-live="polite"
        >
          <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading models…
        </div>
      )}

      {state.status === 'error' && (
        <LoadErrorPanel message={state.message} onRetry={load} compact />
      )}

      {state.status === 'ready' && models.length === 0 && (
        <p className="font-ui text-ui text-ink-2 leading-relaxed">{NO_MODELS_CONFIGURED}</p>
      )}

      {state.status === 'ready' && models.length > 0 && (
        <>
          {staleChoice && (
            <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
              {MODEL_CHOICE_STALE}, so nothing is selected. Pick one below before running a
              review.
            </p>
          )}
          <select
            aria-label="Model"
            value={selected?.id ?? ''}
            onChange={(e) => {
              const match = models.find(m => m.id === e.target.value);
              if (!match) return;
              onChange(patchFor(match));
            }}
            className="w-full p-3 bg-card border border-rule-strong rounded-control font-ui text-ui text-ink-1 focus:ring-1 focus:ring-accent outline-none"
          >
            <option value="" disabled>Choose a model…</option>
            {models.map(m => (
              <option key={m.id} value={m.id}>{optionLabel(m)}</option>
            ))}
          </select>

          <div className="space-y-1">
            <h4 className="font-mono text-label uppercase text-ink-4">Where your requests go</h4>
            <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
              {selected
                ? whereRequestsGo(selected)
                : 'Once you choose a model, this says which provider serves it and where its '
                  + 'requests are processed.'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
