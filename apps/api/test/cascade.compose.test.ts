import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * "Deleting a matter deletes its documents' bytes" — against the real stack.
 *
 * `documents.pg.test.ts` proves the cascade over a real Postgres and an
 * in-memory blob store, which is where the ORDER and the failure branches
 * can be examined. This file proves the sentence the README actually makes,
 * in the deployment that has to keep it: the real `AzureBlobStore`, the real
 * Azurite, the real `document` rows, and the real `DELETE /v1/matters/:id`
 * handler — all inside the `api` container, because Azurite publishes no
 * port and nothing on the host can reach it.
 *
 * Task 9 shipped this promise BROKEN on purpose and said so: matters went
 * server-side while documents and their bytes stayed in IndexedDB, so a
 * deleted matter left its bytes behind. This file is where that closes.
 *
 * `*.compose.test.ts` is excluded from `npm test` (Task 1) because it shells
 * out to `docker compose exec`. Requires `npm run compose:up`.
 */
const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api',
      'node', '--experimental-strip-types', '--input-type=module', '-e', script,
    ], { encoding: 'utf8', timeout: 120_000 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

/**
 * The preamble every case shares: the REAL store on the container's own
 * credential, the REAL app-role pool, and a `buildServer` whose only stubs
 * are the two things a container cannot mint for itself — a validated token
 * and the actor it resolves to. Everything the cascade touches is
 * production code.
 *
 * `blobWrap` lets one case put a thin failing shim over the real store's
 * `delete` — the only fault Azurite cannot be asked to produce, and the one
 * the loud-failure branch exists for. The route, the rows, the other key's
 * deletion and the store underneath all stay real.
 */
const withStack = (blobWrap: string, body: string): { code: number; out: string } => inApi([
  "const { AzureBlobStore, blobKeyFor, workspacePrefix } = await import('/app/apps/api/src/blob/store.ts');",
  "const { makeDb, makePool } = await import('/app/apps/api/src/db/pool.ts');",
  "const { buildServer } = await import('/app/apps/api/src/server.ts');",
  // The SHIPPED cap defaults, imported rather than retyped: a harness that
  // invents its own numbers exercises a configuration no deployment has.
  "const { WS_CAP_DEFAULTS } = await import('/app/apps/api/src/config.ts');",
  'const WS = process.env.API_WORKSPACE_ID;',
  'const real = new AzureBlobStore({',
  '  source: process.env.API_BLOB_CREDENTIAL_SOURCE,',
  '  connectionString: process.env.API_BLOB_CONNECTION_STRING,',
  '  accountUrl: process.env.API_BLOB_ACCOUNT_URL,',
  '}, process.env.API_BLOB_CONTAINER);',
  'await real.ensureContainer();',
  `const store = ${blobWrap};`,
  'const pool = makePool(process.env.API_DATABASE_URL, 4);',
  'const db = makeDb(pool);',
  // THE STUBBED ACTOR NEEDS A ROW, because `resolveActor` -- the thing this
  // harness stubs -- is what creates one in production, and Stage 4's
  // `appendAudit` writes `actor_user_id references app_user(id)` inside the
  // delete's own transaction. Without this the whole matter delete is
  // refused with a foreign-key violation, which reads as a broken cascade.
  // Stubbing a resolver means taking on what the resolver did.
  'const ACTOR = "00000000-0000-0000-0000-00000000dead";',
  'await db.query(`insert into app_user'
  + ' (id, workspace_id, issuer, subject, display_name, initials, role, status)'
  + " values ($1, $2, 'i', 's-cascade-test', 'Cascade Test', 'CT', 'reviewer', 'active')"
  + ' on conflict (id) do nothing`, [ACTOR, WS]);',
  'const app = buildServer({',
  '  verify: async () => ({ issuer: "i", subject: "s", groups: ["g"] }),',
  '  gateway: { infer: async () => ({ status: 200, json: {} }), models: async () => ({ status: 200, json: {} }), stream: async () => ({}) },',
  '  workspaceId: WS, maxBodyBytes: 1048576, db, blobs: store,',
  '  resolveActor: async () => ({ id: "00000000-0000-0000-0000-00000000dead", issuer: "i", subject: "s",',
  '    displayName: "Cascade Test", initials: "CT", role: "reviewer", workspaceId: WS }),',
  // Stage 4 Task 16: `buildServer` attaches the live socket, so these two
  // are needed before any route is reached. Omitted, the whole server
  // failed to build and the failure read as a broken cascade.
  "  socket: { ...WS_CAP_DEFAULTS, eventPageMax: 500 }, instanceId: 'api-compose-test',",
  "  eventPageMax: 500,",
  '});',
  'const del = url => app.inject({ method: "DELETE", url, headers: { authorization: "Bearer t" } });',
  'const MATTER = "cascade-" + Date.now().toString(36);',
  'const keyOf = id => blobKeyFor(WS, id);',
  'const seedDoc = async id => {',
  '  await db.query("insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state, byte_size, mime, blob_key, role, added_at) values ($1, $2, \'matter\', $3, $4, \'pdf\', \'x\', \'parsed\', 4, \'application/pdf\', $5, \'standalone\', now())",',
  '    [id, WS, MATTER, id + ".pdf", keyOf(id)]);',
  '  await store.put(keyOf(id), Buffer.from([0x25, 0x50, 0x44, 0x46]), "application/pdf");',
  '};',
  'const listMine = async () => (await real.list(workspacePrefix(WS))).filter(k => k.includes("cascade-doc"));',
  'try {',
  '  await db.query("insert into matter (id, workspace_id, name, created_at, updated_at) values ($1, $2, \'Cascade\', now(), now())", [MATTER, WS]);',
  body,
  '} catch (err) {',
  '  console.log("THREW " + (err && err.message));',
  '  process.exitCode = 9;',
  '} finally {',
  // Whatever happened, this suite leaves nothing behind — the rows through
  // the same cascade the app uses, and any surviving bytes by hand. A
  // compose suite that leaks bytes makes the NEXT run's orphan assertions
  // lie, which is the "assumes it runs alone" failure in its worst form.
  '  await db.query("delete from matter where id = $1 and workspace_id = $2", [MATTER, WS]);',
  '  for (const k of await listMine()) await real.delete(k);',
  '  await pool.end();',
  '  await app.close();',
  '}',
].join('\n'));

const REAL_STORE = 'real';

describe('deleting a matter deletes its documents AND their bytes, in the real stack', () => {
  it('removes both documents rows and both blobs from real Azurite', () => {
    const r = withStack(REAL_STORE, [
      'await seedDoc("cascade-doc-a");',
      'await seedDoc("cascade-doc-b");',
      'console.log("BEFORE " + (await listMine()).length);',
      'const res = await del("/v1/matters/" + MATTER);',
      'console.log("STATUS " + res.statusCode);',
      'const rows = await db.query("select 1 from document where matter_id = $1 and workspace_id = $2", [MATTER, WS]);',
      'console.log("ROWS " + rows.length);',
      'console.log("AFTER " + (await listMine()).length);',
    ].join('\n'));
    expect(r.out, r.out).toContain('BEFORE 2');
    expect(r.out, r.out).toContain('STATUS 204');
    // The rows go by `on delete cascade`…
    expect(r.out, r.out).toContain('ROWS 0');
    // …and THE BYTES GO WITH THEM. This is the line that was false between
    // Task 9 and Task 11, with nothing on any screen to show it.
    expect(r.out, r.out).toContain('AFTER 0');
    expect(r.out).not.toContain('THREW');
    expect(r.code).toBe(0);
  });

  it('deletes the blobs even when one of them is already gone', () => {
    // A half-done cascade is the failure the promise exists to prevent, and
    // the likeliest cause is one delete throwing and aborting the rest. A
    // blob that is already absent must be the cascade succeeding.
    const r = withStack(REAL_STORE, [
      'await seedDoc("cascade-doc-a");',
      'await seedDoc("cascade-doc-b");',
      'await real.delete(keyOf("cascade-doc-a"));',
      'console.log("BEFORE " + (await listMine()).length);',
      'const res = await del("/v1/matters/" + MATTER);',
      'console.log("STATUS " + res.statusCode);',
      'console.log("AFTER " + (await listMine()).length);',
    ].join('\n'));
    expect(r.out, r.out).toContain('BEFORE 1');
    expect(r.out, r.out).toContain('STATUS 204');
    expect(r.out, r.out).toContain('AFTER 0');
    expect(r.code).toBe(0);
  });

  it('reports the delete as failed when a blob could NOT be removed, and still attempts the rest', () => {
    // Loudly, and naming the key. The rows are gone and committed by then,
    // so the failure cannot be undone — silence would make the README's
    // sentence false with nothing on any screen to show it.
    //
    // The `delete` shim is the ONE stub here, because Azurite cannot be
    // asked to refuse a delete. Everything else — the route, the rows, the
    // second key's real deletion — is the real thing.
    const r = withStack(
      '{ ...real, put: (k, b, m) => real.put(k, b, m), get: k => real.get(k), list: p => real.list(p),'
      + ' ensureContainer: () => real.ensureContainer(),'
      + ' delete: async k => { if (k.endsWith("cascade-doc-a")) throw new Error("storage refused"); return real.delete(k); } }',
      [
        'await seedDoc("cascade-doc-a");',
        'await seedDoc("cascade-doc-b");',
        'const res = await del("/v1/matters/" + MATTER);',
        'console.log("STATUS " + res.statusCode);',
        'console.log("MESSAGE " + res.json().error.message);',
        'const rows = await db.query("select 1 from document where matter_id = $1 and workspace_id = $2", [MATTER, WS]);',
        'console.log("ROWS " + rows.length);',
        'const left = await listMine();',
        'console.log("LEFT " + left.join(","));',
      ].join('\n'));
    expect(r.out, r.out).toContain('STATUS 500');
    expect(r.out, r.out).toMatch(/MESSAGE .*could not be deleted/i);
    expect(r.out, r.out).toContain('cascade-doc-a');
    // The rows ARE gone — which is exactly why the failure has to be loud.
    expect(r.out, r.out).toContain('ROWS 0');
    // The refusal did not abort the loop: only the failing key survives.
    expect(r.out, r.out).toMatch(/LEFT \S*cascade-doc-a\s*$/m);
    expect(r.out).not.toContain('cascade-doc-b,');
  });
});
