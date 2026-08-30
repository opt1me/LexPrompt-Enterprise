import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ModelError, type WorkspaceUsers } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';

/**
 * The browser's one resolver from a user id to a name.
 *
 * What is worth testing here is not "it makes a request". It is the two
 * things a resolver can get quietly wrong: answering for an id it does not
 * hold (which would put an invented name on a lawyer's judgement), and
 * turning a failed load into an empty directory (which would make every
 * actor on every card read as a stranger, with nothing saying the fetch
 * failed).
 */

const transport = makeFakeTransport();
vi.mock('./client', () => transportModule(transport));

const {
  loadDirectory, directoryLoaded, userName, userInitials, userIn, forgetDirectory,
} = await import('./users');

const DIRECTORY: WorkspaceUsers = {
  users: [
    { id: 'u1', displayName: 'A Trainee', initials: 'AT', role: 'reviewer', status: 'active' },
    {
      id: 'u2', displayName: 'R Okafor', initials: 'RO', role: 'partner', status: 'active',
      email: 'r.okafor@firm.test',
    },
    { id: 'u3', displayName: 'P Departed', initials: 'PD', role: 'reviewer', status: 'disabled' },
  ],
};

beforeEach(() => {
  transport.reset();
  forgetDirectory();
  transport.responses.set('/v1/workspace/users', DIRECTORY);
});

