import React, { useEffect, useState } from 'react';
import { jurisdictionLabel, type AllowedModel, type ProviderStatus } from '@lexprompt/core';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { getAdminProviders, type AdminProviders } from '../../lib/api/admin';

/**
 * WHICH PROVIDERS THIS DEPLOYMENT USES, and which of S2's two guarantees it
 * actually has.
 *
 * ## Read-only BY CONSTRUCTION, not by disabling anything
 *
 * There is no write route to call (S14: the allowlist's one home is the
 * gateway), so this screen offers no input, no select and no submit — and
 * says in words that a provider is changed in the deployment's own
 * configuration. A greyed-out form would imply a control that exists
 * somewhere; there is none.
 *
 * ## It never grades a provider
 *
 * `DataHandling` is the OPERATOR'S RECORD of terms they agreed, *"never
 * graded, scored, or read by any code path that decides anything"*. This
 * renders the note and its date, and marks a note older than a year as
 * needing re-reading — which is a fact about the NOTE, not a judgement about
 * the provider. No word anywhere in this component says good, poor, safe,
 * risky, compliant or recommended, and its test sweeps for each of them.
 *
 * ## The one sentence this screen must never grow
 *
 * §18 item 8: no sentence anywhere in the app, README, admin screens or spec
 * may state the merged, unconditional no-keys claim as live — the one
 * `stage1DoD.test.ts` scans this tree for, and which is deliberately not
 * quoted here so that scan needs no exemption. It is false for
 * every deployment using OpenAI, Anthropic or OpenRouter directly. This is
 * the screen most likely to grow one, because one sentence is shorter and
 * sounds better than two — so it states the CONDITIONAL one, per provider,
 * from `ProviderStatus.auth`, and its test asserts the unconditional form
 * never appears.
 */

export interface ProvidersPanelProps {
  /** Injected so a test can drive every state without mocking a module. */
  load?: typeof getAdminProviders;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: AdminProviders };

/**
 * WHICH OF S2'S TWO SENTENCES THIS PROVIDER'S CONFIGURATION SUPPORTS.
 *
 * Never both, and never the unconditional one. Managed identity is the only
 * posture for which the no-key half is true; every other posture gets the
 * custody half, which is a weaker claim and still worth making.
 */
export function guaranteeFor(auth: ProviderStatus['auth']): string {
  if (auth === 'managed-identity') {
    return 'This deployment authenticates to this provider by managed identity, so no provider '
      + 'key exists in this deployment at all — there is nothing to steal and nothing to '
      + 'rotate.';
  }
  if (auth === 'key') {
    return 'This deployment holds a key for this provider, and the key is held only by the '
      + 'gateway: it never reaches this browser, the API or the database.';
  }
  return 'This deployment declares no credential source for this provider, so LexPrompt cannot '
    + 'say how it would authenticate to it.';
}

/** A note the operator has not re-read for over a year. A fact about the
 *  NOTE, and deliberately not a judgement about the provider. */
export function isStale(lastCheckedAt: string, now: number): boolean {
  const when = Date.parse(lastCheckedAt);
  if (Number.isNaN(when)) return false;
  return now - when > 365 * 24 * 60 * 60 * 1000;
}

/** Complete literal class names per state — never built by interpolation,
 *  which Tailwind's scanner cannot see and which renders with no colour at
 *  all, silently. */
const CONFIGURED_INK: Record<'yes' | 'no', string> = {
  yes: 'text-ink-2',
  no: 'text-risk-high',
};

