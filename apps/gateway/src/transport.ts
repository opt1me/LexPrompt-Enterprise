import { request as undiciRequest } from 'undici';
import type { Transport, TransportResponse } from './callModel.ts';

/**
 * The one real socket in this process, behind the one interface every other
 * module sees.
 *
 * It is a module of its own rather than a literal in `main.ts` because
 * `smoke.ts` needs the same one, and two hand-written `undici` wrappers is
 * precisely the sibling drift this project has paid for repeatedly — here it
 * would mean the live smoke run exercising a slightly different transport
 * from the one a deployment uses, which is the only thing that run is for.
 *
 * It contains no retry, no timeout and no logging. Those belong to
 * `callModel`, once, around every provider.
 */
export const undiciTransport: Transport = {
  async fetch(url, init): Promise<TransportResponse> {
    const res = await undiciRequest(url, {
      method: init.method as 'POST',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      json: () => res.body.json(),
      text: () => res.body.text(),
      body: res.body,
    };
  },
};
