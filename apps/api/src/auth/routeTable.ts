import type { Role } from '@lexprompt/core';

/**
 * What a route requires: one of the three roles, or `public`.
 *
 * `public` is not "no policy" — it is a decision somebody made and wrote
 * down, and `authz.route.test.ts` asserts the complete list of public routes
 * so a second one cannot arrive quietly. The state this table cannot express
 * is "nobody has decided", which is the point: that state fails at
 * registration instead.
 */
export type RoutePolicy = Role | 'public';

/** Method-and-URL keys to a policy. `Record` rather than `Map` so the table
 *  reads as the table it is. */
export type RoutePolicyTable = Record<string, RoutePolicy>;

/**
 * `GET /v1/matters/:id` — the method and Fastify's OWN url pattern, so the
 * key a route registers under and the key this table names are the same
 * string and cannot drift into two vocabularies.
 *
 * HEAD IS NORMALISED TO GET, and that is a security property rather than a
 * convenience. Fastify synthesises a HEAD route for every GET
 * (`exposeHeadRoutes`, on by default — confirmed against fastify 5.12 by
 * enumerating what `onRoute` actually fires for), and that synthesised route
 * runs the GET handler and discards the body. So a HEAD entry could only
 * ever be a way to answer a GET's status code at a LOWER bar than the GET
 * itself, and there is no case where that is what anyone wanted. Folding the
 * two together here means no such entry can be written.
 */
export function routeKey(method: string, url: string): string {
  const m = method.toUpperCase();
  return `${m === 'HEAD' ? 'GET' : m} ${url}`;
}

/**
 * The minimum role for every route this API serves. **There is no default.**
 *
 * A route registered with no entry here throws at registration
 * (`registerRoleGate`'s `onRoute` hook), which fails every test that builds
 * a server — and, separately, `authz.route.test.ts` compares this table
 * against the routes Fastify says exist, in both directions. The default is
 * not `reviewer`; the default is "you have not decided yet", and that is not
 * a state this server can start in.
 *
 * `reviewer` covers most of the app because §7 says so: a reviewer creates
 * and edits matters, documents, collections and reviews, runs reviews, sets
 * dispositions and notes, confirms net positions, edits playbook drafts,
 * brings in precedent documents and exports. What a reviewer cannot do is
 * publish a playbook version (partner) or change workspace configuration and
 * role mapping (admin). Those routes do not exist yet; each arrives with its
 * own line here, added by the task that registers it, because a route and
 * its authorisation are one change.
 *
 * `/healthz` is the one `public` entry. It is the same exemption
 * `buildServer`'s authentication hook makes by URL, written down a second
 * time in the place a reader looks for "what can be reached without a
 * sign-in", and the two are asserted to agree.
 */
export const ROUTE_POLICY: RoutePolicyTable = {
  // Liveness, reached by an orchestrator that holds no token. It touches no
  // data and no gateway; `oidc.test.ts` pins both halves of that.
  'GET /healthz': 'public',

  'GET /v1/me': 'reviewer',
  'PUT /v1/me': 'reviewer',
  'POST /v1/infer': 'reviewer',
  'POST /v1/infer/stream': 'reviewer',
  'GET /v1/models': 'reviewer',

  // §7: a reviewer creates and edits matters. Publishing a playbook version
  // (partner) and changing workspace configuration (admin) are the two
  // things a reviewer cannot do, and neither is a matter route.
  'GET /v1/matters': 'reviewer',
  'GET /v1/matters/:id': 'reviewer',
  'PUT /v1/matters/:id': 'reviewer',
  'DELETE /v1/matters/:id': 'reviewer',

  // Documents and their bytes. Adding, reading and removing a document is
  // reviewer work by §7; nothing here publishes anything.
  'GET /v1/matters/:id/documents': 'reviewer',
  'POST /v1/documents': 'reviewer',
  'GET /v1/documents/:id': 'reviewer',
  'GET /v1/documents/:id/bytes': 'reviewer',
  'PATCH /v1/documents/:id/role': 'reviewer',
  'DELETE /v1/documents/:id': 'reviewer',

  // §7: a reviewer groups and ungroups documents into collections.
  'GET /v1/matters/:id/collections': 'reviewer',
  'GET /v1/collections/:id': 'reviewer',
  'PUT /v1/collections/:id': 'reviewer',
  'DELETE /v1/collections/:id': 'reviewer',

  // Playbooks. §7: a reviewer edits a playbook DRAFT; what a reviewer
  // cannot do is PUBLISH a version, which is the one `partner` line below.
  'GET /v1/playbooks': 'reviewer',
  'GET /v1/playbooks/:id': 'reviewer',
  'PUT /v1/playbooks/:id': 'reviewer',
  'DELETE /v1/playbooks/:id': 'reviewer',
  'DELETE /v1/playbooks/:id/draft': 'reviewer',
  'GET /v1/playbooks/:id/content': 'reviewer',
  'GET /v1/playbooks/:id/versions': 'reviewer',
  'GET /v1/versions/:id': 'reviewer',

  // PARTNER. Publishing a version is one of the two things §7 says a
  // reviewer cannot do, and an import publishes a v1, so it carries the same
  // bar — an import that only needed `reviewer` would be a door around the
  // gate, which is the shape ruling R-E8 deleted rather than left standing.
  'POST /v1/playbooks/:id/versions': 'partner',
  'POST /v1/playbooks/import': 'partner',

  // Changesets. A reviewer builds one and records decisions on it (§7);
  // PUBLISHING one produces a playbook version, so it sits at the same bar
  // as publishing from the editor — two routes to one act must not have two
  // different bars (R-E8).
  'GET /v1/playbooks/:id/changesets': 'reviewer',
  'GET /v1/changesets/:id': 'reviewer',
  'PUT /v1/changesets/:id': 'reviewer',
  'POST /v1/changesets/:id/publish': 'partner',

  // §7: a reviewer runs reviews, sets dispositions and notes, and confirms
  // net positions. All of that is one whole-record write to a review.
  'GET /v1/matters/:id/reviews': 'reviewer',
  'GET /v1/reviews/:id': 'reviewer',
  'PUT /v1/reviews/:id': 'reviewer',
  'DELETE /v1/reviews/:id': 'reviewer',

  // Reconciliation (§6.5). ADMIN, not reviewer: the listing names bytes
  // that no record claims — which is a fact about storage rather than about
  // any matter — and the second route destroys them. A reviewer who could
  // run it could delete bytes whose rows had not yet been written by an
  // upload still in flight.
  'GET /v1/admin/blob-orphans': 'admin',
  'POST /v1/admin/blob-orphans/delete': 'admin',

  // §6.6: the workspace's model choice. GET is `reviewer` — any signed-in
  // role reads what model runs their reviews, the same "read is everyone,
  // write is gated" shape `GET /v1/playbooks/:id` already has relative to
  // publishing. PUT is `admin`: changing which provider the firm's text
  // goes to sits beside role mapping as the other thing only an
  // administrator may change (§7).
  'GET /v1/workspace/settings': 'reviewer',
  'PUT /v1/workspace/settings': 'admin',
};
