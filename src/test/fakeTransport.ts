import { ModelError } from '@lexprompt/core';

/**
 * A stand-in for `src/lib/api/client` — the ONE HTTP transport every
 * repository in `src/lib/db/` calls — backed by a map from path to value.
 *
 * ## What this is for, and what it deliberately is NOT
 *
 * Several suites in this project are end-to-end over STORAGE: they publish a
 * version, save a review against it, delete the playbook, then assert what
 * the real repository modules and the real components make of the result.
 * Their value was never the storage engine; it was that the real
 * `getReview`, the real `migrateReviewRecord` and the real component were
 * wired to each other, rather than each being separately green against its
 * own fixture.
 *
 * Stage 2 moved that storage to Postgres, which jsdom cannot reach. So the
 * NETWORK is replaced here and nothing else is: the repository modules, the
 * repair-on-read migrations and the components all still run for real.
 *
 * **This is not a fake server and must not grow into one.** It answers with
 * whatever a test put in it. It enforces no workspace scope, refuses no
 * stale write, and knows nothing about cascades — every one of those is
 * proved against a REAL Postgres in `apps/api/test/*.pg.test.ts`, and §14's
 * "a fake Postgres is not acceptable" is exactly the rule that would be
 * broken by teaching this thing rules. If a test needs server BEHAVIOUR it
 * belongs in a `.pg.test.ts` file; if it needs a server's ANSWER, it belongs
 * here.
 */
export interface FakeTransport {
  /** Path -> what a GET of it resolves to. A path with no entry is a 404:
   *  `apiGetOrNull` answers `null` and `apiGet` rejects, exactly as the real
   *  client does. */
  responses: Map<string, unknown>;
  /** Path -> an error every call for it throws, whatever `responses` holds.
   *  For the "a failure is a failure, never an empty result" cases. */
  failures: Map<string, ModelError>;
  /** Every write, in order, so a test can assert what was sent. */
  sent: { method: string; path: string; body: unknown }[];
  /** Every DELETE path, in order. */
  deleted: string[];
  /**
   * When true, a write to a path with no registered response STORES its body
   * under that path and returns it.
   *
   * A tiny key-value store, and deliberately nothing more. It is a WEAKER
   * claim than the server makes — the real routes set `updated_at`, bump
   * `version`, refuse a stale write and scope every statement to a
   * workspace, and none of that is here. Use it only where a test needs a
   * record to survive a save and be read back; anything asserting what the
   * SERVER does with a write belongs in a `.pg.test.ts` file.
   */
  echoWrites: boolean;
  /**
   * Consulted when `responses` has no entry for a GET path.
   *
   * For the routes that answer 200 with an EMPTY LIST rather than 404 — a
   * playbook with no versions, a matter with no documents. Registering every
   * such path by hand is impossible when the ids are minted per test, and
   * defaulting them to 404 would make this stand-in disagree with the real
   * route in the one direction that matters: a caller would see a rejection
   * where the server sends `[]`.
   *
   * Returns `undefined` to mean "no default", which is then the 404 an
   * unregistered path always was.
   */
  fallback?: (path: string) => unknown;
  reset(): void;
}

export function makeFakeTransport(): FakeTransport {
  const t: FakeTransport = {
    responses: new Map<string, unknown>(),
    failures: new Map<string, ModelError>(),
    sent: [],
    deleted: [],
    echoWrites: false,
    reset() {
      t.echoWrites = false;
      t.fallback = undefined;
      t.responses.clear();
      t.failures.clear();
      t.sent.length = 0;
      t.deleted.length = 0;
    },
  };
  return t;
}

const notFound = (path: string): ModelError =>
  new ModelError(`Nothing at ${path}.`, 'not_found', 404);

/**
 * The module factory to hand `vi.mock('.../lib/api/client', …)`.
 *
 * Every export the repositories use is provided, so a repository that starts
 * calling a different one fails loudly here rather than reaching a real
 * `fetch` in jsdom.
 */
export function transportModule(t: FakeTransport): Record<string, unknown> {
  const check = (path: string): void => {
    const failure = t.failures.get(path);
    if (failure) throw failure;
  };
  return {
    apiGet: async (path: string) => {
      check(path);
      if (t.responses.has(path)) return t.responses.get(path);
      const fallback = t.fallback?.(path);
      if (fallback !== undefined) return fallback;
      throw notFound(path);
    },
    apiGetOrNull: async (path: string) => {
      check(path);
      if (t.responses.has(path)) return t.responses.get(path);
      return t.fallback?.(path) ?? null;
    },
    apiSend: async (method: string, path: string, body: unknown) => {
      // RECORDED BEFORE the failure check, because the real client sends the
      // request and then turns the response into a `ModelError` — a refused
      // write is a write that was attempted, and a test asking "what did the
      // second attempt send?" needs to see it.
      t.sent.push({ method, path, body });
      check(path);
      // In echo mode the LAST write wins, so a record saved twice reads back
      // as it was saved the second time. Off by default: a suite that
      // registers responses is stating what the server answers, and a write
      // must not silently replace that.
      if (t.echoWrites) t.responses.set(path, body);
      if (!t.responses.has(path)) throw notFound(path);
      return t.responses.get(path);
    },
    apiSendBlob: async (path: string, form: unknown) => {
      // RECORDED BEFORE the failure check, for the reason `apiSend` above
      // gives: the real client sends the request and then turns the response
      // into a `ModelError`, so a refused upload is an upload that was
      // ATTEMPTED. Recorded after, a test asking "what did the refused
      // upload send?" saw nothing — two siblings, one rule, previously
      // applied to one of them.
      t.sent.push({ method: 'POST', path, body: form });
      check(path);
      return t.responses.get(path) ?? undefined;
    },
    apiGetBlob: async (path: string) => {
      check(path);
      return t.responses.has(path) ? t.responses.get(path) : null;
    },
    apiDelete: async (path: string) => {
      check(path);
      t.deleted.push(path);
      if (!t.responses.has(path)) throw notFound(path);
      t.responses.delete(path);
    },
  };
}

/**
 * A module-level instance, for the suites whose `vi.mock` factory runs
 * BEFORE their own top-level statements.
 *
 * `vi.mock` is hoisted above every import, and its factory runs the first
 * time the mocked module is loaded — which, in a file that statically
 * imports a component that reaches the API client, is before any `const` in
 * the test file has been initialised. A factory closing over a locally
 * constructed transport is then a `Cannot access … before initialization`
 * that names neither the cause nor the fix.
 *
 * So the instance lives HERE, created when this module is evaluated, and
 * both the factory and the test body reach it by import. Each test FILE gets
 * its own module registry, so this is one transport per file rather than one
 * shared across a run.
 *
 *     vi.mock('../../lib/api/client',
 *       async () => (await import('../../test/fakeTransport')).sharedTransportModule());
 *     import { sharedTransport } from '../../test/fakeTransport';
 */
export const sharedTransport: FakeTransport = makeFakeTransport();

export function sharedTransportModule(): Record<string, unknown> {
  return transportModule(sharedTransport);
}
