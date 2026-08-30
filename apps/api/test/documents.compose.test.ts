import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * A document's bytes through the WHOLE deployed path: a real multipart
 * request, the real `POST /v1/documents` handler, the real `AzureBlobStore`,
 * the real Azurite, and the real `GET /v1/documents/:id/bytes` back out.
 *
 * `documents.pg.test.ts` proves the route's decisions against a real
 * Postgres with an in-memory store, because that is where write ORDER and
 * failure branches can be examined. `blobStore.compose.test.ts` proves byte
 * fidelity through Azurite with no route involved. Neither of them puts a
 * multipart body through the multipart parser and gets the same bytes back
 * out of storage — which is the one thing a scanned PDF actually needs, and
 * the path this project's founding defect lives on.
 *
 * It runs INSIDE the `api` container, because Azurite publishes no port.
 * The only stubs are the two things a container cannot mint for itself: a
 * validated token and the actor it resolves to.
 */
const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api',
      'node', '--experimental-strip-types', '--input-type=module', '-e', script,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

const withStack = (body: string): { code: number; out: string } => inApi([
  "const { AzureBlobStore, blobKeyFor, workspacePrefix } = await import('/app/apps/api/src/blob/store.ts');",
  "const { makeDb, makePool } = await import('/app/apps/api/src/db/pool.ts');",
  "const { buildServer } = await import('/app/apps/api/src/server.ts');",
  // The SHIPPED cap defaults, imported rather than retyped: a harness that
  // invents its own numbers exercises a configuration no deployment has.
  "const { WS_CAP_DEFAULTS } = await import('/app/apps/api/src/config.ts');",
  'const WS = process.env.API_WORKSPACE_ID;',
  'const store = new AzureBlobStore({',
  '  source: process.env.API_BLOB_CREDENTIAL_SOURCE,',
  '  connectionString: process.env.API_BLOB_CONNECTION_STRING,',
  '  accountUrl: process.env.API_BLOB_ACCOUNT_URL,',
  '}, process.env.API_BLOB_CONTAINER);',
  'await store.ensureContainer();',
  'const pool = makePool(process.env.API_DATABASE_URL, 4);',
  'const db = makeDb(pool);',
  // `document.added_by_user_id` is a FOREIGN KEY, and attribution comes from
  // the actor — so this needs a REAL `app_user`, not a made-up uuid. The app
  // role can INSERT one (that is how provisioning works) but holds no DELETE
  // on it, so the throwaway is created and removed on the MIGRATOR
  // connection: a suite that commits has to be able to undo everything it
  // wrote.
  'const adminPool = makePool(process.env.API_DATABASE_MIGRATION_URL, 2);',
  'const admin = makeDb(adminPool);',
  "const ACTOR = (await admin.query(\"insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status) values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'U T', 'UT', 'reviewer', 'active') returning id\", [WS]))[0].id;",
  'const app = buildServer({',
  '  verify: async () => ({ issuer: "i", subject: "s", groups: ["g"] }),',
  '  gateway: { infer: async () => ({ status: 200, json: {} }), models: async () => ({ status: 200, json: {} }), stream: async () => ({}) },',
  '  workspaceId: WS, maxBodyBytes: 16777216, db, blobs: store,',
  '  resolveActor: async () => ({ id: ACTOR, issuer: "i", subject: "s",',
  '    displayName: "Upload Test", initials: "UT", role: "reviewer", workspaceId: WS }),',
  // Stage 4 Task 16: `buildServer` attaches the live socket, so these two
  // are needed before any route is reached. Omitted, the whole server
  // failed to build and the failure read as a broken upload.
  "  socket: { ...WS_CAP_DEFAULTS, eventPageMax: 500 }, instanceId: 'api-compose-test',",
  "  eventPageMax: 500,",
  '});',
  'const MATTER = "upload-" + Date.now().toString(36);',
  'const DOC = MATTER + "-doc";',
  'const B = "----lexpromptupload";',
  'const upload = (record, bytes, filename, mime) => {',
  '  const head = Buffer.from("--" + B + "\\r\\nContent-Disposition: form-data; name=\\"record\\"\\r\\n\\r\\n"',
  '    + JSON.stringify(record) + "\\r\\n--" + B',
  '    + "\\r\\nContent-Disposition: form-data; name=\\"bytes\\"; filename=\\"" + filename + "\\"\\r\\n"',
  '    + "Content-Type: " + mime + "\\r\\n\\r\\n", "utf8");',
  '  return app.inject({ method: "POST", url: "/v1/documents",',
  '    headers: { authorization: "Bearer t", "content-type": "multipart/form-data; boundary=" + B },',
  '    payload: Buffer.concat([head, bytes, Buffer.from("\\r\\n--" + B + "--\\r\\n", "utf8")]) });',
  '};',
  'try {',
  '  await db.query("insert into matter (id, workspace_id, name, created_at, updated_at) values ($1, $2, \'Upload\', now(), now())", [MATTER, WS]);',
  body,
  '} catch (err) {',
  '  console.log("THREW " + (err && err.message));',
  '  process.exitCode = 9;',
  '} finally {',
  '  const keys = (await store.list(workspacePrefix(WS))).filter(k => k.includes(MATTER));',
  '  for (const k of keys) await store.delete(k);',
  '  await db.query("delete from matter where id = $1 and workspace_id = $2", [MATTER, WS]);',
  // THE AUDIT ROWS FIRST, and this is a fact about the schema rather than
  // about the test: `audit_event.actor_user_id` references `app_user` with
  // no cascade, so a person with audited acts CANNOT be deleted. That is
  // deliberate -- an audit row whose actor was erased records an act nobody
  // performed -- and the product's own removal mechanism is
  // `status = 'disabled'`, never a delete.
  '  await admin.query("delete from audit_event where actor_user_id = $1", [ACTOR]);',
  '  await admin.query("delete from app_user where id = $1", [ACTOR]);',
  '  await pool.end();',
  '  await adminPool.end();',
  '  await app.close();',
  '}',
].join('\n'));

