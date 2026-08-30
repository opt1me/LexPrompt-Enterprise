import { describe, it, expect } from 'vitest';
import { ModelError, isSignInError } from '@lexprompt/core';
import { workerModelClient } from '../src/run/modelClient.ts';
import type { GatewayClient } from '../src/gatewayClient.ts';
import type { Actor } from '../src/auth/actor.ts';

/**
 * The engine's route to a model (Stage 3 Task 3).
 *
 * Two things are actually at stake here and neither is "does it return the
 * string". The first is ATTRIBUTION: the gateway's call log is the record
 * that answers §12 Q5, and a run logged against a service identity — or
 * against whatever the caller happened to put in the body — makes every
 * server-side review anonymous in the one place that exists to say
 * otherwise. The second is that this client and the browser's must reach the
 * SAME verdict on the same envelope, because a review that produces a
 * different finding depending on where it ran is the worst output this
 * codebase can emit.
 */
const actor: Actor = {
  id: 'u-1',
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'kc-sub-1',
  displayName: 'Ada Lovelace',
  initials: 'AL',
  role: 'reviewer',
  workspaceId: 'ws-1',
};

function fakeGateway(reply: { status: number; json: unknown }): {
  client: GatewayClient; bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    infer: async (body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      return reply;
    },
    models: async () => ({ status: 200, json: {} }),
    stream: () => { throw new Error('not used'); },
  } as unknown as GatewayClient;
  return { client, bodies };
}

const request = {
  modelChoiceId: 'm',
  purpose: 'review.clause' as const,
  system: 's',
  user: 'u',
};

describe('workerModelClient', () => {
  it('stamps the actor who asked for the run, and lets no request body override it', async () => {
    const { client, bodies } = fakeGateway({ status: 200, json: { content: '{"a":1}' } });
    // A hostile (or merely stale) request naming someone else. `withActor`
    // spreads the client body FIRST; if that order ever inverted, this call
    // would be logged against `mallory` and nothing would say so.
    const spoofed = {
      ...request,
      workspaceId: 'ws-other',
      actorSubject: 'mallory',
      actorUserId: 'u-999',
      actorIssuer: 'https://evil.example',
    };
    await workerModelClient(client, 'ws-1', actor).chatJson(spoofed as never);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].workspaceId).toBe('ws-1');
    expect(bodies[0].actorIssuer).toBe('https://issuer.example/realms/lexprompt');
    expect(bodies[0].actorSubject).toBe('kc-sub-1');
    expect(bodies[0].actorUserId).toBe('u-1');
    // …and the request's own fields still travel.
    expect(bodies[0].purpose).toBe('review.clause');
    expect(bodies[0].user).toBe('u');
  });

  it('parses a wrapped JSON answer the way the browser does', async () => {
    // `parseJsonLoose`, shared from core. A server-side review that could not
    // read a response the browser can would give a different finding for the
    // same document.
    const { client } = fakeGateway({
      status: 200,
      json: { content: 'Sure! Here you go:\n```json\n{"summary":"ok","citations":[]}\n```' },
    });
    const out = await workerModelClient(client, 'ws-1', actor)
      .chatJson<{ summary: string }>(request as never);
    expect(out.summary).toBe('ok');
  });

  it('turns a refusal into the ModelError the gateway meant, code and all', async () => {
    const { client } = fakeGateway({
      status: 401,
      json: { error: { code: 'sign_in_required', message: 'Token expired', callId: 'c-9' } },
    });
    const err = await workerModelClient(client, 'ws-1', actor)
      .chatJson(request as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).message).toBe('Token expired');
    expect((err as ModelError).status).toBe(401);
    // The classifier the extractors read to set `Finding.authError` must
    // recognise it — that is the whole reason the code matters.
    expect(isSignInError(err)).toBe(true);
  });

  it('refuses a 200 with no answer in it, rather than passing undefined on', async () => {
    // An ingress error page served as 200, or an intermediary's
    // interstitial. `inferResponseFrom` is shared with the browser precisely
    // so both sides refuse the same bodies.
    const { client } = fakeGateway({ status: 200, json: { notContent: 'x' } });
    const err = await workerModelClient(client, 'ws-1', actor)
      .chatJson(request as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).message).toMatch(/without an answer in it/);
  });

  it('throws for the two methods it does not implement, rather than half-working', async () => {
    const { client } = fakeGateway({ status: 200, json: { content: '{}' } });
    const engine = workerModelClient(client, 'ws-1', actor);
    // Not "returns an empty list": that would report "no model is
    // configured" to a caller that had no business asking.
    expect(() => engine.listModels()).toThrow(/does not list models/);
    expect(() => engine.chatStream(request as never, () => {})).toThrow(/do not stream/);
  });

  it('makes no outbound call of its own — every call leaves through the gateway (§5)', async () => {
    // The claim S1 rests on, checked against the source rather than assumed:
    // this module holds no fetch, no undici request, and no URL.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const code = readFileSync(resolve(__dirname, '../src/run/modelClient.ts'), 'utf8');
    expect(code).not.toMatch(/\bfetch\(|from 'undici'|https?:\/\/(?!issuer|evil)/);
    expect(code).toMatch(/gateway\.infer\(/);
  });
});
