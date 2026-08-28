import type { FastifyInstance } from 'fastify';
import type { Allowlist } from '../allowlist.ts';

/** The allowlist's single home on the wire. `apps/api` proxies this rather
 *  than holding a copy (S14). What it returns is `toAllowedModel`'s explicit
 *  field list — never the entry, so the endpoint and the credential it
 *  carries cannot reach a browser by being forgotten about. */
export function registerModels(app: FastifyInstance, allowlist: Allowlist): void {
  app.get('/v1/models', async () => ({ models: allowlist.list() }));
}