describe('a document uploaded through the real route comes back byte-identical', () => {
  it('round-trips a scanned-PDF-shaped body, with the mime and length it went in with', () => {
    // 0x00 and 0xFF are the two bytes that catch a UTF-8 conversion slipped
    // in anywhere along the path — neither survives a round trip through a
    // string, and a "hello world" test would not notice. A real scan is
    // exactly this: binary, large, and reviewed as though it said nothing if
    // any of it is lost.
    const r = withStack([
      'const bytes = Buffer.concat([',
      '  Buffer.from("%PDF-1.7\\n", "ascii"),',
      '  Buffer.from([0x00, 0xFF, 0x25, 0xFE, 0x0A, 0x00]),',
      '  Buffer.alloc(512 * 1024, 0xAB),',
      '  Buffer.from("\\n%%EOF\\n", "ascii"),',
      ']);',
      'const rec = { id: DOC, matterId: MATTER, name: "scan.pdf", kind: "pdf",',
      '  text: "", parseError: "This PDF has no text layer.",',
      '  byteSize: bytes.length, addedAt: Date.now(), addedByUserId: "", role: "standalone" };',
      'const posted = await upload(rec, bytes, "scan.pdf", "application/pdf");',
      'console.log("POST " + posted.statusCode);',
      'console.log("KEY " + (await store.list(workspacePrefix(WS))).filter(k => k.endsWith(DOC)).join(","));',
      'const got = await app.inject({ method: "GET", url: "/v1/documents/" + DOC + "/bytes",',
      '  headers: { authorization: "Bearer t" } });',
      'console.log("GET " + got.statusCode);',
      'console.log("TYPE " + got.headers["content-type"]);',
      'console.log("LENGTH " + got.headers["content-length"] + " of " + bytes.length);',
      'console.log("EQUAL " + Buffer.compare(got.rawPayload, bytes));',
      // P12, CLOSED (Stage 3 Task 9). Every upload now stores
      // `parse_state = 'pending'` and the PARSE WORKER writes what it found;
      // the body's own `parseError` is discarded, because a browser that
      // failed to read a file locally has said nothing about whether the
      // server can read the bytes it just uploaded.
      //
      // Read immediately after the POST rather than after a wait, so this
      // test asks what the ROUTE wrote and not what the worker did with it
      // afterwards — the worker's own behaviour is `hydrate.pg.test.ts`'s.
      'const state = await db.query("select parse_state, text from document where id = $1 and workspace_id = $2", [DOC, WS]);',
      'console.log("STATE " + state[0].parse_state);',
      'console.log("TEXTLEN " + state[0].text.length);',
    ].join('\n'));
    expect(r.out, r.out).toContain('POST 201');
    expect(r.out, r.out).toMatch(/KEY workspace\/[^/]+\/document\/upload-/);
    expect(r.out, r.out).toContain('GET 200');
    expect(r.out, r.out).toContain('TYPE application/pdf');
    expect(r.out, r.out).toMatch(/LENGTH (\d+) of \1/);
    // 0 means byte-identical. Anything else is a document that lies about
    // what the firm uploaded.
    expect(r.out, r.out).toContain('EQUAL 0');
    expect(r.out, r.out).toContain('STATE pending');
    expect(r.out, r.out).toContain('TEXTLEN 0');
    expect(r.out).not.toContain('THREW');
    expect(r.code).toBe(0);
  });

  it('deleting the document removes its bytes from real Azurite', () => {
    const r = withStack([
      'const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xFF]);',
      'const rec = { id: DOC, matterId: MATTER, name: "lease.pdf", kind: "pdf", text: "x",',
      '  byteSize: bytes.length, addedAt: Date.now(), addedByUserId: "", role: "standalone" };',
      'await upload(rec, bytes, "lease.pdf", "application/pdf");',
      'console.log("BEFORE " + (await store.list(workspacePrefix(WS))).filter(k => k.endsWith(DOC)).length);',
      'const del = await app.inject({ method: "DELETE", url: "/v1/documents/" + DOC,',
      '  headers: { authorization: "Bearer t" } });',
      'console.log("DELETE " + del.statusCode);',
      'console.log("AFTER " + (await store.list(workspacePrefix(WS))).filter(k => k.endsWith(DOC)).length);',
    ].join('\n'));
    expect(r.out, r.out).toContain('BEFORE 1');
    expect(r.out, r.out).toContain('DELETE 204');
    expect(r.out, r.out).toContain('AFTER 0');
    expect(r.code).toBe(0);
  });
});
