import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * Real bytes, through the real `AzureBlobStore`, into the real Azurite —
 * from inside the `api` container, which is the only place that can reach
 * it.
 *
 * Azurite publishes NO PORT, deliberately (it holds the firm's document
 * bytes and must have no route out), so this suite cannot drive the store
 * from the host the way a unit test would. It runs the store inside `api`
 * instead, over the same connection string the service itself is configured
 * with — which makes it a stronger test than a host-side one would have
 * been: what is exercised is the process, the credential and the network
 * path that actually carry a document.
 *
 * `*.compose.test.ts` is already excluded from `npm test` (Task 1), because
 * it shells out to `docker compose exec` and the default gate must stay
 * green with no Docker daemon at all. Requires `npm run compose:up`.
 */
const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api',
      'node', '--experimental-strip-types', '--input-type=module', '-e', script,
    ], { encoding: 'utf8', timeout: 60_000 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

/** Runs `body` with an `AzureBlobStore` built from the container's own
 *  configuration — the same two keys `main.ts` reads, resolved by the same
 *  `resolveBlobCredential`, with no fallback available to it. */
const withStore = (body: string): { code: number; out: string } => inApi(`
  const { AzureBlobStore, blobKeyFor, workspacePrefix } =
    await import('/app/apps/api/src/blob/store.ts');
  const store = new AzureBlobStore(
    {
      source: process.env.API_BLOB_CREDENTIAL_SOURCE,
      connectionString: process.env.API_BLOB_CONNECTION_STRING,
      accountUrl: process.env.API_BLOB_ACCOUNT_URL,
    },
    process.env.API_BLOB_CONTAINER,
  );
  await store.ensureContainer();
  try {
    ${body}
  } catch (err) {
    console.log('THREW ' + (err && err.message));
    process.exit(9);
  }
`);

describe('document bytes round-trip through a real Azure Blob store', () => {
  it('puts and gets byte-identical content, including a null byte and a 0xFF byte', () => {
    // A TEXT round trip proves nothing about a PDF. A UTF-8 conversion
    // slipped in anywhere between here and the container would survive a
    // "hello world" test and corrupt every document in the firm — 0x00 and
    // 0xFF are the two bytes that catch it, because neither survives a
    // round trip through a string.
    const r = withStore(`
      const key = blobKeyFor('ws-compose', 'doc-bytes');
      const payload = Buffer.from([0x00, 0x25, 0x50, 0x44, 0x46, 0xFF, 0x0A, 0x00, 0xFE]);
      await store.put(key, payload, 'application/pdf');
      const back = await store.get(key);
      console.log('EQUAL ' + Buffer.compare(back.bytes, payload));
      console.log('LENGTH ' + back.bytes.length);
      console.log('MIME ' + back.mime);
      await store.delete(key);
    `);
    expect(r.out, r.out).toContain('EQUAL 0');
    expect(r.out).toContain('LENGTH 9');
    expect(r.out).toContain('MIME application/pdf');
    expect(r.code).toBe(0);
  });

  it('answers null for a missing key rather than throwing', () => {
    // A `DocumentRecord` can outlive its bytes, and the UI must be able to
    // show that document's metadata with an "unavailable" state instead of
    // the whole view blowing up.
    const r = withStore(`
      const missing = await store.get(blobKeyFor('ws-compose', 'never-written'));
      console.log('RESULT ' + (missing === null ? 'null' : 'something'));
    `);
    expect(r.out, r.out).toContain('RESULT null');
    expect(r.out).not.toContain('THREW');
  });

  it('resolves a delete of a key that is not there — the cascade succeeding, not failing', () => {
    const r = withStore(`
      await store.delete(blobKeyFor('ws-compose', 'never-written'));
      console.log('RESOLVED');
    `);
    expect(r.out, r.out).toContain('RESOLVED');
    expect(r.out).not.toContain('THREW');
  });

  it('lists only the keys under the prefix, and never another workspace s', () => {
    // Seeded under a DIFFERENT workspace, because a `list` that ignored its
    // prefix would pass a test that only ever wrote one.
    const r = withStore(`
      const mine = blobKeyFor('ws-list-a', 'd1');
      const alsoMine = blobKeyFor('ws-list-a', 'd2');
      const theirs = blobKeyFor('ws-list-b', 'd1');
      for (const k of [mine, alsoMine, theirs]) await store.put(k, Buffer.from([1]), 'application/pdf');
      const found = await store.list(workspacePrefix('ws-list-a'));
      console.log('FOUND ' + found.sort().join(','));
      for (const k of [mine, alsoMine, theirs]) await store.delete(k);
    `);
    expect(r.out, r.out).toContain(
      'FOUND workspace/ws-list-a/document/d1,workspace/ws-list-a/document/d2');
    expect(r.out).not.toContain('ws-list-b');
  });

  it('has no route to Azurite from the host — the store publishes no port', () => {
    // The same property `postgres` has, checked the same way: a blob store
    // reachable from the host is reachable from anything else on that host.
    // Read from `docker compose ps` rather than from the compose file,
    // because what is running is the thing that matters.
    const ports = execFileSync('docker', [
      'compose', 'ps', '--format', '{{.Service}}|{{.Ports}}',
    ], { encoding: 'utf8', timeout: 30_000 });
    const azurite = ports.split('\n').find(line => line.startsWith('azurite|'));
    expect(azurite, ports).toBeTruthy();
    expect(azurite).not.toMatch(/->/);
  });
});
