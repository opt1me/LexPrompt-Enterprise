import type { FastifyInstance } from 'fastify';
import { ModelError, type ModelErrorCode } from '@lexprompt/core';
import { buildServer } from '../../src/server.ts';
import { DEFAULT_MAX_BODY_BYTES, WS_CAP_DEFAULTS } from '../../src/config.ts';
import type { Principal } from '../../src/oidc.ts';
import type { GatewayClient } from '../../src/gatewayClient.ts';
import type { Db, Tx } from '../../src/db/pool.ts';
import type { Actor } from '../../src/auth/actor.ts';
import { memoryBlobStore, type MemoryBlobStore } from './memoryBlobs.ts';

/** The workspace `buildTestApi` wires in, standing in for `API_WORKSPACE_ID`
 *  (§6: Stage 1 has exactly one, configured, never resolved per-request). A
 *  body-supplied `workspaceId` must never survive to reach this value. */
export const WORKSPACE_ID = 'ws-configured';

export interface PrincipalError {
  code: ModelErrorCode;
  status: number;
  message: string;
}

export interface GatewayResponse {
  status: number;
  json: unknown;
}

export interface TestApiOptions {
  /** The `Principal` a valid bearer token resolves to. `null` with no
   *  `principalError` reproduces "no token at all" (`requireUser` refuses
   *  before `verify` is ever called). */
  principal: Principal | null;
  /** Set to make `verify` reject with a `ModelError` — e.g. group overage —
   *  even though a bearer token was sent. */
  principalError?: PrincipalError;
  inferResponse?: GatewayResponse;
  modelsResponse?: GatewayResponse;
  /** Makes the fake gateway's `infer` reject, as an unreachable gateway
   *  would (ECONNREFUSED, DNS failure, …). */
  inferThrows?: Error;
  /** Raw bytes the fake gateway's `stream` yields, one chunk per array
   *  entry, exactly as given — no re-joining, no re-splitting. Tests use
   *  this to delivers a single SSE body whole, in uneven pieces, one byte
   *  at a time, or with a CRLF/truncated/no-trailing-blank-line shape, so
   *  `registerInferStream` has to prove it is a byte-transparent pipe
   *  rather than merely correct on a well-behaved delivery. */
  streamChunks?: string[];
  /** The fake gateway stream response's HTTP status. Defaults to 200. A
   *  non-200 carries no body chunks through the SSE path at all — the route
   *  reads `streamChunks` (joined) as the failure response's JSON body via
   *  `text()` instead. */
  streamStatus?: number;
  /** Overrides the body limit `buildServer` declares, so a test can prove the
   *  413 envelope without building a 16 MiB payload. */
  maxBodyBytes?: number;
  /** The content-type the fake gateway's stream response carries. Defaults
   *  to `text/event-stream`. A non-200 pre-stream failure may legitimately
   *  arrive as something else, and this hop must forward what it got rather
   *  than assert a label over a body it never read (m14). */
  streamContentType?: string;
  /** Makes the fake gateway's stream body THROW after this many chunks, as a
   *  mid-stream provider or transport failure does. The route must still end
   *  the response itself, so the browser reads the missing `done` frame as
   *  `stream_truncated` (m9). */
  streamThrowsAfter?: number;
  /** The `Actor` `resolveActor` resolves to when a `principal` is supplied.
   *  Defaults to a reviewer whose `issuer`/`subject` are taken from
   *  `principal` — never fixed — because that fidelity is the one property
   *  Task 3's `me.route.test.ts` exists to prove: the response's identity
   *  fields come from the validated token, never from a stub that merely
   *  agrees with it. */
  actor?: Omit<Actor, 'issuer' | 'subject'>;
  /** Makes the preHandler's `resolveActor` call reject with a `ModelError` —
   *  e.g. `account_disabled` — reproducing Task 2's admin-disable path
   *  without a database. */
  actorError?: PrincipalError;
  /**
   * A real `Db` for the routes to run against, replacing the recording fake.
   *
   * Supplied by the `*.pg.test.ts` suites, which bind it to the ONE pinned
   * client `withPg` rolls back — so a route test can exercise the real SQL
   * against the real database and still leave nothing behind. Route suites
   * that only care about which statement was issued leave this unset and
   * read `calls.dbQueries` instead; both are needed, and neither can answer
   * the other's question (Task 9's pattern for every repository route).
   */
  db?: Db;
  /**
   * The `BlobStore` the document routes and the matter cascade share.
   *
   * Defaults to a fresh in-memory one per server, so a suite that never
   * mentions blobs still gets a store that behaves — and so no two tests
   * can see each other's bytes. A test that cares what was written passes
   * its own and reads `keys()`.
   */
  blobs?: MemoryBlobStore;
  /** Overrides `API_EVENT_PAGE_MAX`, so a test can prove the cursor's
   *  `hasMore` without writing five hundred events. */
  eventPageMax?: number;
  /** Overrides `API_ASSIGNMENT_INBOX_LIMIT`, so a test can prove `capped`
   *  without seeding two hundred requests. */
  assignmentInboxLimit?: number;
  /** Overrides `API_SEARCH_LIMIT_PER_SOURCE`, so a test can prove a capped
   *  arm without seeding twenty matters. */
  searchLimitPerSource?: number;
  /** The instance id every socket's `hello` frame carries. Overridable so a
   *  test can stand two servers up and tell their sockets apart -- which is
   *  the cross-replica condition, in one process. */
  instanceId?: string;
  /** Overrides individual socket caps. A test proving the subscription
   *  ceiling must not have to open twenty of them, and one proving the
   *  heartbeat must not have to wait twenty-five seconds. */
  socketCaps?: Partial<{ pingMs: number; maxConnections: number; maxSubscriptions: number;
    maxFrameBytes: number; reauthMs: number }>;
}

