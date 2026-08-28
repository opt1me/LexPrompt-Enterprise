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
      const hasCode = new URLSearchParams(window.location.search).has('code');
      const user = hasCode
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