describe('the workspace directory', () => {
  it('resolves an id to a name and to initials', async () => {
    await loadDirectory();
    expect(userName('u2')).toBe('R Okafor');
    expect(userInitials('u2')).toBe('RO');
  });

  it('answers undefined for an id it does not hold, and NEVER the id itself', async () => {
    // R-GP5, one layer up: *"an entry whose author matches nothing known is
    // rendered with NO actor rather than an invented one"*. A raw uuid says
    // nothing to a reader while looking like it should.
    await loadDirectory();
    expect(userName('someone-else')).toBeUndefined();
    expect(userInitials('someone-else')).toBeUndefined();
    expect(userIn('someone-else')).toBeUndefined();
  });

  it('answers undefined for no id at all, rather than throwing', async () => {
    // A disposition nobody has touched carries no `byUserId` — an ABSENT
    // key, not a null — and a resolver that threw on it would take out the
    // card rather than the name.
    await loadDirectory();
    expect(userName(undefined)).toBeUndefined();
    expect(userInitials(undefined)).toBeUndefined();
  });

  it('keeps a disabled person in the directory, with their status', async () => {
    // Somebody who has left the firm still verified things last March.
    await loadDirectory();
    expect(userName('u3')).toBe('P Departed');
    expect(userIn('u3')?.status).toBe('disabled');
  });

  it('carries an email that is there, and no key at all for one that is not', async () => {
    await loadDirectory();
    expect(userIn('u2')?.email).toBe('r.okafor@firm.test');
    // `in`, not `toEqual`: `toEqual` cannot tell an absent key from an
    // undefined one, and `structuredClone` preserves the second.
    expect('email' in userIn('u1')!).toBe(false);
  });

  it('loads ONCE, however many names are resolved', async () => {
    // A directory refreshed per card is a request per row, and the loop that
    // produces it is deleted by whoever profiles it next — taking the
    // sentence it fed with it.
    let calls = 0;
    transport.fallback = (path: string) => {
      if (path !== '/v1/workspace/users') return undefined;
      calls += 1;
      return DIRECTORY;
    };
    transport.responses.delete('/v1/workspace/users');
    await loadDirectory();
    await loadDirectory();
    for (let i = 0; i < 20; i++) userName('u1');
    await loadDirectory();
    expect(calls).toBe(1);
  });

  it('dedupes concurrent loads into one request', async () => {
    let calls = 0;
    transport.fallback = (path: string) => {
      if (path !== '/v1/workspace/users') return undefined;
      calls += 1;
      return DIRECTORY;
    };
    transport.responses.delete('/v1/workspace/users');
    await Promise.all([loadDirectory(), loadDirectory(), loadDirectory()]);
    expect(calls).toBe(1);
  });

  it('REJECTS on failure and stays unloaded, rather than answering an empty directory', async () => {
    // The mutation this exists for: make `loadDirectory` swallow its
    // rejection and set an empty map. Every name then resolves to
    // `undefined`, every card reads as though the person had left the firm,
    // and nothing anywhere says the request failed. That is the founding
    // defect wearing a new coat.
    transport.failures.set('/v1/workspace/users',
      new ModelError('The service could not be reached.', 'network', 0));
    await expect(loadDirectory()).rejects.toThrow(/could not be reached/);
    expect(directoryLoaded()).toBe(false);
    expect(userName('u1')).toBeUndefined();
  });

  it('a rejection does not poison every later call', async () => {
    transport.failures.set('/v1/workspace/users',
      new ModelError('down', 'network', 0));
    await expect(loadDirectory()).rejects.toThrow();
    transport.failures.clear();
    await loadDirectory();
    expect(directoryLoaded()).toBe(true);
    expect(userName('u1')).toBe('A Trainee');
  });

  it('says whether it is loaded, so a caller can tell a stranger from a failure', async () => {
    expect(directoryLoaded()).toBe(false);
    // Before the load, a name is unresolvable for a reason that has nothing
    // to do with the person — which is exactly why `userName` answering
    // `undefined` cannot be read as "this person has left".
    expect(userName('u1')).toBeUndefined();
    await loadDirectory();
    expect(directoryLoaded()).toBe(true);
  });

  it('forgets everything, so a second sign-in does not inherit the first one s people', async () => {
    await loadDirectory();
    expect(userName('u1')).toBe('A Trainee');
    forgetDirectory();
    expect(directoryLoaded()).toBe(false);
    expect(userName('u1')).toBeUndefined();
  });

  it('holds NO WAY TO WRITE at all, asserted over its own source', () => {
    /*
     * THE MUTATION THIS EXISTS FOR, and the behavioural test below does NOT
     * kill it: adding an `apiSend` to this module leaves `transport.sent`
     * empty until something calls the new function, so a directory that had
     * grown a way to assert an attribution would ship green.
     *
     * The rule is about the module's CAPABILITY rather than about one run's
     * behaviour. The fix round that closed `findings/import.ts`'s forged
     * attribution — where a signed-in user could put a colleague's name on a
     * verification — is why: a directory that could POST would reopen that
     * path from a new direction, and the actor on a judgement must keep
     * coming from the token `apps/api` validated and nothing else.
     *
     * The server half is structural and needs no scan: a write route on
     * `/v1/workspace/users` has no `ROUTE_POLICY` entry, and
     * `registerRoleGate`'s `onRoute` hook throws at registration, so every
     * test that builds a server fails.
     */
    // `import.meta.url` is a Vite `/@fs/` URL rather than a `file:` one, so
    // it cannot be handed to `readFileSync`. The path is resolved from this
    // file's own directory instead, and the two sanity checks below are what
    // prove the file it read is the right one.
    const source = readFileSync(path.join(__dirname, 'users.ts'), 'utf8');
    expect(source).not.toMatch(/\bapiSend\b/);
    expect(source).not.toMatch(/\bapiSendBlob\b/);
    expect(source).not.toMatch(/\bapiDelete\b/);
    // The sanity check: the scan really is reading this module, and the
    // three assertions above are not passing over an empty string.
    expect(source).toMatch(/\bapiGet\b/);
    expect(source).toContain('export function userName');
  });

  it('sends no write, ever — this resolves names, it cannot assert one', async () => {
    // The rule the fix round that closed `findings/import.ts`'s forged
    // attribution makes worth asserting: a directory that could be POSTed to
    // would reopen that path from a new direction.
    await loadDirectory();
    userName('u1');
    userInitials('u2');
    expect(transport.sent).toEqual([]);
    expect(transport.deleted).toEqual([]);
  });
});