export interface CallLog {
  infer: Array<Record<string, unknown>>;
  stream: Array<Record<string, unknown>>;
  /** Every statement sent to the fake `Db` behind `/v1/me`'s PUT handler —
   *  in particular, whether it was called AT ALL, which is how
   *  `me.route.test.ts` proves an empty display name is refused before any
   *  write is attempted. */
  dbQueries: Array<{ text: string; values?: unknown[] }>;
}

/**
 * Builds a real `buildServer()` instance — the actual `requireUser` hook and
 * the actual `registerInfer` route wiring, not a reimplementation of either
 * — over a fake `TokenVerifier` and a fake `GatewayClient` that only records
 * what it was called with. This is what lets the "OVERWRITES a
 * client-supplied actor" test prove something about `apps/api`'s real
 * routing rather than about a test double standing in for it.
 */
export function buildTestApi(
  opts: TestApiOptions,
): { app: ReturnType<typeof buildServer>; calls: CallLog; blobs: MemoryBlobStore } {
  const calls: CallLog = { infer: [], stream: [], dbQueries: [] };

  const tx: Tx = {
    async query<R>(text: string, values?: unknown[]): Promise<R[]> {
      calls.dbQueries.push({ text, values });
      return [] as R[];
    },
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      return run(tx);
    },
  };
  const db: Db = {
    query: tx.query,
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      return run(tx);
    },
  };

  const defaultActor: Omit<Actor, 'issuer' | 'subject'> = {
    id: 'actor-1', displayName: 'Test Reviewer', initials: 'TR',
    role: 'reviewer', workspaceId: WORKSPACE_ID,
  };
  const resolveActor = async (principal: Principal): Promise<Actor> => {
    if (opts.actorError) {
      throw new ModelError(opts.actorError.message, opts.actorError.code, opts.actorError.status);
    }
    const base = opts.actor ?? defaultActor;
    return { ...base, issuer: principal.issuer, subject: principal.subject };
  };

  const verify = async (_token: string): Promise<Principal> => {
    if (opts.principalError) {
      throw new ModelError(
        opts.principalError.message, opts.principalError.code, opts.principalError.status,
      );
    }
    if (!opts.principal) {
      // Reached only if a test sends a bearer token but still expects no
      // principal to resolve; `requireUser` itself refuses a missing token
      // before `verify` runs at all.
      throw new ModelError('Sign in to use LexPrompt.', 'sign_in_required', 401);
    }
    return opts.principal;
  };

  const gateway: GatewayClient = {
    async infer(body: unknown) {
      calls.infer.push(body as Record<string, unknown>);
      if (opts.inferThrows) throw opts.inferThrows;
      return opts.inferResponse ?? { status: 200, json: {} };
    },
    async models() {
      return opts.modelsResponse ?? { status: 200, json: { models: [] } };
    },
    async stream(body: unknown) {
      calls.stream.push(body as Record<string, unknown>);
      const chunks = opts.streamChunks ?? [];
      // A real async generator, not a pre-built array, so the route's
      // `for await` actually consumes it chunk by chunk — exactly the shape
      // undici hands back from `res.body`.
      async function* bytes(): AsyncGenerator<Buffer> {
        let sent = 0;
        for (const chunk of chunks) {
          if (opts.streamThrowsAfter !== undefined && sent >= opts.streamThrowsAfter) {
            throw new Error('gateway stream failed mid-body');
          }
          sent += 1;
          yield Buffer.from(chunk, 'utf8');
        }
        if (opts.streamThrowsAfter !== undefined && sent >= opts.streamThrowsAfter) {
          throw new Error('gateway stream failed mid-body');
        }
      }
      return {
        status: opts.streamStatus ?? 200,
        headers: {
          'content-type': opts.streamContentType ?? 'text/event-stream',
        } as Record<string, string>,
        body: bytes(),
        text: async () => chunks.join(''),
      };
    },
  } as GatewayClient;

  const blobs = opts.blobs ?? memoryBlobStore();
  const app = buildServer({
    verify, gateway, db: opts.db ?? db, resolveActor, blobs,
    workspaceId: WORKSPACE_ID,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    // The shipped default, so a route suite reads the same page size the
    // running service uses rather than a number the harness invented.
    eventPageMax: opts.eventPageMax ?? 500,
    // The SHIPPED default (config.ts), never a number this harness invented.
    assignmentInboxLimit: opts.assignmentInboxLimit ?? 200,
    searchLimitPerSource: opts.searchLimitPerSource ?? 20,
    // The SHIPPED defaults (config.ts's WS_CAP_DEFAULTS), never numbers this
    // harness invented: a suite exercising a ping interval no deployment
    // uses is the quiet half of an undeclared cap.
    socket: {
      ...WS_CAP_DEFAULTS, eventPageMax: opts.eventPageMax ?? 500, ...opts.socketCaps,
    },
    instanceId: opts.instanceId ?? 'api-test-instance',
  });

  return { app, calls, blobs };
}

/**
 * Every route the server ACTUALLY registered, read from Fastify's own
 * `onRoute` event rather than from a list somebody maintains.
 *
 * `registerRoleGate` records them (see its own comment); this is the reader.
 * Fastify 5 has no public `app.routes`, and `printRoutes()` returns a
 * formatted tree that is a poor thing to parse — but the reason this is not
 * a source-scanning regex is stronger than convenience: Stage 1 shipped
 * exactly such a regex, and a change to how ONE route was registered
 * silently removed it from the sweep that was supposed to cover it.
 *
 * Its own failure mode is finding nothing, which would pass every coverage
 * check vacuously, so `authz.route.test.ts` asserts a realistic count first.
 */
export function collectRoutes(app: FastifyInstance): { method: string; url: string }[] {
  return app.lexpromptRoutes;
}
