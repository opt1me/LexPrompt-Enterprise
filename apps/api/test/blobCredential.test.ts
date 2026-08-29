import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveBlobCredential, BlobCredentialError } from '../src/blob/credential.ts';
import { blobKeyFor, workspacePrefix } from '../src/blob/store.ts';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

const CONNECTION = 'UseDevelopmentStorage=true';
const ACCOUNT_URL = 'https://lexprompt.blob.core.windows.net';

describe('the blob credential comes from ONE configured source and never falls back', () => {
  it('uses the connection string when that is the configured source', () => {
    const c = resolveBlobCredential({ source: 'connection-string', connectionString: CONNECTION });
    expect(c.kind).toBe('connection-string');
  });

  it('uses a managed identity when THAT is the configured source, even with a connection string present', () => {
    // "Whichever value is set" would be an environment branch wearing a
    // convenience's clothes, and it would let a developer's `az login`
    // silently satisfy a deployment the operator believed was keyed.
    const c = resolveBlobCredential({
      source: 'managed-identity', accountUrl: ACCOUNT_URL, connectionString: CONNECTION,
    });
    expect(c.kind).toBe('managed-identity');
    expect(c).toEqual({ kind: 'managed-identity', accountUrl: ACCOUNT_URL });
  });

  it('uses the connection string when THAT is the configured source, even with an account URL present', () => {
    // The mirror image, and not symmetry for its own sake: the fallback
    // somebody would actually write goes in this direction too, and a test
    // for only one of them leaves the other open.
    const c = resolveBlobCredential({
      source: 'connection-string', connectionString: CONNECTION, accountUrl: ACCOUNT_URL,
    });
    expect(c).toEqual({ kind: 'connection-string', connectionString: CONNECTION });
  });

  it('refuses loudly when the configured source has no material, and NEVER tries the other', () => {
    const err = (() => {
      try {
        resolveBlobCredential({ source: 'managed-identity', connectionString: CONNECTION });
      } catch (e) { return e; }
      return undefined;
    })();
    expect(err).toBeInstanceOf(BlobCredentialError);
    expect((err as Error).message).toMatch(/API_BLOB_ACCOUNT_URL/);
    // Naming the OTHER source in the message would invite exactly the
    // fallback this refuses. Assert it does not.
    expect((err as Error).message).not.toMatch(/connection string/i);
  });

  it('refuses just as loudly in the other direction', () => {
    expect(() => resolveBlobCredential({ source: 'connection-string', accountUrl: ACCOUNT_URL }))
      .toThrow(/API_BLOB_CONNECTION_STRING/);
  });

  it('treats a whitespace-only value as no material at all', () => {
    // An unset compose interpolation arrives as '', and a fat-fingered one
    // as ' '. Both are "the operator did not configure this", and neither
    // may be handed to the SDK to fail somewhere less legible.
    expect(() => resolveBlobCredential({ source: 'connection-string', connectionString: '   ' }))
      .toThrow(/API_BLOB_CONNECTION_STRING/);
    expect(() => resolveBlobCredential({ source: 'managed-identity', accountUrl: ' ' }))
      .toThrow(/API_BLOB_ACCOUNT_URL/);
  });

  it('refuses an unknown source rather than defaulting to one', () => {
    expect(() => resolveBlobCredential({ source: 'guess' as never }))
      .toThrow(/API_BLOB_CREDENTIAL_SOURCE/);
  });

  it('refuses an ABSENT source rather than defaulting to one', () => {
    // `config.ts` passes `API_BLOB_CREDENTIAL_SOURCE ?? ''` straight
    // through, so "nobody configured this" arrives here as `''`. A default
    // would be this code choosing which identity holds the firm's documents.
    expect(() => resolveBlobCredential({ source: '' as never, connectionString: CONNECTION }))
      .toThrow(/API_BLOB_CREDENTIAL_SOURCE/);
  });
});

describe('a blob key is built in exactly one place', () => {
  it('is §6.5s key', () => {
    expect(blobKeyFor('ws-1', 'doc-1')).toBe('workspace/ws-1/document/doc-1');
  });

  it('scopes a workspace prefix to that workspace and not to one that starts the same way', () => {
    expect(workspacePrefix('ws-1')).toBe('workspace/ws-1/document/');
    // 'workspace/ws-1' alone would also match 'workspace/ws-10/...'. The
    // trailing segment is what stops a cascade reaching into a neighbour.
    expect(blobKeyFor('ws-10', 'd').startsWith(workspacePrefix('ws-1'))).toBe(false);
  });

  it('is the only place in apps/api/src that composes one', () => {
    // The `findingsKeyFor` rule, one store over: a key derived twice is a
    // blob a delete cascade cannot find, and the README's promise about
    // deleting a matter becomes false in the direction nobody notices.
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'apps/api/src'))) {
      if (rel(file) === 'apps/api/src/blob/store.ts') continue;
      if (/workspace\/\$\{|'workspace\/|`workspace\//.test(codeOf(file))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});
