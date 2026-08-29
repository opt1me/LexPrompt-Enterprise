import React from 'react';
import type { ModelError } from '@lexprompt/core';
import { Button } from '../../components/Button';

export interface AccessRefusedPanelProps {
  /** The `no_role`, `account_disabled` or `group_overage` failure `GET
   *  /v1/me` answered with (Task 17, §7). Rendered INSTEAD OF the app, never
   *  behind it — a partial shell full of empty lists behind this banner
   *  would still read as "no matters yet", which is the "empty is not
   *  broken" failure at the front door, one layer inside the sign-in gate
   *  this sits beside. */
  error: ModelError;
  /**
   * The only real repair available from this screen. Retry is deliberately
   * NOT offered: nothing about signing in again changes a group mapping, an
   * administrator's disable flag, or a directory's group count, and
   * offering it would manufacture a retry loop that looks like progress and
   * is not. Signing out — so a colleague with real access can sign in on
   * this machine, or so the person here can come back once IT has fixed
   * their mapping — is the one thing the person at the keyboard can do.
   */
  onSignOut: () => void;
}

/**
 * One component, three messages, chosen by `error.code` — never by matching
 * wording (S1's lesson: a reworded sentence must not silently stop being
 * recognised). The body text is the API's OWN message, verbatim, for the
 * same reason `describeLoadError` passes a `DbBlockedError`'s message
 * through rather than paraphrasing it: the server knows which groups the
 * token carried, or that an administrator disabled the account, or that the
 * directory could not be read — the browser knows none of that on its own,
 * and a local paraphrase would either drop detail or drift from what the
 * server actually said.
 *
 * A disabled account, "no mapped group", and a group-overage account are
 * three different facts (§7) and read as three different headlines here —
 * collapsing any two would tell a partner in forty groups they have no
 * access, or tell a disabled user that a mapping needs adding, which is a
 * confidently wrong instruction to a person unable to act on it.
 */
export function AccessRefusedPanel({ error, onSignOut }: AccessRefusedPanelProps) {
  const headline = error.code === 'account_disabled'
    ? 'Your LexPrompt account has been disabled.'
    : error.code === 'group_overage'
      ? "LexPrompt could not read your account's groups."
      : 'You do not have access to LexPrompt yet.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-8">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="font-prose text-screen-title text-ink-1">{headline}</h1>
        <p className="font-ui text-ui text-ink-2 text-left leading-relaxed">{error.message}</p>
        <Button onClick={onSignOut} className="mx-auto">Sign out</Button>
      </div>
    </div>
  );
}
