import multipart from '@fastify/multipart';
import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest,
} from 'fastify';
import { ModelError, WS_SUBPROTOCOL } from '@lexprompt/core';
import type { Principal } from './oidc.ts';
import type { GatewayClient } from './gatewayClient.ts';
import type { Actor } from './auth/actor.ts';
import type { Db } from './db/pool.ts';
import type { BlobStore } from './blob/store.ts';
import { registerRoleGate } from './auth/requireRole.ts';
import { registerInfer } from './routes/infer.ts';
import { registerInferStream } from './routes/inferStream.ts';
import { registerMe } from './routes/me.ts';
import { registerUsers } from './routes/users.ts';
import { registerMatters } from './routes/matters.ts';
import { registerDocuments } from './routes/documents.ts';
import { registerCollections } from './routes/collections.ts';
import { registerPrecedents } from './routes/precedents.ts';
import { registerPositionBasis } from './routes/positionBasis.ts';
import { registerPlaybooks } from './routes/playbooks.ts';
import { registerChangesets } from './routes/changesets.ts';
import { registerWorkspaceSettings } from './routes/workspaceSettings.ts';
import { registerReviews } from './routes/reviews.ts';
import { registerFindings } from './routes/findings.ts';
import { registerHistory } from './routes/history.ts';
import { registerActivity } from './routes/activity.ts';
import { registerAssignments } from './routes/assignments.ts';
import { registerRuns } from './routes/runs.ts';
import { createHub, type Hub } from './realtime/hub.ts';
import { attachSocket, type SocketCaps } from './realtime/socket.ts';
import { createPresenceRegistry, type PresenceRegistry } from './realtime/presence.ts';
import { ConflictError } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` once a bearer token has been verified against
     *  the configured issuer. Absent on `/healthz`, which is excluded from
     *  the hook by URL, exactly as the gateway excludes it (Task 15). */
    principal?: Principal;
    /** Set by the SAME preHandler that sets `principal`, once, so no route
     *  resolves an actor of its own. A route reading `req.actor!` reads a
     *  value the hook guarantees; a route that resolved its own would be a
     *  second implementation of provisioning. */
    actor?: Actor;
  }
  interface FastifyInstance {
    /** The process's fan-out hub (§8, Task 16). Decorated rather than
     *  returned beside the app so `main.ts` can hand the SAME hub to the
     *  event feed (Task 18) — two hubs would be a socket listening to one
     *  and the outbox feeding the other, which delivers nothing and looks
     *  exactly like a quiet review. */
    lexpromptHub: Hub;
    /** Who this process believes is here (§8, Task 22). Decorated for the
     *  same reason the hub is: `main.ts` hands the SAME registry to the
     *  event feed, which merges other replicas' beats into it. Two
     *  registries would be a socket publishing one roster and a colleague's
     *  beats landing in the other — a review that reads as empty while two
     *  people are in it. */
    lexpromptPresence: PresenceRegistry;
  }
}

export type TokenVerifier = (token: string) => Promise<Principal>;

/**
 * The one preHandler standing between every route and an unauthenticated
 * caller. There is no configuration value that skips this (S29) — the only
 * thing that varies across environments is which `verify` function main.ts
 * builds from which issuer.
 *
 * A `group_overage` reaches the browser as 403 `group_overage`, not folded
 * into a generic 401 — `ModelError`'s own status and code are answered back
 * verbatim, because "sign in again" and "ask your admin" are different
 * instructions and this is the one place that distinction can get lost.
 */
export function requireUser(verify: TokenVerifier) {
  return async function requireUserHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      void reply.code(401).send({
        error: { code: 'sign_in_required', message: 'Sign in to use LexPrompt.' },
      });
      return;
    }
    try {
      req.principal = await verify(token);
    } catch (err) {
      if (err instanceof ModelError) {
        void reply.code(err.status).send({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  };
}

export interface ServerDeps {
  verify: TokenVerifier;
  /** Where a validated call is forwarded (Task 17). */
  gateway: GatewayClient;
  /** The single workspace §6 seeds — Stage 1 has no workspace resolution. */
  workspaceId: string;
  /** `ApiConfig.maxBodyBytes` — see there for why this hop declares a limit
   *  rather than inheriting Fastify's undeclared 1 MiB. */
  maxBodyBytes: number;
  /** The app role's connection (Task 2). Used directly by `/v1/me`'s PUT
   *  handler; every OTHER write that needs a person's identity goes through
   *  `resolveActor` instead, so this is not a second route to provisioning. */
  db: Db;
  /** Just-in-time provisioning (§7, Task 2's `app_user`): resolves a
   *  validated `Principal` to the `app_user` row it names, creating one on
   *  first sight. Injected, so a route test needs no database and so Task
   *  4's role lookup has exactly one place to live. */
  resolveActor(principal: Principal): Promise<Actor>;
  /** `API_EVENT_PAGE_MAX` — the run outbox's page size, DECLARED rather
   *  than inherited. A run of forty cells writes eighty-odd events, and a
   *  route that would hand a client all of them on request is an undeclared
   *  cap by another name. */
  eventPageMax: number;
  /** `API_ASSIGNMENT_INBOX_LIMIT` -- the cross-matter inbox's page size,
   *  DECLARED rather than invented here. It comes in for the same reason
   *  `eventPageMax` does: `loadConfig` is the one reader of the
   *  environment, and a default picked in this file would be an undeclared
   *  cap in the tier that cannot report it. */
  assignmentInboxLimit: number;
  /**
   * §8's live socket (Stage 4 Task 16), and the `verify` above is what
   * authenticates it — the SAME function, before the upgrade.
   *
   * The caps come in rather than being read here for the reason every other
   * cap does: `loadConfig` is the one reader of the environment, and a
   * default invented in this file would be an undeclared cap in the tier
   * that cannot report it.
   */
  socket: SocketCaps;
  /** This process's identity, echoed on every socket's `hello` frame so
   *  "which replica served me" is a fact rather than a guess. */
  instanceId: string;
  /** Where the firm's document BYTES live (Task 10). Injected rather than
   *  constructed here, so a route test needs no Azurite and so there is
   *  exactly one store for the upload path and the delete cascade to share
   *  — a cascade that reached a different store from the one the upload
   *  wrote to would leave every byte behind and report success. */
  blobs: BlobStore;
}

/**
 * Everything Fastify itself refuses, answered in LexPrompt's envelope.
 *
 * Without this, a 413 (a body over `maxBodyBytes`), a 415 (wrong
 * content-type), a 400 (malformed JSON) and a 404 all come back as
 * `{statusCode, error, message, code}` — Fastify's own shape, which
 * `gatewayModelClient` reads as `body.error.code`, finds nothing in, and
 * renders to a lawyer as the bare string "HTTP 413". A status number with no
 * cause and no action is the quiet-wrong-answer shape this project's one
 * rule is about, one layer down.
 *
 * A `ModelError` thrown out of a handler keeps its own status and code, for
 * the same reason `requireUser` answers one verbatim: `group_overage` is a
 * 403 that must not become a 401 — and, since Task 5, `not_permitted` is a
 * 403 that must not become a 500.
 *
 * EXPORTED so `authz.route.test.ts` can stand a server up with a
 * partner-only route (none exists in this stage) and assert the refusal in
 * THIS envelope rather than in one the test wrote for itself. A test that
 * builds its own error shape proves its own error shape.
 */
export function registerErrorEnvelope(app: FastifyInstance, maxBodyBytes: number): void {
  app.setNotFoundHandler(async (request, reply) => reply.code(404).send({
    error: {
      code: 'unknown',
      message: `LexPrompt has no ${request.method} ${request.url} endpoint.`,
    },
  }));

  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    if (err instanceof ModelError) {
      const body: Record<string, unknown> = { error: { code: err.code, message: err.message } };
      // A `ConflictError` carries the row as it stands NOW, so a caller can
      // show the reader what replaced their write without a second round
      // trip. The key is ABSENT — never `current: null` — when the conflict
      // came from an id this workspace may not see: "someone changed it,
      // here it is" and "that id is taken, and by what is not yours to
      // know" are different facts and must not arrive in one shape.
      if (err instanceof ConflictError && err.current !== undefined) body.current = err.current;
      return reply.code(err.status).send(body);
    }
    // A FOREIGN KEY VIOLATION, in words a lawyer can act on.
    //
    // Postgres answers `insert or update on table "changeset" violates
    // foreign key constraint "changeset_from_version_id_fkey"`. That is true
    // and it is useless: it names a constraint, not a thing anybody has ever
    // seen on a screen, and without this branch it reaches the browser as a
    // 500 saying "LexPrompt failed to handle this request" with the raw
    // constraint name attached.
    //
    // It matters most for the uploader (§13.1), which is the one caller that
    // sends records naming ids MINTED BY ANOTHER SYSTEM — this browser's
    // IndexedDB — and whose whole product is a report saying, by name, what
    // did not move and why. "This record names something LexPrompt does not
    // know" is a sentence that goes on that report beside the record's name;
    // a constraint name is not.
    //
    // 409, not 500: nothing here is broken. The request named something that
    // is not there, which is the caller's to fix by sending it again once it
    // is — the same shape as every other conflict, and `code: 'conflict'` is
    // already in `MODEL_ERROR_CODES`, so the browser classifies it through
    // the vocabulary it shares rather than by matching on this wording.
    if (err.code === '23503') {
      const detail = (err as FastifyError & { constraint?: string }).constraint;
      return reply.code(409).send({ error: {
        code: 'conflict',
        message: 'This record names something LexPrompt does not know — a matter, a playbook '
          + 'version or a person that is not on the server. Nothing was saved. '
          + (detail ? `(${detail})` : ''),
      } });
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      return reply.code(413).send({ error: {
        code: 'prompt_too_large',
        message: 'This request is larger than LexPrompt accepts in one call '
          + `(the limit is ${maxBodyBytes} bytes, set by API_MAX_BODY_BYTES). A scanned `
          + 'document sends an image of every page, so a long scan can exceed it; '
          + 'reviewing fewer documents at once is the thing to try, and an '
          + 'administrator can raise the limit.',
      } });
    }
    if (status === 415 || status === 400) {
      return reply.code(status).send({ error: {
        code: 'unknown',
        message: `LexPrompt could not read this request (${err.message}).`,
      } });
    }
    // Anything genuinely unexpected. The message is the error's own, not a
    // reassuring summary: a 500 nobody can describe is worse than a 500 that
    // says what threw.
    process.stderr.write(`api: unhandled error on ${request.method} ${request.url}: ${err.stack ?? err.message}\n`);
    return reply.code(status >= 400 ? status : 500).send({ error: {
      code: 'unknown',
      message: `LexPrompt failed to handle this request (${err.message}).`,
    } });
  });
}

