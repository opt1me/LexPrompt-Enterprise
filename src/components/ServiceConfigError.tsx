import { SERVICE_CONFIG_HINT } from '@lexprompt/core';
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ModelError } from '@lexprompt/core';
import { Button } from './Button';

export interface ServiceConfigErrorProps {
  /** The `service_misconfigured` (or similarly firm-side) failure this
   *  panel reports. Only `message`/`callId` are read — the FIXED copy below
   *  is the sentence a lawyer sees, not `error.message` itself, which is
   *  written for an operator reading a log, not for the person at the
   *  keyboard. */
  error: ModelError;
  /** Retried in place — this failure genuinely can go away on its own (a
   *  provider outage clears, a credential gets rotated) and Retry is a real
   *  repair here, unlike Settings, which holds nothing that could fix it. */
  onRetry: () => void;
}

/**
 * §7's other audience: a firm-configuration fault only an administrator can
 * fix, never the person reading this screen. `openrouter.ts`'s old
 * contract collapsed this into "your key was rejected" and routed to
 * Settings; Settings now holds no credential at all, so that instruction
 * would send a reader to a screen with nothing on it that could help —
 * exactly the confidently-wrong answer this app exists not to give.
 *
 * Deliberately never renders a link or control to Settings (Task 23's own
 * negative test guards this). `text-risk-high` for the failure line, per
 * R-G19: failure text never uses `ink-4` or below.
 */
export function ServiceConfigError({ error, onRetry }: ServiceConfigErrorProps) {
  return (
    <div
      data-service-config-error
      className="p-6 max-w-md mx-auto text-center space-y-3 border border-dashed border-risk-high-edge rounded-card bg-risk-high-tint"
    >
      <p className="flex items-start gap-2 text-left font-ui text-ui text-risk-high">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          LexPrompt can&rsquo;t reach your firm&rsquo;s AI service. This is a configuration
          problem in the deployment, {SERVICE_CONFIG_HINT}. Tell your IT team
          {error.callId ? (
            <>
              , and quote reference <span className="font-mono">{error.callId}</span>
            </>
          ) : null}
          .
        </span>
      </p>
      <Button variant="ghost" onClick={onRetry}>Retry</Button>
    </div>
  );
}
