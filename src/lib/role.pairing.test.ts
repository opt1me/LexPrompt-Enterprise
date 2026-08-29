import { describe, it, expect } from 'vitest';
import { canPublish } from './role';
// Cross-project import, same precedent as `src/lib/model/stage1DoD.test.ts`:
// this is the ONE shipped table, and a UI gate that quietly drifted from it
// would be exactly the "dead button, or a button with nothing behind it"
// failure Task 17's brief warns about — checked against the SHIPPED table,
// never a fixture that merely claims to match it.
// eslint-disable-next-line import/no-relative-packages
import { ROUTE_POLICY } from '../../apps/api/src/auth/routeTable.ts';

/**
 * Task 17: "the UI role gate is a courtesy, not the control." This file is
 * the test that proves it is a courtesy in front of a REAL control, rather
 * than the only thing standing there — for both partner-only actions the UI
 * disables a control for.
 *
 * A control disabled with no API entry behind it is theatre (a decoration
 * nobody enforces); an API entry with no UI control is a button that fails
 * only when clicked. Both halves have to be checked, and checked against
 * `ROUTE_POLICY` itself — a copy of "what I expect the table to say" would
 * pass even if the table changed under it, which is exactly the shape
 * S1/authz's own sweep exists to rule out.
 */
describe('the UI publish gate is paired with a real server-side control', () => {
  const GATED_ROUTES = [
    'POST /v1/playbooks/:id/versions', // TemplateEditor's Publish button
    'POST /v1/changesets/:id/publish', // ChangesetReview's Publish button
  ] as const;

  it('every UI-gated publish route requires the partner role on the shipped table', () => {
    for (const route of GATED_ROUTES) {
      expect(ROUTE_POLICY[route], route).toBe('partner');
    }
  });

  it('canPublish (the UI half) agrees with the server: partner and admin yes, reviewer no', () => {
    // `ROUTE_POLICY`'s check is a MINIMUM rank (`ROLE_RANK[actor.role] <
    // ROLE_RANK[required]`), so 'partner' admits partner and admin, never
    // reviewer — `canPublish` has to answer the identical three cases or
    // the UI and the API would disagree about who sees an enabled button.
    expect(canPublish('reviewer')).toBe(false);
    expect(canPublish('partner')).toBe(true);
    expect(canPublish('admin')).toBe(true);
  });

  it('sanity: the table really does refuse a route it has not decided about (mutation-provable)', () => {
    // Proves this suite is reading `ROUTE_POLICY` for real, not a stub that
    // would answer 'partner' for anything asked of it.
    expect(ROUTE_POLICY['GET /v1/matters']).not.toBe('partner');
    expect('POST /v1/this-route-does-not-exist' in ROUTE_POLICY).toBe(false);
  });
});
