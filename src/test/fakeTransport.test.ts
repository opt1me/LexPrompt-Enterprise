import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from './fakeTransport';

/**
 * The two write methods record what they SENT, on the same rule.
 *
 * Part 2A m11: `apiSend` recorded the request before the failure check, with
 * a good comment saying why — the real client sends the request and then
 * turns the response into a `ModelError`, so a refused write is a write that
 * was ATTEMPTED. `apiSendBlob` recorded it after, so a test asking "what did
 * the refused upload send?" saw nothing at all. Two siblings, one rule,
 * applied once.
 */
describe('fakeTransport records a refused write, whichever method sent it', () => {
  it('records the body of a refused apiSend', async () => {
    const t = makeFakeTransport();
    const client = transportModule(t) as {
      apiSend(method: string, path: string, body: unknown): Promise<unknown>;
    };
    t.failures.set('/v1/matters/m1', new ModelError('nope', 'conflict', 409));
    await expect(client.apiSend('PUT', '/v1/matters/m1', { name: 'Acme' })).rejects.toThrow('nope');
    expect(t.sent).toEqual([{ method: 'PUT', path: '/v1/matters/m1', body: { name: 'Acme' } }]);
  });

  it('records the body of a refused apiSendBlob', async () => {
    const t = makeFakeTransport();
    const client = transportModule(t) as {
      apiSendBlob(path: string, form: unknown): Promise<unknown>;
    };
    t.failures.set('/v1/documents', new ModelError('too big', 'unknown', 413));
    const form = { record: 'the record', bytes: 'the bytes' };
    await expect(client.apiSendBlob('/v1/documents', form)).rejects.toThrow('too big');
    expect(t.sent).toEqual([{ method: 'POST', path: '/v1/documents', body: form }]);
  });
});
