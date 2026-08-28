import { ModelError, type ModelErrorCode } from '@lexprompt/core';
import { buildServer } from '../../src/server.ts';
import type { Principal } from '../../src/oidc.ts';
import type { GatewayClient } from '../../src/gatewayClient.ts';

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
}

export interface CallLog {
  infer: Array<Record<string, unknown>>;
}

/**
 * Builds a real `buildServer()` instance — the actual `requireUser` hook and
 * the actual `registerInfer` route wiring, not a reimplementation of either
 * — over a fake `TokenVerifier` and a fake `GatewayClient` that only records
 * what it was called with. This is what lets the "OVERWRITES a
 * client-supplied actor" test prove something about `apps/api`'s real
 * routing rather than about a test double standing in for it.
 */
export function buildTestApi(opts: TestApiOptions): { app: ReturnType<typeof buildServer>; calls: CallLog } {
  const calls: CallLog = { infer: [] };

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
    async stream() {
      throw new Error('buildTestApi does not fake the stream route');
    },
  } as GatewayClient;

  const app = buildServer({ verify, gateway, workspaceId: WORKSPACE_ID });

  return { app, calls };
}
