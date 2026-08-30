import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import { ConfigError, type ApiConfig } from './config.ts';

/**
 * The only client in this service that calls the GATEWAY. It is not the only
 * outbound client, and the paragraph that used to say so was wrong three
 * times over (M3).
 *
 * There are exactly THREE outbound clients in `apps/api`, and they are three
 * because identity cannot be reached through the gateway:
 *
 *   1. this module — every call to the gateway;
 *   2. `oidc.ts`'s `discoverJwks`, one `fetch` of the issuer's discovery
 *      document, at startup;
 *   3. jose's `createRemoteJWKSet`, which fetches the `jwks_uri` that
 *      document named, on its own schedule, for the life of the process —
 *      at a URL chosen by the ISSUER rather than by configuration.
 *
 * The claim S1 actually supports is narrower than "the API cannot egress",
 * and it is worth stating exactly because it is what a future reviewer will
 * lean on: `apps/api` has no route to a MODEL PROVIDER. In compose that is a
 * network fact — `api` sits on the `internal` network alone, which has no
 * default route, so all three clients above can reach only what is on that
 * network — and `egress.compose.test.ts` proves it by probing the container.
 * That test measures REACHABILITY, so it cannot tell one outbound client
 * from four and would pass unchanged if someone added a fifth; the count
 * above is held by `egressSurface.test.ts` instead, which is a source scan
 * and names each of the three.
 *
 * In Azure the network fact is weaker still: `apps/api` MUST reach
 * `login.microsoftonline.com`, so "no route to the public internet" is true
 * in compose and false in a tenant. `divergence.json` row 7 says the Azure
 * egress rules are Spike 2 and not done; this file used to contradict that
 * disclosure while sounding more certain than it.
 */
/**
 * What `registerInferStream` (Task 18) actually needs from a stream
 * response: a status, a content-type-bearing header bag, an async source of
 * raw byte chunks to copy verbatim, and a way to read the whole body when
 * the status says this was never a stream. Named explicitly rather than
 * inferred from undici's `Dispatcher.ResponseData['body']`, which carries
 * dozens of unrelated methods (`.json()`, `.formData()`, …) that a route
 * whose entire job is "parse nothing" must never be tempted to reach for —
 * and which a test fake would otherwise have to reimplement in full just to
 * satisfy the type checker.
 */
export interface StreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  text: () => Promise<string>;
}

/**
 * The API must be able to prove who it is to the gateway, or it must not start.
 *
 * `GATEWAY_CALLER_AUTH` has exactly two values and neither of them turns the
 * gateway's caller check off (S29's shape, applied to the gateway's own front
 * door): `mtls` wants a client certificate, `entra` wants a bearer token. This
 * client can present a certificate — `config.mtls` — and it can present a token
 * — `getGatewayToken`. With NEITHER, there is no gateway configuration in which
 * a single call from this process could succeed.
 *
 * That is exactly the state `main.ts` shipped in: it called
 * `makeGatewayClient(config)` with no token callback, so under
 * `GATEWAY_CALLER_AUTH=entra` — the Azure configuration — the API would have
 * started cleanly, reported itself healthy, and had every single request
 * refused by the gateway. A firm would meet that as "the model never answers",
 * on a deployment whose logs say nothing is wrong.
 *
 * Acquiring a managed-identity token is Stage 2's work: it needs
 * `@azure/identity` in this service, an audience to request the token FOR
 * (the gateway's own App Registration, which is not yet a value this service
 * is given), and a real tenant to be tested against — none of which exists
 * here, and shipping unverifiable authentication code would be the worse of
 * the two mistakes. So the gap is made LOUD instead: the process refuses to
 * start, naming the missing piece, rather than running and failing every
 * request for a reason nothing on the deployment explains.
 *
 * When Stage 2 supplies `getGatewayToken`, this check passes on that branch
 * with nothing else to change. It is written as "some credential exists",
 * never as "mTLS is configured", so wiring the token is the only edit.
 */
export function assertCanAuthenticateToGateway(
  config: ApiConfig,
  getGatewayToken?: () => Promise<string>,
): void {
  if (config.mtls || getGatewayToken) return;
  throw new ConfigError(
    'This API has no way to authenticate to the gateway at '
    + `${config.gatewayUrl}, so it will not start.\n`
    + 'The gateway has two caller-auth modes and neither can be turned off: '
    + 'GATEWAY_CALLER_AUTH=mtls requires a client certificate, and '
    + 'GATEWAY_CALLER_AUTH=entra requires a bearer token. This process can '
    + 'present a certificate (set API_MTLS_CA_FILE, API_MTLS_CERT_FILE and '
    + 'API_MTLS_KEY_FILE), and it cannot yet acquire a managed-identity token '
    + '— that wiring is Stage 2 work and is not implemented.\n'
    + 'Starting anyway would mean a healthy-looking service whose every '
    + 'request the gateway refuses, which is a worse failure than this one.',
  );
}

