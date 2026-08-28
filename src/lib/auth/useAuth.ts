import { useEffect, useRef, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { userManager } from './oidc';

export interface AuthAccount {
  oid: string;
  name: string;
  initials: string;
  email: string;
}

export type AuthState =
  | { status: 'signing-in' }
  | { status: 'signed-out' }
  | { status: 'failed'; message: string }
  | { status: 'signed-in'; account: AuthAccount };

export interface UseAuthResult {
  state: AuthState;
  signIn(): void;
  signOut(): void;
  retry(): void;
}

/** First letters of the first and last words of a name — `'A. Gray'` →
 *  `'AG'`, `'Priya Okafor'` → `'PO'`, `'Cher'` → `'C'`. A name with no
 *  letters at all (blank) yields the empty string rather than throwing;
 *  the header avatar falls back to something visible on top of that. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0]?.[0] ?? '';
  if (words.length === 1) return first.toUpperCase();
  const last = words[words.length - 1]?.[0] ?? '';
  return (first + last).toUpperCase();
}

/**
 * The subject claim is read from `profile.sub` in every case — OIDC's one
 * guaranteed claim, present on every conformant issuer. Entra's `sub` here
 * is the pairwise subject; the tenant's directory `oid` (used for group and
 * role lookups) is a server-side concern (`subjectClaim`, Task 16) that the
 * browser never needs and must not be given a second identity source to
 * read.
 */
function accountFromUser(user: User): AuthAccount {
  const { profile } = user;
  const name = profile.name || profile.email || 'You';
  return {
    oid: profile.sub,
    name,
    initials: initialsOf(name),
    email: profile.email ?? '',
  };
}

/**
 * The front door's four honest states (task brief §"the three load states",
 * plus `signed-in` itself). `signing-in` while a redirect callback or the
 * stored-user check is in flight, `signed-out` when that check succeeds and
 * finds nobody (not an error), `failed` when the check itself could not be
 * completed (a network failure, a misconfigured issuer — genuinely
 * different from "you are not signed in" and must never collapse into it),
 * `signed-in` with the account the token names.
 */
export function useAuth(): UseAuthResult {
  const [state, setState] = useState<AuthState>({ status: 'signing-in' });
  // Guards a stale resolution from a superseded `load()` call (a fast
  // retry-after-retry) from overwriting a newer one's result — the same
  // "latest request wins" shape as App.tsx's own version-history/position-
  // health loaders.
  const generationRef = useRef(0);

  const load = () => {
    const generation = ++generationRef.current;
    setState({ status: 'signing-in' });
    (async () => {
      // An identity provider answers a redirect in TWO shapes, and both are
      // this callback: `?code=...` on success, and
      // `?error=...&error_description=...` on refusal (RFC 6749 §4.1.2.1).
      //
      // Only `code` used to count. An `error` response therefore fell
      // through to `getUser()`, found nobody, and rendered `signed-out` —
      // the ordinary "please sign in" screen, with no message. A real
      // misconfiguration (Keycloak returning `invalid_scope` because the
      // realm was missing its `profile` scope) looked exactly like a person
      // who had simply not signed in yet: press the button, come straight
      // back, no explanation, forever.
      //
      // That is the distinction the `failed` state below exists to make, and
      // the catch already reasons about it correctly — it just never saw
      // this case. `signinRedirectCallback` rejects on an error response, so
      // routing `error` here puts it in the hands of that reasoning, with
      // the provider's own `error_description` as the message.
      //
      // Found in a browser against a live Keycloak; no unit test reached it,
      // because nothing under test ever returned an error-shaped redirect.
      const params = new URLSearchParams(window.location.search);
      const isRedirectCallback = params.has('code') || params.has('error');
      const user = isRedirectCallback
        ? await userManager.signinRedirectCallback()
        : await userManager.getUser();
      if (generationRef.current !== generation) return; // superseded — discard
      if (!user) {
        setState({ status: 'signed-out' });
        return;
      }
      setState({ status: 'signed-in', account: accountFromUser(user) });
    })().catch((err) => {
      if (generationRef.current !== generation) return; // superseded — discard
      // Deliberately NOT `signed-out`: a rejection means the check could not
      // be completed at all, which is a different fact from "it completed
      // and found nobody". Collapsing the two would tell a person their
      // session was simply absent when the truth is the app could not tell.
      setState({ status: 'failed', message: err instanceof Error ? err.message : String(err) });
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    signIn: () => { void userManager.signinRedirect(); },
    signOut: () => { void userManager.signoutRedirect(); },
    retry: load,
  };
}