export function ProvidersPanel({ load = getAdminProviders }: ProvidersPanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const run = (): void => {
    setState({ status: 'loading' });
    load()
      .then(page => setState({ status: 'ready', page }))
      .catch((err: unknown) => setState({
        status: 'error',
        message: err instanceof Error && err.message
          ? `The provider configuration could not be read: ${err.message}`
          : 'The provider configuration could not be read. Try again.',
      }));
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="font-ui text-ui text-ink-3" data-busy="true" aria-live="polite">
        Reading this deployment&rsquo;s provider configuration…
      </div>
    );
  }

  if (state.status === 'error') {
    // NEVER an empty list. "This firm has no providers configured" is a
    // statement about the firm's own deployment that a failed read is in no
    // position to make.
    return <LoadErrorPanel message={state.message} onRetry={run} />;
  }

  const { models, providers, declaredJurisdictions } = state.page;
  const now = Date.now();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="font-prose text-section text-ink-1">Providers</h2>
        <p className="font-ui text-ui-sm text-ink-3">
          Which model providers this deployment is configured to reach, and how it authenticates
          to each. This is read-only: providers and models are changed in this deployment&rsquo;s
          configuration, not from a screen.
        </p>
        <p className="font-ui text-ui-sm text-ink-4">
          The gateway will route only to{' '}
          {declaredJurisdictions.length > 0 ? declaredJurisdictions.join(', ') : 'nothing — '}
          {declaredJurisdictions.length > 0
            ? ' and refuses anything outside that set.'
            : 'no jurisdiction is declared, and the gateway refuses to start without one.'}
        </p>
      </header>

      <ul className="space-y-4">
        {providers.map(p => {
          const forProvider = models.filter(m => m.provider === p.provider);
          return (
            <li key={p.provider} className="border border-rule rounded-card p-4 space-y-3"
              data-provider={p.provider}>
              <div className="space-y-1">
                <p className="font-ui text-ui text-ink-1 font-semibold">{p.provider}</p>
                <p className={`font-ui text-ui-sm ${CONFIGURED_INK[p.configured ? 'yes' : 'no']}`}>
                  {p.configured
                    ? 'A credential source is configured for this provider.'
                    : 'No credential source is configured for this provider, so calls to it '
                      + 'would be refused.'}
                </p>
                {/* One of S2's two sentences, per provider, from the server's
                    own `auth` value. Never both, and never the
                    unconditional claim. */}
                <p className="font-ui text-ui-sm text-ink-2">{guaranteeFor(p.auth)}</p>
                <p className="font-ui text-ui-sm text-ink-4">
                  {p.rotatedAt
                    ? `Last rotated ${new Date(p.rotatedAt).toLocaleDateString()}.`
                    : 'When it was last rotated is not recorded — which is not the same as '
                      + 'never.'}
                </p>
              </div>

              {forProvider.length === 0 ? (
                <p className="font-ui text-ui-sm text-ink-3">
                  No model on the allowlist routes to this provider.
                </p>
              ) : (
                <ul className="divide-y divide-rule border-t border-rule">
                  {forProvider.map(m => <ModelLine key={m.id} model={m} now={now} />)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <p className="font-ui text-ui-sm text-ink-3">
        Providers and models are changed in this deployment&rsquo;s configuration and nowhere
        else — there is no route from this screen to a change, deliberately.
      </p>
    </div>
  );
}

function ModelLine({ model, now }: { model: AllowedModel; now: number }) {
  return (
    <li className="py-2 space-y-0.5" data-model={model.id}>
      {/* EVERY entry labelled the SAME WAY, in-bloc or not (S27): the absence
          of a label must not be what carries the meaning. */}
      <p className="font-ui text-ui-sm text-ink-1">
        {model.label} — {model.provider} — {jurisdictionLabel(model.jurisdiction)}
      </p>
      {model.dataHandling ? (
        <>
          <p className="font-ui text-ui-sm text-ink-3">{model.dataHandling.summary}</p>
          <p className="font-ui text-ui-sm text-ink-4">
            Reviewed {model.dataHandling.lastCheckedAt}
            {isStale(model.dataHandling.lastCheckedAt, now)
              ? ' — last reviewed over a year ago, so it is worth re-reading the agreement.'
              : '.'}
          </p>
        </>
      ) : (
        <p className="font-ui text-ui-sm text-ink-4">
          No note of this provider&rsquo;s terms has been recorded for this entry.
        </p>
      )}
    </li>
  );
}
