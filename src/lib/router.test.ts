import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseRoute, buildPath, useRoute, type Route } from './router';

// No @testing-library/react in this project; driving a real react-dom root
// directly needs this flag set for React's `act()` to recognize the
// environment (see src/components/Toast.test.tsx for the same pattern).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('parseRoute', () => {
  it('parses each canonical path', () => {
    expect(parseRoute('/')).toEqual({ name: 'matters' });
    expect(parseRoute('/matters/m1')).toEqual({ name: 'matter', matterId: 'm1' });
    expect(parseRoute('/matters/m1/reviews/r1')).toEqual({
      name: 'review',
      matterId: 'm1',
      reviewId: 'r1',
    });
    expect(parseRoute('/playbooks')).toEqual({ name: 'playbooks' });
    expect(parseRoute('/playbooks/p1')).toEqual({ name: 'playbook', playbookId: 'p1' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
  });

  it('never throws, and yields not-found for an unknown path rather than falling back to matters', () => {
    expect(() => parseRoute('/nope')).not.toThrow();
    expect(parseRoute('/nope')).toEqual({ name: 'not-found', path: '/nope' });
    expect(parseRoute('/matters')).toEqual({ name: 'not-found', path: '/matters' });
    expect(parseRoute('/matters/m1/reviews')).toEqual({
      name: 'not-found',
      path: '/matters/m1/reviews',
    });
    expect(parseRoute('/matters/m1/oops/r1')).toEqual({
      name: 'not-found',
      path: '/matters/m1/oops/r1',
    });
    expect(parseRoute('/settings/extra')).toEqual({
      name: 'not-found',
      path: '/settings/extra',
    });
  });

  it('never throws on a malformed percent-escape in a segment', () => {
    expect(() => parseRoute('/matters/%')).not.toThrow();
    expect(parseRoute('/matters/%').name).toBe('not-found');
  });

  it('resolves a trailing slash the same as without', () => {
    expect(parseRoute('/matters/m1/')).toEqual(parseRoute('/matters/m1'));
    expect(parseRoute('/playbooks/')).toEqual(parseRoute('/playbooks'));
    expect(parseRoute('/settings/')).toEqual(parseRoute('/settings'));
    expect(parseRoute('/matters/m1/reviews/r1/')).toEqual(parseRoute('/matters/m1/reviews/r1'));
  });

  it('decodes percent-escaped ids', () => {
    expect(parseRoute('/matters/a%2Fb')).toEqual({ name: 'matter', matterId: 'a/b' });
    expect(parseRoute('/playbooks/a%20b')).toEqual({ name: 'playbook', playbookId: 'a b' });
  });
});

describe('buildPath', () => {
  it('builds the canonical path for each route', () => {
    expect(buildPath({ name: 'matters' })).toBe('/');
    expect(buildPath({ name: 'matter', matterId: 'm1' })).toBe('/matters/m1');
    expect(buildPath({ name: 'review', matterId: 'm1', reviewId: 'r1' })).toBe(
      '/matters/m1/reviews/r1',
    );
    expect(buildPath({ name: 'playbooks' })).toBe('/playbooks');
    expect(buildPath({ name: 'playbook', playbookId: 'p1' })).toBe('/playbooks/p1');
    expect(buildPath({ name: 'settings' })).toBe('/settings');
    expect(buildPath({ name: 'not-found', path: '/nope' })).toBe('/nope');
  });

  it('percent-encodes ids containing URL-significant characters', () => {
    expect(buildPath({ name: 'matter', matterId: 'a/b' })).toBe('/matters/a%2Fb');
    expect(buildPath({ name: 'playbook', playbookId: 'a b?c=1' })).toBe(
      '/playbooks/a%20b%3Fc%3D1',
    );
    expect(
      buildPath({ name: 'review', matterId: 'm/1', reviewId: 'r&1' }),
    ).toBe('/matters/m%2F1/reviews/r%261');
  });
});

