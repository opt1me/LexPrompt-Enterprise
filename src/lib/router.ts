/**
 * Hand-rolled History-API router for matters, reviews, playbooks and settings.
 *
 * Deliberately narrow: this is not a general-purpose router, it encodes
 * exactly the seven routes the app needs. See
 * docs/superpowers/specs/2026-08-26-redesign-a-persistence-and-matters.md
 * for the route list this mirrors.
 *
 * `firebase.json` rewrites every path to index.html, so pushState-based
 * navigation survives a refresh. A static host WITHOUT an SPA fallback will
 * 404 on refresh into a deep link — see the README.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type Route =
  | { name: 'matters' }
  | { name: 'matter'; matterId: string }
  | { name: 'review'; matterId: string; reviewId: string }
  | { name: 'playbooks' }
  | { name: 'playbook'; playbookId: string }
  | { name: 'settings' }
  | { name: 'positions' }
  | { name: 'not-found'; path: string };

/** Parses a pathname into a Route. Never throws — an unparseable or unknown
 * path (including a malformed percent-escape in an id segment) yields
 * `not-found` rather than a silent fallback to the home route. */
export function parseRoute(pathname: string): Route {
  try {
    return parsePath(pathname);
  } catch {
    return { name: 'not-found', path: pathname };
  }
}

function parsePath(pathname: string): Route {
  // Defensive: `useRoute` only ever passes a bare `window.location.pathname`
  // (which the URL spec guarantees excludes `?search` and `#hash`), so this
  // is a no-op today. But a future caller passing `location.href` or
  // `pathname + search` would otherwise have the query string silently
  // absorbed into the last id segment — a wrong route presented as a valid
  // one rather than a 404. Stripping both up front closes that off for good.
  const withoutHash = pathname.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  const trimmed = withoutQuery.length > 1 && withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
  const segments = trimmed.split('/').filter((s) => s.length > 0).map(decodeURIComponent);

  if (segments.length === 0) return { name: 'matters' };

  if (segments[0] === 'matters') {
    if (segments.length === 2) return { name: 'matter', matterId: segments[1] };
    if (segments.length === 4 && segments[2] === 'reviews') {
      return { name: 'review', matterId: segments[1], reviewId: segments[3] };
    }
  } else if (segments[0] === 'playbooks') {
    if (segments.length === 1) return { name: 'playbooks' };
    if (segments.length === 2) return { name: 'playbook', playbookId: segments[1] };
  } else if (segments[0] === 'settings' && segments.length === 1) {
    return { name: 'settings' };
  } else if (segments[0] === 'positions' && segments.length === 1) {
    return { name: 'positions' };
  }

  return { name: 'not-found', path: pathname };
}

/** Builds the canonical path for a Route. `buildPath(parseRoute(p)) === p`
 * holds for every canonical path (see router.test.ts) — id segments are
 * percent-encoded so a `/` or other reserved character in an id round-trips
 * instead of being mistaken for a path separator. */
export function buildPath(route: Route): string {
  switch (route.name) {
    case 'matters':
      return '/';
    case 'matter':
      return `/matters/${encodeURIComponent(route.matterId)}`;
    case 'review':
      return `/matters/${encodeURIComponent(route.matterId)}/reviews/${encodeURIComponent(route.reviewId)}`;
    case 'playbooks':
      return '/playbooks';
    case 'playbook':
      return `/playbooks/${encodeURIComponent(route.playbookId)}`;
    case 'settings':
      return '/settings';
    case 'positions':
      return '/positions';
    case 'not-found':
      return route.path;
  }
}

/** Current route plus a navigate function that pushes a new history entry
 * (never replaces one, so back/forward keeps working) and updates state.
 * Responds to browser back/forward via `popstate`.
 *
 * `canLeaveCurrentView`, if given, is consulted on every `popstate` — a
 * Back/Forward press, not a `navigate()` call — before the route change is
 * applied. Returning `false` means the browser has already moved
 * `window.location` for that step by the time this fires; there is no way
 * to veto it after the fact, so instead this pushes the route we were
 * actually still on back onto the stack, undoing the move so the address
 * bar and the (unchanged) rendered view stay in sync. This is what lets a
 * caller wire the same unsaved-changes guard that blocks a click on a nav
 * link (e.g. `confirmDiscardIfDirty` in App.tsx) onto Back/Forward too,
 * without `useRoute` itself knowing anything about templates or dirty
 * state. Re-read on every render (no memoization required of the caller),
 * so it always sees current component state rather than a stale closure. */
export function useRoute(canLeaveCurrentView?: () => boolean): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  const routeRef = useRef(route);
  useEffect(() => { routeRef.current = route; }, [route]);

  const guardRef = useRef(canLeaveCurrentView);
  useEffect(() => { guardRef.current = canLeaveCurrentView; });

  useEffect(() => {
    const onPopState = () => {
      if (guardRef.current && !guardRef.current()) {
        window.history.pushState(null, '', buildPath(routeRef.current));
        return;
      }
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.history.pushState(null, '', buildPath(next));
    setRoute(next);
  }, []);

  return [route, navigate];
}
