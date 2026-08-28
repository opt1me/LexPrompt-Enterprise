import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import type { ApiConfig } from './config.ts';

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

export function makeGatewayClient(config: ApiConfig, getGatewayToken?: () => Promise<string>) {
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