/**
 * This derives a `Principal`, resolves it to an `app_user` row on the SAME
 * hook (Task 2's just-in-time provisioning), answers `/healthz`, forwards
 * `/v1/infer`, `/v1/infer/stream` and `/v1/models` to the gateway with the
 * actor overwritten from the token (Task 17, reused by Task 18 for the
 * streaming route), and answers `/v1/me`.
 *
 * `registerRoleGate` then holds every route to `ROUTE_POLICY`'s minimum role
 * — refused HERE, by the API, whatever the browser chose to render (§18
 * item 3). The role itself comes from the token's group claim, resolved by
 * `main.ts`'s `resolveActor`; this function only sees the `Actor` that
 * produced.
 */
/** The path half of a request URL — everything before `?` or `#`. Written
 *  here rather than through `new URL()` because `req.url` is origin-relative
 *  and `URL` needs a base it would then have to invent. */
function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: deps.maxBodyBytes });

  // The DECLARED limit, applied to the multipart path too — to BOTH parts
  // of it.
  //
  // `bodyLimit` above does not govern a multipart file part — @fastify/multipart
  // has its OWN default (1 MiB, and an unlimited part count), so with nothing
  // set here the tightest cap in the chain would once again be an undeclared
  // one nobody was told about. That is the exact trap Stage 1's final round
  // found at nginx (`infra/nginx/web.conf` sets `client_max_body_size 0` to
  // defer to this process), one layer further in, on the path that carries a
  // scanned lease.
  //
  // `fieldSize` IS THE THIRD TIME THAT TRAP HAS BEEN SPRUNG on this same
  // path, and it was left undeclared here while the paragraph above claimed
  // the chain agreed. @fastify/multipart defaults only `parts` and
  // `fileSize`; `fieldSize` fell through to busboy's own 1 MiB default, and
  // busboy TRUNCATES an oversized field rather than erroring. The `record`
  // part is `text/plain` (that is what `FormData.append` of a string sends),
  // so @fastify/multipart's `InvalidJSONFieldError` — raised on a truncated
  // field only when the part is labelled `application/json` — never fired.
  // A `DocumentRecord` over 1,048,576 bytes, which is `record.text`: the
  // whole extracted text of a long lease bundle or an OCR'd scan, arrived at
  // `JSON.parse` cut mid-string and was refused as *"the record field is not
  // JSON"* — a message blaming the browser's serialisation, naming no size,
  // and pointing at no key an administrator could raise.
  //
  // So FIVE limits agree by construction: nginx defers, Fastify declares
  // `API_MAX_BODY_BYTES`, multipart declares the same value for a file part
  // AND for a field, and the gateway's prompt cap stays its own separate,
  // separately-reported number because it counts characters of PROMPT rather
  // than bytes of upload.
  //
  // `throwFileSizeLimit` so an oversized upload is REFUSED rather than
  // silently truncated: a document stored with its tail missing is bytes
  // that lie about being the file. There is no `throwFieldSizeLimit` to pair
  // with it — busboy simply truncates — which is precisely why the declared
  // value has to be one no legitimate record reaches rather than a cap the
  // route could report hitting.
  void app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: deps.maxBodyBytes, fieldSize: deps.maxBodyBytes, files: 2, fields: 8 },
  });

  registerErrorEnvelope(app, deps.maxBodyBytes);

  const auth = requireUser(deps.verify);
  app.addHook('preHandler', async (req, reply) => {
    // The PATH, not the whole URL. `req.url === '/healthz'` made
    // `/healthz?probe=1` require a token — fail-closed and harmless in
    // itself, but the two exemption lists `authz.route.test.ts` asserts
    // "agree" then agreed only on one exact string, and a probe with a
    // cache-buster is a normal thing for a load balancer to send.
    if (pathOf(req.url) === '/healthz') return;
    await auth(req, reply);
    // `requireUser` answers the reply itself on failure and `reply.sent`
    // records that. Continuing past it would resolve an actor for a caller
    // that has already been refused — and would create an `app_user` row for
    // a token that did not validate.
    if (reply.sent) return;
    req.actor = await deps.resolveActor(req.principal!);
  });

  // AFTER the hook above and BEFORE any route, and both halves matter.
  //
  // Fastify runs `preHandler` hooks in registration order, so the role gate
  // must be added after the hook that sets `req.actor` — the value it reads.
  // Its `onRoute` hook, meanwhile, only fires for routes registered after it,
  // so it must be added before every `app.get`/`app.post` below or a route
  // would escape the registration-time check entirely. Move this call below
  // the routes and `authz.route.test.ts`'s "finds a realistic number of
  // routes" assertion fails, rather than the coverage check passing over an
  // empty list.
  registerRoleGate(app);

  app.get('/healthz', async () => ({ ok: true }));
  registerInfer(app, deps.gateway, deps.workspaceId);
  registerInferStream(app, deps.gateway, deps.workspaceId);
  registerMe(app, deps.db);
  registerUsers(app, deps.db);
  registerMatters(app, deps.db, deps.blobs);
  registerDocuments(app, deps.db, deps.blobs);
  registerCollections(app, deps.db);
  registerPrecedents(app, deps.db, deps.blobs);
  registerPositionBasis(app, deps.db);
  registerPlaybooks(app, deps.db);
  registerChangesets(app, deps.db);
  registerReviews(app, deps.db);
  registerFindings(app, deps.db);
  registerHistory(app, deps.db);
  registerActivity(app, deps.db);
  registerAssignments(app, deps.db, { inboxLimit: deps.assignmentInboxLimit });
  registerRuns(app, deps.db, { eventPageMax: deps.eventPageMax });
  registerWorkspaceSettings(app, deps.db, deps.gateway);

  /*
   * §8'S SOCKET — the route, then the upgrade.
   *
   * THE ROUTE exists so the socket's path is a route Fastify knows about:
   * `ROUTE_POLICY` covers it, `registerRoleGate` refuses a reviewer-less
   * caller at it, `authz.route.test.ts` sees it in both directions and
   * `oidc.test.ts`'s sweep proves it answers 401 with no token. A socket
   * registered outside the router would be silently absent from all three.
   * It answers 426 to anything that is not an upgrade, which is what a
   * browser hitting `/api/v1/ws` in an address bar deserves to be told.
   *
   * THE UPGRADE is handled on the underlying server's own `upgrade` event
   * (`realtime/socket.ts`), which Fastify's router never sees — and that is
   * deliberate: the token is verified and the actor resolved BEFORE
   * `handleUpgrade` is called, so an unauthenticated socket never comes into
   * being at all (S29).
   */
  //
  // THE PATH IS A STRING LITERAL HERE, NOT `WS_PATH`, AND THAT IS LOAD-BEARING.
  //
  // `oidc.test.ts`'s route-discovery scanner matches
  // `app.get(  '<url>'` — a QUOTED LITERAL — because that is what every
  // other route in this file is. Registered as `app.get(WS_PATH, …)` the
  // socket route was invisible to it: `authz.route.test.ts` still saw it
  // (that reads Fastify's own table) but the no-token 401 sweep did not, and
  // it passed at its pinned count of 65 with a new route it had never
  // touched. That is the shape of a test that cannot fail, on the one route
  // whose whole design claim is that it is authenticated.
  //
  // Found by running the suite and not believing the green. The constant is
  // still the one source of truth — `socketRoute.test.ts` asserts this
  // literal equals `WS_PATH`, so the two cannot drift.
  app.get('/v1/ws', async (_req, reply) => reply.code(426).send({
    error: {
      code: 'unknown',
      message: 'This is LexPrompt\'s live-updates socket. It answers a WebSocket upgrade '
        + `carrying the ${WS_SUBPROTOCOL} subprotocol and a bearer token, not an ordinary GET.`,
    },
  }));

  const hub = createHub();
  app.decorate('lexpromptHub', hub);
  /*
   * PRESENCE PUBLISHES THROUGH THE HUB, and holds no transport of its own.
   *
   * The three-file separation §8 asks for stays three files: the hub knows
   * connections, the socket knows frames, the feed knows the outbox. The
   * registry knows a roster and hands a finished frame to the hub, which is
   * why it can be driven by a test with no socket in the process at all.
   */
  const presence = createPresenceRegistry({
    ttlMs: deps.socket.presenceTtlMs,
    publish: (scope, frame) => { hub.publish(scope.workspaceId, scope.sub, frame); },
  });
  app.decorate('lexpromptPresence', presence);
  const stopSocket = attachSocket(app.server, {
    verify: deps.verify,
    resolveActor: deps.resolveActor,
    db: deps.db,
    hub,
    presence,
    instanceId: deps.instanceId,
    caps: deps.socket,
  });
  // `app.close()` must take the socket down with it, or a test that closes
  // its server leaves a ping interval and a set of live connections behind —
  // and a suite whose processes do not exit is a suite people stop running.
  app.addHook('onClose', async () => { await stopSocket(); });

  return app;
}
