import { useEffect, useRef, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { userManager } from './oidc';
import { closeSocket } from '../api/socket';

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
      let user: User | null;
      if (isRedirectCallback) {
        try {
          user = await userManager.signinRedirectCallback();
        } finally {
          // The authorization code is single-use, and `oidc-client-ts`
          // consumes and deletes the matching state entry as it reads it.
          // Nothing else cleaned the query: `useRoute` rewrites the URL only
          // on a `navigate()` call and never pushes on mount, so `?code=`
          // survived until the user's first in-app click. A signed-in user
          // who pressed F5 before clicking anything therefore ran this
          // callback again, against a state entry that was already gone,
          // and was shown "LexPrompt couldn't sign you in" — with a Retry
          // that re-read the same URL and failed identically. There was no
          // route out of it from inside the app.
          //
          // Cleared in a `finally`, on BOTH branches, and ungated by the
          // generation check below: the query is consumed the moment this
          // settles, whether it produced a user or a refusal, and leaving it
          // in place on the failing branch is the half that made the loop
          // inescapable. `pathname` only — `useRoute` parses the pathname,
          // and any hash is preserved rather than silently dropped.
          window.history.replaceState(null, '', window.location.pathname + window.location.hash);
        }
      } else {
        user = await userManager.getUser();
      }
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
    // Deferred, not forgotten, and named here for the reason `⌘K` and the
    // Report tab are named in CLAUDE.md rather than left silently missing:
    // nothing in the app calls this yet. Tokens live in `sessionStorage`, so
    // closing the tab already ends the session, and the shell has no
    // account menu to hang a sign-out on — R-G1 resolved every multi-user
    // affordance in the prototypes down to a single-user substrate and the
    // header avatar is not a menu. The redirect-based sign-out is written
    // and tested so that the day a control for it exists, the control is the
    // only new thing.
    //
    // STAGE 4: THE SOCKET GOES WITH IT. A tab that signs out and back in as
    // somebody else would otherwise inherit the previous person's
    // subscriptions — and, worse, the previous person's cached row versions,
    // which would silently suppress the first change the new reader was
    // shown. Here rather than in `App.tsx` because this is the one place
    // sign-out is expressed, and a second caller is how one of them comes to
    // be forgotten.
    signOut: () => {
      closeSocket();
      void userManager.signoutRedirect();
    },
    retry: load,
  };
}
