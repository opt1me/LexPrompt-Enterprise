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
    async stream(body: unknown, signal: AbortSignal) {
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
export type GatewayClient = ReturnType<typeof makeGatewayClient>;