describe('round-trip: buildPath(parseRoute(p)) === p', () => {
  const canonicalPaths = [
    '/',
    '/matters/m1',
    '/matters/m1/reviews/r1',
    '/playbooks',
    '/playbooks/p1',
    '/settings',
    '/nope',
    '/matters/m1/reviews',
  ];

  it.each(canonicalPaths)('round-trips %s', (p) => {
    expect(buildPath(parseRoute(p))).toBe(p);
  });

  it('round-trips ids with URL-significant characters, including a literal slash', () => {
    const idsWithSpecialChars = ['a/b', 'a b', 'a?b=1&c', 'a#b', 'a%b', "a'b\"c", 'a+b'];
    for (const id of idsWithSpecialChars) {
      const matterRoute: Route = { name: 'matter', matterId: id };
      expect(parseRoute(buildPath(matterRoute))).toEqual(matterRoute);

      const reviewRoute: Route = { name: 'review', matterId: id, reviewId: `x-${id}` };
      expect(parseRoute(buildPath(reviewRoute))).toEqual(reviewRoute);

      const playbookRoute: Route = { name: 'playbook', playbookId: id };
      expect(parseRoute(buildPath(playbookRoute))).toEqual(playbookRoute);
    }
  });

  it('round-trips alphanumeric ids from Math.random().toString(36), today\'s id scheme', () => {
    const id = Math.random().toString(36).slice(2);
    const route: Route = { name: 'matter', matterId: id };
    expect(parseRoute(buildPath(route))).toEqual(route);
  });
});

describe('useRoute', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPath = window.location.pathname;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.history.replaceState(null, '', originalPath);
    vi.restoreAllMocks();
  });

  interface RouteApi {
    route: Route;
    navigate: (route: Route) => void;
  }

  function Harness({ capture }: { capture: (api: RouteApi) => void }) {
    const [route, navigate] = useRoute();
    capture({ route, navigate });
    return null;
  }

  function render(): RouteApi {
    let latest!: RouteApi;
    act(() => {
      root.render(React.createElement(Harness, { capture: (api) => { latest = api; } }));
    });
    return latest;
  }

  it('reads the initial route from window.location', () => {
    window.history.replaceState(null, '', '/playbooks');
    const api = render();
    expect(api.route).toEqual({ name: 'playbooks' });
  });

  it('navigates by pushing a new history entry, not replacing one', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const api = render();

    act(() => {
      api.navigate({ name: 'matter', matterId: 'm1' });
    });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(null, '', '/matters/m1');
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/matters/m1');
  });

  it('updates route state immediately after navigate, without waiting for popstate', () => {
    const api = render();
    let latest = api;
    act(() => {
      latest.navigate({ name: 'settings' });
    });
    // re-render captured a fresh api via the harness closure
    const rendered = render();
    expect(rendered.route).toEqual({ name: 'settings' });
  });

  it('responds to browser back/forward via popstate', () => {
    window.history.replaceState(null, '', '/');
    const api = render();
    expect(api.route).toEqual({ name: 'matters' });

    // Simulate the browser navigating (e.g. via back()) without going
    // through our navigate() function.
    window.history.pushState(null, '', '/playbooks/p1');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    const rendered = render();
    expect(rendered.route).toEqual({ name: 'playbook', playbookId: 'p1' });
  });

  it('removes its popstate listener on unmount so a leaked handler cannot fire against a detached component', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    render();

    const [, handler] = addSpy.mock.calls.find((call) => call[0] === 'popstate') ?? [];
    expect(handler).toBeDefined();

    act(() => {
      root.unmount();
    });

    expect(removeSpy).toHaveBeenCalledWith('popstate', handler);
  });

  it('survives a StrictMode double-mount/unmount without leaking listeners', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    act(() => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Harness, { capture: () => {} }),
        ),
      );
    });

    const popstateAdds = addSpy.mock.calls.filter((call) => call[0] === 'popstate').length;

    act(() => {
      root.unmount();
    });

    const popstateRemoves = removeSpy.mock.calls.filter((call) => call[0] === 'popstate').length;
    expect(popstateRemoves).toBe(popstateAdds);

    // No lingering listener: dispatching popstate now must not throw, even
    // though the component tree is gone.
    expect(() => {
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }).not.toThrow();
  });
});
