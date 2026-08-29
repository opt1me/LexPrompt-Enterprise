import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import { ConfigError, type ApiConfig } from './config.ts';

/**
 * The ONLY outbound client in this service (S1: `api` may not egress).
 *
 * Everything that leaves `apps/api` goes through here, which is what makes
 * "the API cannot reach a model" checkable by reading one file as well as
 * by reading the network policy. A second `fetch` anywhere in `apps/api` is
 * a defect, and Task 24's egress test is what catches it if review does not.
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
    async infer(body: unknown) {
      const res = await request(`${config.gatewayUrl}/v1/infer`, {
        method: 'POST', dispatcher, headers: await headers(), body: JSON.stringify(body),
      });
      return { status: res.statusCode, json: await res.body.json() };
    },
    async models() {
      const res = await request(`${config.gatewayUrl}/v1/models`, {
        method: 'GET', dispatcher, headers: await headers(),
      });
      return { status: res.statusCode, json: await res.body.json() };
    },
    async stream(body: unknown, signal: AbortSignal): Promise<StreamResponse> {
      const res = await request(`${config.gatewayUrl}/v1/infer/stream`, {
        method: 'POST', dispatcher, headers: await headers(),
        body: JSON.stringify(body), signal,
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
  infer(body: unknown): Promise<{ status: number; json: unknown }>;
  models(): Promise<{ status: number; json: unknown }>;
  stream(body: unknown, signal: AbortSignal): Promise<StreamResponse>;
}
