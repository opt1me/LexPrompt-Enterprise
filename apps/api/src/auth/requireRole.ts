import { ModelError, type Role } from '@lexprompt/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROLE_RANK } from './roles.ts';
import { ROUTE_POLICY, routeKey, type RoutePolicyTable } from './routeTable.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Every route registered on this instance after `registerRoleGate` ran,
     * recorded from Fastify's own `onRoute` event rather than from a list
     * anybody maintains.
     *
     * It exists so `authz.route.test.ts` can compare the routes that ACTUALLY
     * exist against `ROUTE_POLICY`, in both directions. Stage 1 shipped a
     * route-discovery regex that a change to one route registration silently
     * removed a route from; asking Fastify what it registered cannot have
     * that failure. It can have a different one — finding nothing at all —
     * so the suite asserts a realistic count before it asserts anything
     * about coverage.
     */
    lexpromptRoutes: { method: string; url: string }[];
  }
}

/** What a refusal tells the reader they need. "Forbidden" sends a trainee to
 *  a support queue with nothing to say. */
const NEEDED: Record<Role, string> = {
  reviewer: 'a LexPrompt role',
  partner: 'the partner role',
  admin: 'an administrator',
};

/**
 * One hook, reading the table, applied to every route — plus a registration
 * check that a route with no entry in the table cannot get past.
 *
 * DELIBERATELY NOT a per-route decorator. A decorator is opt-in, and a route
 * whose author forgot it ships open — the exact failure §7's table-driven
 * suite exists to make impossible. Here the check runs for every route, and
 * a missing entry is a REGISTRATION failure, so "forgot" is not a state this
 * server can be in: `app.ready()` rejects, which means every test that
 * builds a server fails, not only the authorisation suite.
 *
 * Three layers, because each covers a hole the others leave:
 *
 *  1. `onRoute` — a route registered after this hook with no entry throws at
 *     registration. This is the "fails the build" mechanism.
 *  2. `preHandler` — any route that reached the router with no entry is
 *     refused at request time with 503, never allowed. This covers a route
 *     registered BEFORE the gate, which `onRoute` never sees.
 *  3. `authz.route.test.ts` compares `lexpromptRoutes` against the table in
 *     both directions, so an entry for a route that no longer exists fails
 *     too — a stale table is how a reader comes to believe a policy is in
 *     force for something.
 *
 * `policy` is a parameter ONLY so the suite can build a server with, say, an
 * admin-only route and prove a reviewer is refused at it before any such
 * route exists in this stage. `buildServer` passes nothing, and
 * `authz.route.test.ts` asserts that `apps/api/src` calls this in exactly
 * one place with exactly one argument — the same shape of structural guard
 * as `oidc.test.ts`'s "req.principal is written in exactly ONE place".
 */
export function registerRoleGate(app: FastifyInstance, policy: RoutePolicyTable = ROUTE_POLICY): void {
  app.decorate('lexpromptRoutes', [] as { method: string; url: string }[]);

  app.addHook('onRoute', route => {
    // `route.method` is a string or an array of them; a route registered for
    // several methods needs an entry for each, because the methods are what
    // the policy is about.
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      app.lexpromptRoutes.push({ method, url: route.url });

      const key = routeKey(method, route.url);
      if (!(key in policy)) {
        throw new Error(
          `LexPrompt has no authorisation policy for the route ${key}. Add a line to `
          + 'ROUTE_POLICY in apps/api/src/auth/routeTable.ts saying the minimum role it '
          + 'needs. There is no default: a route nobody has decided about must not start, '
          + 'because the alternative is that it ships open.',
        );
      }
    }
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    // No route matched at all — Fastify leaves `routeOptions.url` undefined
    // and its own not-found handler answers. Refusing here would turn every
    // mistyped URL into a 503 "this is a deployment fault", which is a
    // confident wrong answer about the deployment; and there is nothing to
    // authorise, because there is no handler to reach.
    const url = req.routeOptions.url;
    if (url === undefined) return;

    const key = routeKey(req.method, url);
    const required = policy[key];
    if (required === undefined) {
      // Layer 2. Reached only by a route registered before this gate, which
      // `onRoute` never saw. It refuses EVERYTHING rather than allowing it,
      // and says plainly that this is not the caller's fault.
      throw new ModelError(
        `LexPrompt has no authorisation policy for ${key}. This is a deployment fault, not `
        + 'something you can fix.',
        'service_misconfigured', 503,
      );
    }
    if (required === 'public') return;

    // `req.actor` is set by the preHandler registered before this one, which
    // runs first because Fastify runs preHandler hooks in registration order.
    // Its absence is not "an anonymous caller" — an unauthenticated one was
    // already answered a 401 and never reached here — it is this gate having
    // been wired before the hook it depends on, which is a deployment fault
    // and is answered as one rather than as an allow.
    const actor = req.actor;
    if (!actor) {
      throw new ModelError(
        `LexPrompt could not establish who is calling ${key}. This is a deployment fault, `
        + 'not something you can fix.',
        'service_misconfigured', 503,
      );
    }
    if (ROLE_RANK[actor.role] < ROLE_RANK[required]) {
      throw new ModelError(
        `This needs ${NEEDED[required]}, and your LexPrompt role is ${actor.role}. `
        + 'Ask a colleague with that role, or ask an administrator to change yours.',
        'not_permitted', 403,
      );
    }
  });
}
