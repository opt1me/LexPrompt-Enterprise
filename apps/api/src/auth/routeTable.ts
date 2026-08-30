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

  // §8's live socket (Stage 4 Task 16). `reviewer`: it delivers events about
  // reviews the caller can already read one at a time over HTTP, and every
  // subscription is scoped to the caller's workspace before it is joined.
  //
  // IT IS A REAL FASTIFY ROUTE, and that is the point of the entry. The
  // upgrade itself is handled on the server's own `upgrade` event
  // (`realtime/socket.ts` — authenticated BEFORE the upgrade, S29), which
  // Fastify's router never sees; registering the path as an ordinary GET
  // that answers 426 to a non-upgrade request is what puts the socket inside
  // `authz.route.test.ts`'s bidirectional coverage and `oidc.test.ts`'s
  // no-token 401 sweep. A socket registered any other way would be silently
  // absent from both, which is the shape of a test that cannot fail. The
  // upgrade path reads THIS entry rather than deciding a role of its own.
  'GET /v1/ws': 'reviewer',

  // §6.3's attribution requirement needs a NAME for an id, and `GET /v1/me`
  // answers only for the caller — so before this route a card could show
  // that a finding had been rejected and could not say by whom.
  // `reviewer`: a person who cannot resolve the name on a disposition they
  // are being shown cannot read their own screen, and S10 has no per-matter
  // ACLs for a directory to respect. It is a READ; nothing about it can
  // assert an attribution, which is the property `findings/import.ts`'s fix
  // round makes worth stating out loud.
  'GET /v1/workspace/users': 'reviewer',
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

  // What happened in this matter, and who did it (section 10.1, S22).
  // `reviewer`: it is a UNION over three records a reviewer can already read
  // one at a time -- a disposition's history, a run, and the audited acts of
  // a matter they work in. A higher bar would mean a reviewer could see each
  // change and not the list of them, which is a distinction with no reader.
  'GET /v1/matters/:id/activity': 'reviewer',
  'POST /v1/documents': 'reviewer',
  'GET /v1/documents/:id': 'reviewer',
  'GET /v1/documents/:id/bytes': 'reviewer',
  'PATCH /v1/documents/:id/role': 'reviewer',
  // Re-queues a FAILED parse. `reviewer`, like every other write on a
  // document: it changes no content and no judgement — it asks the same
  // bytes to be read again.
  'POST /v1/documents/:id/reparse': 'reviewer',
  'DELETE /v1/documents/:id': 'reviewer',

  // Precedent sets and precedent documents (§11.1). `reviewer` throughout:
  // this table's own docstring already lists "brings in precedent documents"
  // among the things §7 says a reviewer does, and none of these routes
  // publishes anything or changes workspace configuration.
  //
  // DELETE is `reviewer` too, and it is the one worth pausing on. Deleting a
  // set destroys another client's documents AND makes every house position
  // adopted from it unresolvable — but it is the same person's own working
  // material, brought in by a reviewer in the first place, and the routes a
  // reviewer cannot reach are defined by §7 as publishing and configuration.
  // Raising this to `partner` would be a rule this design did not make.
  'POST /v1/precedent-sets': 'reviewer',
  'GET /v1/precedent-sets/:id': 'reviewer',
  'DELETE /v1/precedent-sets/:id': 'reviewer',
  'GET /v1/precedent-sets/:id/documents': 'reviewer',
  'POST /v1/precedent-sets/:id/documents': 'reviewer',
  'GET /v1/precedent-documents/:id': 'reviewer',
  'GET /v1/precedent-documents/:id/bytes': 'reviewer',
  'DELETE /v1/precedent-documents/:id': 'reviewer',

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

  // §6.5: where a house rule came from. `reviewer` — reading the evidence
  // behind a position is the same act as reading the position, and the whole
  // argument for storing it is that a person can check it. There is no write
  // route: a basis is recorded inside the publish transaction that adopts the
  // position (`POST /v1/playbooks/:id/versions`, `partner`), so the only bar
  // that could apply to writing one is already the publish's own.
  'GET /v1/playbooks/:id/clauses/:clauseId/basis': 'reviewer',

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

  // §6.2/§6.3, Task 14: a review's findings, its dispositions and its notes,
  // assembled from their own rows. Reading them is the same act as reading
  // the review, so it sits at the review's own bar and is scoped to the
  // caller's workspace inside the handler.
  'GET /v1/reviews/:id/findings': 'reviewer',

  // §7: a reviewer sets dispositions and notes. `reviewer` on all three —
  // recording a judgement about a finding IS the reviewing, and a bar that
  // let a reviewer run a review but not say what they made of it would be a
  // rule this design did not make.
  //
  // The history route is `reviewer` for the same reason `GET
  // /v1/playbooks/:id/clauses/:clauseId/basis` is: reading the evidence
  // behind a judgement is the same act as reading the judgement. It had no
  // caller in Stage 3 (P28); Stage 4's `DispositionHistory` panel is the
  // one, and inherited a tested, authorised endpoint rather than writing
  // one against a table it was meeting for the first time.
  'PUT /v1/reviews/:id/findings/:findingsKey/:clauseId/disposition': 'reviewer',
  'POST /v1/reviews/:id/findings/:findingsKey/:clauseId/notes': 'reviewer',
  // §7 names confirming a net position among what a reviewer does, and it
  // is the same act as recording a disposition — a person's judgement about
  // one answer — so it sits at the same bar.
  'PUT /v1/reviews/:id/findings/:findingsKey/:clauseId/net-position': 'reviewer',
  'GET /v1/reviews/:id/findings/:findingsKey/:clauseId/history': 'reviewer',

  // §6.3/S17's assignment (Task 24). Asking a colleague to look at a clause
  // is a REQUEST, not a disposition, so it sits at the same `reviewer` bar
  // as the disposition it deliberately does not change.
  //
  // A partner-only gate here would invert the owner's own case: it is the
  // TRAINEE who assigns, when they are not sure -- "a trainee may verify one
  // clause and be happy, then flag another for a Partner's view". Raising
  // this bar would take the escape hatch away from the person it exists for.
  //
  // The resolve route is `reviewer` for the same reason and is narrowed
  // INSIDE the handler to the two people it can belong to: the assignee, who
  // has looked, and the assigner, who no longer needs them to. A role is the
  // wrong instrument for "is this yours" -- every reviewer holds the same
  // role and only two of them are party to any one request.
  //
  // The list route answers the CALLER'S OWN open requests, from the token
  // and never from a query parameter. Reading another person's queue would
  // be a different feature with a different bar.
  'POST /v1/reviews/:id/findings/:findingsKey/:clauseId/assignments': 'reviewer',
  'POST /v1/assignments/:id/resolve': 'reviewer',
  'GET /v1/assignments': 'reviewer',

  // The review's whole disposition history (section 6.3.1). `reviewer`: it
  // is the same facts the per-finding history route already returns at the
  // same bar, gathered for one review. A higher bar here would mean a
  // reviewer could see each change one at a time and not all of them
  // together, which is a distinction with no reader.
  'GET /v1/reviews/:id/history': 'reviewer',

  // §7: a reviewer RUNS reviews. All four at `reviewer`, including cancel —
  // stopping a run you started is part of running one, and a bar that let a
  // reviewer start work nobody but a partner could stop would leave the
  // firm's model budget running with no one able to reach it.
  //
  // Reading a run and its events is the same act as reading the review, and
  // both are scoped to the caller's workspace inside the handler.
  'POST /v1/reviews/:id/runs': 'reviewer',
  // §9.1: re-running ONE clause. The same bar as starting a run, because it
  // IS one — a run over a single cell — and because clearing the judgement
  // that described the answer being replaced is part of re-running it.
  'POST /v1/reviews/:id/findings/:findingsKey/:clauseId/retry': 'reviewer',
  // A review's live run, so a reload or a second tab can pick one up.
  // Reading it is the same act as reading the review.
  'GET /v1/reviews/:id/runs/live': 'reviewer',
  'GET /v1/runs/:id': 'reviewer',
  'POST /v1/runs/:id/cancel': 'reviewer',
  'GET /v1/runs/:id/events': 'reviewer',

  // Reconciliation (§6.5). ADMIN, not reviewer: the listing names bytes
  // that no record claims — which is a fact about storage rather than about
  // any matter — and the second route destroys them. A reviewer who could
  // run it could delete bytes whose rows had not yet been written by an
  // upload still in flight.
  //
  // OPERATOR-ONLY, and named as such rather than left to look like a route
  // some screen calls: nothing in `src/` calls either of these, deliberately
  // and for now. The path is `curl` with an admin's own bearer token,
  // documented in README's "Reclaiming orphaned document files"; an in-app
  // screen is deferred, the way `⌘K` and the Report tab are deferred.
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
