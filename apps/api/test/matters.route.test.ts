import { describe, it, expect } from 'vitest';
import { buildTestApi, WORKSPACE_ID } from './helpers/apiHarness.ts';

/**
 * What the matters routes do that a database cannot answer for them: which
 * workspace they scope to, what they refuse before writing anything, and
 * what shape a refusal has.
 *
 * The fake `Db` in `apiHarness` answers every statement with NO ROWS, which
 * is deliberate here: it is the "nothing matched" branch of every handler,
 * so a route that mistook it for success would fail loudly rather than
 * silently. The rows themselves are `matters.pg.test.ts`'s job.
 */

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-1',
  groups: ['reviewers'],
};

const BODY = { id: 'm1', name: 'Brookvale', ownerId: '', createdAt: 1, updatedAt: 1 };

function api(opts: Parameters<typeof buildTestApi>[0] = { principal: PRINCIPAL }) {
  return buildTestApi(opts);
}

const send = (
  app: ReturnType<typeof buildTestApi>['app'],
  method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown,
) => app.inject({ method, url, headers: { authorization: 'Bearer t' }, payload: payload as never });

describe('the matters routes scope every statement to the actor s workspace', () => {
  it('lists with the workspace from the token, never one from the request', async () => {
    const { app, calls } = api();
    // A caller doing its level best to be read as another workspace.
    const res = await send(app, 'GET', `/v1/matters?workspaceId=${encodeURIComponent('somebody-else')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(calls.dbQueries).toHaveLength(1);
    expect(calls.dbQueries[0].text).toMatch(/workspace_id\s*=\s*\$1/);
    expect(calls.dbQueries[0].values).toEqual([WORKSPACE_ID]);
    await app.close();
  });

  it('reads one by id with the workspace as a second predicate', async () => {
    const { app, calls } = api();
    const res = await send(app, 'GET', '/v1/matters/m1');
    // No row came back, and that is a 404 — never a 200 carrying null,
    // which `getMatter` would have had to guess at.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(calls.dbQueries[0].values).toEqual(['m1', WORKSPACE_ID]);
    await app.close();
  });

  it('writes with the workspace from the token even when the body names another', async () => {
    const { app, calls } = api();
    await send(app, 'PUT', '/v1/matters/m1', { ...BODY, workspaceId: 'somebody-else' });
    const write = calls.dbQueries[0];
    expect(write.text).toMatch(/insert into matter/);
    expect(write.values?.[1]).toBe(WORKSPACE_ID);
    expect(write.values).not.toContain('somebody-else');
    await app.close();
  });

  it('never sends a body-supplied ownerId to the database', async () => {
    const { app, calls } = api();
    await send(app, 'PUT', '/v1/matters/m1', { ...BODY, ownerId: 'somebody-elses-user-id' });
    const write = calls.dbQueries[0];
    // The authenticated actor's id, which `apiHarness` sets to 'actor-1'.
    expect(write.values?.[5]).toBe('actor-1');
    expect(write.values).not.toContain('somebody-elses-user-id');
    // …and the UPDATE half does not touch owner_id at all, so a second
    // person saving a matter cannot become the person who created it.
    expect(write.text).not.toMatch(/owner_id\s*=\s*excluded/);
    await app.close();
  });

  it('deletes with the workspace as a predicate, and 404s when nothing matched', async () => {
    const { app, calls } = api();
    const res = await send(app, 'DELETE', '/v1/matters/m1');
    expect(res.statusCode).toBe(404);
    // TWO statements now, and their ORDER is the assertion. Task 11 gave the
    // cascade its blob half, and the keys have to be read BEFORE the rows go
    // — after the cascade there is nothing left to derive them from. Both
    // are workspace-scoped; a blob-key read that was not would list another
    // firm's document keys and then delete them.
    expect(calls.dbQueries[0].text).toMatch(/select blob_key from document/);
    expect(calls.dbQueries[0].values).toEqual(['m1', WORKSPACE_ID]);
    expect(calls.dbQueries[1].text).toMatch(/delete from matter/);
    expect(calls.dbQueries[1].values).toEqual(['m1', WORKSPACE_ID]);
    await app.close();
  });

  it('deletes no bytes when the matter was not this workspace s to delete', async () => {
    // The 404 above must reach the blob store with NOTHING. A cascade that
    // ran its deletes before checking whether the row was even here would
    // destroy bytes on a request it then refused.
    const { app, blobs } = api();
    blobs.raw.set('workspace/ws-configured/document/d1', { bytes: Buffer.from([1]), mime: 'application/pdf' });
    expect((await send(app, 'DELETE', '/v1/matters/m1')).statusCode).toBe(404);
    expect(blobs.deleteCalls).toEqual([]);
    expect(blobs.keys()).toEqual(['workspace/ws-configured/document/d1']);
    await app.close();
  });
});

describe('a refusal is loud, specific, and never a partial write', () => {
  it('answers a write that matched no row with 409 conflict, not 200', async () => {
    const { app } = api();
    const res = await send(app, 'PUT', '/v1/matters/m1', { ...BODY, version: 7 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
    await app.close();
  });

  it('omits `current` entirely when this workspace may not see the row', async () => {
    const { app } = api();
    const res = await send(app, 'PUT', '/v1/matters/m1', { ...BODY, version: 7 });
    // ABSENT, not `current: null`. "Someone changed it, here it is" and
    // "that id is taken and by what is not yours to know" are different
    // facts and must not arrive in one shape.
    expect('current' in res.json()).toBe(false);
    await app.close();
  });

  it('refuses a body with no name BEFORE issuing any statement', async () => {
    const { app, calls } = api();
    const res = await send(app, 'PUT', '/v1/matters/m1', { id: 'm1', ownerId: '', createdAt: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/name/);
    // The assertion that matters: nothing was attempted. A 400 issued after
    // a write is a 400 over a row that already changed.
    expect(calls.dbQueries).toEqual([]);
    await app.close();
  });

  it('refuses a body whose id disagrees with the URL rather than picking one', async () => {
    const { app, calls } = api();
    const res = await send(app, 'PUT', '/v1/matters/m1', { ...BODY, id: 'm2' });
    expect(res.statusCode).toBe(400);
    expect(calls.dbQueries).toEqual([]);
    await app.close();
  });

  it('refuses a non-integer version rather than sending it to the database', async () => {
    const { app, calls } = api();
    const res = await send(app, 'PUT', '/v1/matters/m1', { ...BODY, version: 1.5 });
    expect(res.statusCode).toBe(400);
    expect(calls.dbQueries).toEqual([]);
    await app.close();
  });
});

describe('the matters routes are behind the same gate as everything else', () => {
  it('refuses an unauthenticated caller on every one of them', async () => {
    const { app, calls } = api({ principal: null });
    for (const [method, url] of [
      ['GET', '/v1/matters'], ['GET', '/v1/matters/m1'],
      ['PUT', '/v1/matters/m1'], ['DELETE', '/v1/matters/m1'],
    ] as const) {
      const res = await app.inject({ method, url, payload: BODY as never });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('sign_in_required');
    }
    // …and nothing reached the database on the way to being refused.
    expect(calls.dbQueries).toEqual([]);
    await app.close();
  });
});