/**
 * The gateway ANSWERED, and its reply was not JSON.
 *
 * A distinct type because "could not reach it" and "reached it and could not
 * read the reply" are different diagnoses and an administrator acts on them
 * differently (m7). Without this, both arrived at the route as a bare
 * `Error` and both were reported as "could not reach", which is a confident
 * wrong answer about the one thing the operator would go and look at.
 */
export class GatewayUnreadableError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GatewayUnreadableError';
    this.status = status;
  }
}

async function readJson(status: number, read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (err) {
    throw new GatewayUnreadableError(status, (err as Error).message);
  }
}

/**
 * How long a call to the gateway may wait for response headers.
 *
 * This is undici's own default, written down rather than changed: the point
 * of naming it is that "this client sets no timeout" was a fair reading of
 * the code and is not a fair description of the behaviour. A hung gateway
 * fails this hop loudly after five minutes; it does not hold a request open
 * forever. The BODY timeout is left at undici's default too, and must stay
 * generous — `stream` holds an SSE body open for the length of an answer.
 */
const GATEWAY_HEADERS_TIMEOUT_MS = 300_000;

export function makeGatewayClient(config: ApiConfig, getGatewayToken?: () => Promise<string>) {
  assertCanAuthenticateToGateway(config, getGatewayToken);

  const dispatcher = config.mtls
    ? new Agent({ connect: {
        ca: readFileSync(config.mtls.caFile),
        cert: readFileSync(config.mtls.certFile),
        key: readFileSync(config.mtls.keyFile),
      } })
    : undefined;

  const headers = async (): Promise<Record<string, string>> => ({
    'Content-Type': 'application/json',
    ...(getGatewayToken ? { Authorization: `Bearer ${await getGatewayToken()}` } : {}),
  });

  return {
    async infer(body: unknown, signal?: AbortSignal) {
      const res = await request(`${config.gatewayUrl}/v1/infer`, {
        method: 'POST', dispatcher, headers: await headers(), body: JSON.stringify(body),
        headersTimeout: GATEWAY_HEADERS_TIMEOUT_MS,
        // OPTIONAL, and added by Stage 3 Task 10/11 rather than left off.
        //
        // `stream` has taken one since Stage 1; `infer` did not, and
        // `workerModelClient` says at length that it therefore ACCEPTS a
        // signal and does not forward it. That was an honest limitation
        // while the only caller was a proxy hop. It stops being one the
        // moment a server-side run declares a per-cell timeout and a person
        // can press Cancel: an unforwarded signal makes
        // `API_RUN_CELL_TIMEOUT_MS` a cap that bounds nothing and makes
        // Cancel a button that stops the queue while the calls already in
        // flight run to completion and are billed.
        //
        // undici rejects an aborted request with an error whose `name` is
        // `AbortError`, which is exactly what both extractors already test
        // for — so an aborted cell resolves to a `cancelled` finding rather
        // than to a red card with a raw DOMException on it.
        ...(signal ? { signal } : {}),
      });
      return { status: res.statusCode, json: await readJson(res.statusCode, () => res.body.json()) };
    },
    async models() {
      const res = await request(`${config.gatewayUrl}/v1/models`, {
        method: 'GET', dispatcher, headers: await headers(),
        headersTimeout: GATEWAY_HEADERS_TIMEOUT_MS,
      });
      return { status: res.statusCode, json: await readJson(res.statusCode, () => res.body.json()) };
    },
    async stream(body: unknown, signal: AbortSignal): Promise<StreamResponse> {
      const res = await request(`${config.gatewayUrl}/v1/infer/stream`, {
        method: 'POST', dispatcher, headers: await headers(),
        body: JSON.stringify(body), signal,
        headersTimeout: GATEWAY_HEADERS_TIMEOUT_MS,
      });
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
        body: res.body,
        text: () => res.body.text(),
      };
    },
  };
}
export interface GatewayClient {
  /** `signal` is OPTIONAL so the Stage 1 proxy hop, which has no signal to
   *  give, is unchanged — and is honoured when it is supplied, so a
   *  server-side run's cell timeout and a reader's Cancel both reach the
   *  socket rather than stopping at this boundary. */
  infer(body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown }>;
  models(): Promise<{ status: number; json: unknown }>;
  stream(body: unknown, signal: AbortSignal): Promise<StreamResponse>;
}
