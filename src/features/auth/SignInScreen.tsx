import React from 'react';
import { Button } from '../../components/Button';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { config } from '../../lib/config';
import type { AuthState } from '../../lib/auth/useAuth';

export interface SignInScreenProps {
  /** Every `AuthState` except `signed-in` — `App.tsx` renders this screen
   *  for exactly those three statuses and `AppShell` for the fourth, so a
   *  `signed-in` state reaching this component would be a caller bug, not
   *  something this screen has a rendering for. */
  state: Exclude<AuthState, { status: 'signed-in' }>;
  onSignIn: () => void;
  onRetry: () => void;
}

/**
 * The front door (task brief: "the three load states"). Rendered INSTEAD OF
 * the app for every status but `signed-in` — never behind a modal, never
 * alongside a shell full of empty lists, which is the "empty is not
 * broken" failure at the one screen a user meets first.
 */
export function SignInScreen({ state, onSignIn, onRetry }: SignInScreenProps) {
  if (state.status === 'failed') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper p-8">
        <div className="max-w-md w-full text-center space-y-4">
          <h1 className="font-prose text-screen-title text-ink-1">LexPrompt couldn't sign you in</h1>
          {/* CLAUDE.md: reuse LoadErrorPanel rather than hand-rolling a new
             failure block. The tenant is named alongside the message so a
             misconfigured issuer is visibly identifiable, not just "it
             failed". */}
          <LoadErrorPanel
            message={`${state.message} (tenant: ${config.oidcIssuer})`}
            onRetry={onRetry}
          />
        </div>
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper p-8">
        <div className="max-w-md w-full text-center space-y-6">
          <h1 className="font-prose text-screen-title text-ink-1">Sign in to LexPrompt</h1>
          <p className="font-ui text-ui text-ink-2">
            Your firm's identity provider handles sign-in — LexPrompt never sees your password.
          </p>
          <Button onClick={onSignIn} className="mx-auto">Sign in</Button>
        </div>
      </div>
    );
  }

  // state.status === 'signing-in'
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-8">
      <p className="font-ui text-ui text-ink-3">Signing in…</p>
    </div>
  );
}
