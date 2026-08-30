import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

/**
 * Stage 2's definition of done (§18 item 3), as a suite that fails when any
 * of it stops being true.
 *
 * It extends `src/lib/model/stage1DoD.test.ts`'s shape rather than inventing
 * a second one: comment-stripped source (`codeOf`), a sanity check that
 * every scanner finds the files it scans, and one named exemption where an
 * exemption is genuinely needed, asserted to be exactly that name.
 *
 * ## What this file DOES NOT do, and why that matters more here than usual
 *
 * §18 item 3 is nine clauses, and most of them are already carried by a
 * suite that runs the real thing — a real Postgres, real Azurite, a real
 * Fastify with the shipped policy table. **Restating those assertions here
 * would be sibling drift**, which is this project's most repeated failure by
 * a wide margin, and it would be the worst kind: two suites making the same
 * claim, one of which runs against a database and one of which does not, so
 * the weaker one is the one that stays green when the property breaks.
 *
 * So where a clause is carried by a suite that exercises it, this file
 * asserts the STRUCTURAL fact that suite depends on and cannot re-check for
 * itself:
 *
 *  - that the suite exists and is wired into a runner (a `.pg.test.ts` that
 *    nothing runs is the guard the ledger names as most likely to be thought
 *    unnecessary);
 *  - that every table in the migrations has a named home for its round trip,
 *    so a new table cannot arrive with nowhere to prove itself;
 *  - that `authz.route.test.ts` still reads the SHIPPED policy table rather
 *    than a fixture — the exact regression the Stage 2 ledger records, where
 *    a role matrix stayed green while the partner gate was downgraded,
 *    because the matrix was testing a fixture's policy and not the app's.
 *
 * And where a clause is an ABSENCE, this file is the thing that checks it,
 * because an absence has no suite of its own by definition.
 */

const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const GATEWAY_SOURCES = walk(path.join(ROOT, 'apps/gateway/src'));
const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...GATEWAY_SOURCES, ...CORE_SOURCES];

const MIGRATIONS = path.join(ROOT, 'apps/api/migrations');
const readme = (): string => readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Every `create table <name>` across every migration, in file order. */
function tablesInMigrations(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(/create table (?:if not exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      // `create table if not exists %I` — 012's DO block, which creates
      // `audit_event`'s monthly partitions by a name it FORMATS. The
      // optional group is optional, so the regex backtracks and captures the
      // keyword `if`, which then reads as a table with no suite named for
      // it. Skipped rather than matched, because the partition names are
      // genuinely not in the source and the parent they belong to is.
      if (/^if$/i.test(m[1])) continue;
      found.push(m[1]);
    }
  }
  return found;
}

describe('the scanners find something (a guard that matches nothing passes vacuously)', () => {
  it('walks every workspace, and a realistic number of files in each', () => {
    // The web bound came down and the core bound went up in the same commit:
    // §13 Stage 0 moved the review closure — fourteen modules and their
    // tests — out of `src/lib/` and into `packages/core/src/domain/`. These
    // are sanity bounds on the SCANNERS, not budgets on the workspaces; each
    // is set low enough that it cannot be met by a walk that silently
    // returned almost nothing, which is the only failure they exist to catch.
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(20);
    expect(GATEWAY_SOURCES.length).toBeGreaterThan(10);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(ALL_SOURCES.length).toBeGreaterThan(200);
  });

  it('reads a README with something in it', () => {
    expect(readme().length).toBeGreaterThan(5000);
  });

  it('reads the migrations, and finds the tables this stage created', () => {
    const tables = tablesInMigrations();
    expect(tables.length).toBeGreaterThan(10);
    // Named individually rather than counted, so a migration that stopped
    // parsing shows up as the missing table rather than as a smaller number.
    for (const t of ['app_user', 'matter', 'document', 'review', 'playbook_version',
      'precedent_set', 'position_basis', 'workspace_setting']) {
      expect(tables, t).toContain(t);
    }
  });

  it('finds every file this suite makes a claim about', () => {
    for (const file of [
      'apps/api/src/config.ts', 'apps/api/src/blob/store.ts',
      'apps/api/src/auth/routeTable.ts', 'apps/api/src/auth/requireRole.ts',
      'apps/api/test/authz.route.test.ts', 'apps/api/test/blobStore.compose.test.ts',
      'apps/api/test/cascade.compose.test.ts', 'apps/api/test/roles.pg.test.ts',
      'apps/api/test/precedent.pg.test.ts', 'apps/api/test/workspaceScope.test.ts',
      'apps/gateway/package.json', 'src/lib/upload/run.ts', 'src/lib/upload/report.ts',
      'src/test/precedentPromise.test.ts',
      'src/features/redlines/PrecedentIntake.tsx', 'src/lib/privacyCopy.ts',
      'vitest.compose.config.ts', 'vitest.pg.config.ts', 'README.md',
    ]) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});

describe('Stage 2 definition of done (§18 item 3)', () => {
  // ---- every record type round-trips through Postgres ----

  /**
   * Which suite proves each table's round trip.
   *
   * This map is the point: the round trips themselves run in `npm run
   * test:pg`, against a real database, and re-asserting them here would give
   * the property a second home that never touches Postgres. What this map
   * catches is the thing those suites cannot catch about themselves — a new
   * table arriving with no suite naming it, which is how a record type ends
   * up with no round trip and nothing red.
   *
   * `workspace` is the tenant row rather than a record a client reads or
   * writes; it is still named, because "this one needs no round trip" is a
   * decision worth being able to see.
   */
  const ROUND_TRIP_HOME: Record<string, string> = {
    workspace: 'apps/api/test/records.pg.test.ts',
    app_user: 'apps/api/test/identity.pg.test.ts',
    role_mapping: 'apps/api/test/roles.pg.test.ts',
    matter: 'apps/api/test/matters.pg.test.ts',
    document: 'apps/api/test/documents.pg.test.ts',
    collection: 'apps/api/test/collections.pg.test.ts',
    review: 'apps/api/test/reviews.pg.test.ts',
    playbook: 'apps/api/test/playbooks.pg.test.ts',
    playbook_version: 'apps/api/test/playbooks.pg.test.ts',
    changeset: 'apps/api/test/changesets.pg.test.ts',
    precedent_set: 'apps/api/test/precedent.pg.test.ts',
    position_basis: 'apps/api/test/positionBasis.pg.test.ts',
    workspace_setting: 'apps/api/test/workspaceSettings.pg.test.ts',
    // Stage 3. `finding` and `note` are records a client reads and writes;
    // the two disposition tables are the record of a human judgement and its
    // history; the two `finding_migration_*` tables are the backfill's census
    // and its report, which outlive the migration and are covered by the
    // suite that proves the migration refuses rather than guesses.
    finding: 'apps/api/test/findings.pg.test.ts',
    note: 'apps/api/test/findings.pg.test.ts',
    finding_disposition: 'apps/api/test/dispositions.pg.test.ts',
    finding_disposition_event: 'apps/api/test/dispositions.pg.test.ts',
    finding_migration_census: 'apps/api/test/findingsBackfill.pg.test.ts',
    finding_migration_report: 'apps/api/test/findingsBackfill.pg.test.ts',
    // Stage 4 Task 24. A request one person made of another (§6.3, S17) --
    // created, listed and closed by the suite named here, which also holds
    // the assertion that keeps it from becoming a disposition.
    assignment: 'apps/api/test/assignments.pg.test.ts',
    // Stage 3 Task 8's queue. `run` and `run_cell` are covered by the suite
    // that creates a run and by the one that proves a run that died cannot
    // look finished — two files, because "a queue creates the right cells"
    // and "a queue's failure paths are honest" are different claims and the
    // second is the one this stage is named after. `event` has its own,
    // since the cursor is a protocol Stage 4 inherits rather than a table
    // any screen reads.
    run: 'apps/api/test/runQueue.pg.test.ts',
    run_cell: 'apps/api/test/runLifecycle.pg.test.ts',
    event: 'apps/api/test/events.pg.test.ts',
    // Stage 4 Task 11. `audit_event` is the one table in this map whose
    // suite is mostly about what the app role CANNOT do to it: the round
    // trip is one insert, and everything else is the grant that makes the
    // insert the only thing possible.
    audit_event: 'apps/api/test/auditEvent.pg.test.ts',
  };

  it('every table in the migrations has a named suite, and every named suite exists', () => {
    const unhomed = tablesInMigrations().filter(t => !(t in ROUND_TRIP_HOME));
    expect(unhomed.sort(), 'a table with no suite named for it').toEqual([]);

    const missing = Object.entries(ROUND_TRIP_HOME)
      .filter(([, file]) => !existsSync(path.join(ROOT, file)))
      .map(([table, file]) => `${table} -> ${file}`);
    expect(missing.sort()).toEqual([]);

    /*
     * …and the named suite genuinely mentions its table, so the map cannot
     * be satisfied by pointing every row at one file that happens to exist.
     *
     * RAW text here, not `codeOf`, and that is a deliberate exception to
     * this file's own rule. A suite that exercises its table through the
     * shipped route rather than through raw SQL never names it in code —
     * `workspaceSettings.pg.test.ts` goes through `buildTestApi` and names
     * `workspace_setting` only in the docstring saying what it covers, which
     * is the RIGHT shape for that suite and not a gap. The property this
     * check is for is "the map points somewhere relevant", and a docstring
     * naming the table is evidence of that; a file with no connection to the
     * table would not mention it at all, in code or in prose.
     */
    const silent = Object.entries(ROUND_TRIP_HOME)
      .filter(([table, file]) =>
        !new RegExp(`\\b${table}\\b`).test(readFileSync(path.join(ROOT, file), 'utf8')))
      .map(([table, file]) => `${file} never names ${table}`);
    expect(silent.sort()).toEqual([]);
  });

  it('the map is not stale in the other direction either', () => {
    const tables = new Set(tablesInMigrations());
    const ghosts = Object.keys(ROUND_TRIP_HOME).filter(t => !tables.has(t));
    expect(ghosts.sort(), 'a row for a table no migration creates').toEqual([]);
  });

  it('the real-database suites are wired to a runner that actually runs them', () => {
    // The ledger names this as "the guard most likely to be thought
    // unnecessary". A `.pg.test.ts` that no config includes is a suite whose
    // absence looks exactly like a suite that passes.
    const pgConfig = readFileSync(path.join(ROOT, 'vitest.pg.config.ts'), 'utf8');
    expect(pgConfig).toContain("include: ['apps/api/test/**/*.pg.test.ts']");
    const composeConfig = readFileSync(path.join(ROOT, 'vitest.compose.config.ts'), 'utf8');
    expect(composeConfig).toContain("include: ['apps/api/test/**/*.compose.test.ts']");
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['test:pg']).toContain('vitest.pg.config.ts');
    expect(pkg.scripts['test:compose']).toContain('vitest.compose.config.ts');
  });

  // ---- no document bytes in Postgres, and no page image anywhere ----

  it('no migration declares a bytes column — the bytes live in the blob store', () => {
    // §6.5. A `bytea` column is how "we will move them later" becomes
    // permanent, and it would make every row read carry a contract.
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
        // Comment-stripped for the same reason the TypeScript scans are:
        // 002_records.sql explains at length why there is no bytes column.
        .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
      if (/\bbytea\b|\blarge object\b|\boid\b\s*,/i.test(sql)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // The scan bites on the thing it looks for.
    expect(/\bbytea\b/i.test('  bytes bytea not null,')).toBe(true);
  });

  it('nothing server-side stores a page image (S12)', () => {
    /*
     * Page images are derived data, ~a third larger than their source, and
     * regenerated on demand. Stage 2 gave the system its first place to put
     * them permanently, which is exactly when this needs checking.
     *
     * This used to be "no server-side file may contain the string at all",
     * and two things have since made that unsayable — both of them right,
     * neither of them a weakening:
     *
     *  - Stage 3 Task 2 moved `DocumentFile` and `modelContext.ts` into
     *    `packages/core`, so the field that page images live on is now
     *    DECLARED on the server's side of the line. Naming a field in a
     *    shared type is not storing one.
     *  - Stage 3 Task 1 answered Spike 1 yes, so `apps/api` renders page
     *    images. In memory, never persisted — which is the claim, and it is
     *    a claim about writes, not about vocabulary.
     *
     * So the guard names each carrier, holds each to the no-persistence rule
     * INDIVIDUALLY, and still fails for any file that is not on the list.
     * The regex is case-insensitive now, which it was not before: the old one
     * would not have matched `renderPageImages` at all, so the one file in
     * `apps/api/src` whose entire purpose is page images was invisible to the
     * scan that was supposed to be watching for exactly that.
     */
    const PAGE_IMAGE_CARRIERS = [
      // Declares `DocumentFile.pageImages`. A type, no writer.
      'packages/core/src/domain/types.ts',
      // Reads it to decide whether a document is readable by this model.
      'packages/core/src/domain/modelContext.ts',
      // Renders them (Spike 1). Bytes in, base64 out, nothing kept.
      'apps/api/src/parse/pageImages.ts',
      // Names the render's two operator-facing bounds and nothing else.
      // Caught by the case-insensitive regex above and not by the old one,
      // which is the point of having widened it.
      'apps/api/src/config.ts',
      // The two extractors (Stage 3 Task 3). They READ `doc.pageImages` to
      // decide whether to attach a scan's rendered pages to the model call —
      // which is the whole reason a scanned document can be reviewed at all.
      // They hold no store and write nothing.
      'packages/core/src/review/extractClause.ts',
      'packages/core/src/review/extractCollectionClause.ts',
      // Stage 3 Task 9's hydration and its cache. The cache is BOUNDED,
      // in-process and byte-counted; nothing in this file reaches a store or
      // a pool, which is the claim, and `hydrate.pg.test.ts` proves no image
      // reaches Postgres or the blob store from a whole run.
      'apps/api/src/parse/hydrate.ts',
      // Task 10's worker. It HOLDS a cache and passes it to the hydration;
      // it writes model output to `finding` and never a page image — the
      // column list it writes is `FINDING_COLUMNS`, which has no such
      // column and cannot grow one without 005 growing one first.
      'apps/api/src/run/worker.ts',
      // The composition root: it builds the cache with the declared bound
      // and hands it to the pool. One `makePageImageCache` call, no store.
      'apps/api/src/main.ts',
    ];
    const PAGE_IMAGE = /pageimages|page_images|pageimage/i;
    // The scan bites on what it looks for, including the name that the
    // case-sensitive version silently missed.
    expect(PAGE_IMAGE.test('const x = doc.pageImages')).toBe(true);
    expect(PAGE_IMAGE.test('export function renderPageImages()')).toBe(true);

    const offenders = [...API_SOURCES, ...CORE_SOURCES]
      .filter(f => PAGE_IMAGE.test(codeOf(f)))
      .map(rel)
      .filter(name => !PAGE_IMAGE_CARRIERS.includes(name));
    expect(offenders).toEqual([]);

    /*
     * Every carrier still exists, still names it, and still WRITES it
     * nowhere. A stale exemption is worse than none.
     *
     * TIGHTENED BY STAGE 3 TASK 10, and tightened rather than relaxed. The
     * previous pattern matched the TYPE NAME `BlobStore`, which is not a
     * write and never was: the run worker takes a `BlobStore` to READ a
     * document's original bytes, which is the one thing it must do before it
     * can render a scan's pages at all, and `main.ts` takes one to build it.
     * Matching a type name would have forced either an exemption for those
     * two files — and a file-level exemption hides everything in the file,
     * which is the `PdfCanvas` lesson this repository already paid for — or
     * a contortion in the source to satisfy a regex.
     *
     * So the pattern now names WRITES: `.put(` (any binding, so renaming the
     * store does not evade it), `blobKeyFor` (constructing an address in the
     * store is how you would write to one), an INSERT, and the browser's two
     * persistence APIs. The assertions below prove it bites on each and does
     * not bite on the type name — because a guard that was widened and never
     * shown to still catch anything is decoration.
     */
    const PERSISTS = /\.put\(|blobKeyFor|insert into|INSERT INTO|withPool|getPool|localStorage|indexedDB/;
    expect(PERSISTS.test('await blobs.put(key, bytes, mime)')).toBe(true);
    expect(PERSISTS.test('await store.put(k, b, m)')).toBe(true);
    expect(PERSISTS.test('blobKeyFor(ws, id)')).toBe(true);
    expect(PERSISTS.test('await t.query(`insert into finding (…)`)')).toBe(true);
    // …and not on a type it merely names.
    expect(PERSISTS.test("import type { BlobStore } from '../blob/store.ts';")).toBe(false);
    for (const carrier of PAGE_IMAGE_CARRIERS) {
      const full = path.join(ROOT, carrier);
      expect(existsSync(full), carrier).toBe(true);
      const code = codeOf(full);
      expect(PAGE_IMAGE.test(code), `${carrier} no longer names it`).toBe(true);
      expect(PERSISTS.test(code), `${carrier} persists a page image`).toBe(false);
    }

    for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
      expect(readFileSync(path.join(MIGRATIONS, file), 'utf8'), file)
        .not.toMatch(/page_image/);
    }
  });

  // ---- refused by the API, not merely hidden by the UI ----

  it('the authorisation matrix tests the SHIPPED policy table, not a fixture', () => {
    /*
     * The exact regression the Stage 2 ledger records: `authz.route.test.ts`
     * stayed green when the partner gate was downgraded, because its matrix
     * ran against a FIXTURE policy rather than against the table the app
     * registers. A suite that proves a fixture's behaviour is a suite that
     * cannot fail for the reason it exists.
     */
    const authz = codeOf(path.join(ROOT, 'apps/api/test/authz.route.test.ts'));
    expect(authz).toMatch(/import\s*\{[^}]*ROUTE_POLICY[^}]*\}\s*from\s*'\.\.\/src\/auth\/routeTable\.ts'/);
    // Both directions, on the shipped table, and the two real-server passes
    // that go with them — named individually so deleting any one is red.
    for (const claim of [
      'has a policy entry for every registered route',
      'has no policy entry for a route that does not exist',
      'a reviewer is refused at every route the shipped table puts above them',
      'a reviewer reaches every route the shipped table says they may',
    ]) {
      expect(authz, claim).toContain(claim);
    }
  });

  it('the role gate has no default and no fallback, so a new route cannot ship open', () => {
    const gate = codeOf(path.join(ROOT, 'apps/api/src/auth/requireRole.ts'));
    // It throws at registration rather than defaulting.
    expect(gate).toMatch(/throw new Error/);
    // …and no policy is invented for a route that has none.
    expect(gate).not.toMatch(/\?\?\s*'reviewer'|\|\|\s*'reviewer'|default:\s*'reviewer'/);
    const table = codeOf(path.join(ROOT, 'apps/api/src/auth/routeTable.ts'));
    expect(table).not.toMatch(/\[\s*key\s*:\s*string\s*\]\s*\?/);
  });

  it('every route reads its role from the actor, never from the request', () => {
    // A header a caller controls deciding what a caller may do is the shape
    // this whole gate exists to make impossible.
    const offenders: string[] = [];
    for (const file of API_SOURCES) {
      const code = codeOf(file);
      if (/req(uest)?\.headers\[['"]x-[a-z-]*role/i.test(code)) offenders.push(rel(file));
      if (/body\.role\b/.test(code)) offenders.push(`${rel(file)} reads a role off a body`);
    }
    expect(offenders).toEqual([]);
  });

  // ---- verified against both issuers ----

  it('the group-to-role mapping is exercised against BOTH issuer shapes', () => {
    // §13: the group-to-role mapping is the one behaviour whose INPUT SHAPE
    // differs between the two issuers — Keycloak sends group names, Entra
    // sends security-group object ids — so a suite that only ever sees one
    // of them is evidence about one issuer.
    const roles = codeOf(path.join(ROOT, 'apps/api/test/roles.pg.test.ts'));
    expect(roles).toContain('maps a Keycloak group NAME to a role');
    expect(roles).toContain('maps an Entra group OBJECT ID to a role, through the same code');
    // …and the same lookup for both, rather than a branch per issuer.
    const offenders = API_SOURCES
      .filter(f => /===\s*['"]keycloak['"]|===\s*['"]entra['"]|isEntra|isKeycloak/.test(codeOf(f)))
      .map(rel);
    expect(offenders, 'a per-issuer branch in the API').toEqual([]);
  });

  // ---- document bytes round-trip through Blob; a matter delete purges them ----

  it('the blob round trip uses bytes that survive nothing (0x00 and 0xFF)', () => {
    // A "hello world" payload passes through a UTF-8 round trip that would
    // corrupt every real document in the firm. These two bytes are the ones
    // that catch it.
    const blob = codeOf(path.join(ROOT, 'apps/api/test/blobStore.compose.test.ts'));
    expect(blob).toMatch(/0x00/);
    expect(blob).toMatch(/0xFF/i);
    expect(blob).toContain('byte-identical');
  });

  it('the cascade suite deletes real blobs and reports a survivor rather than a 204', () => {
    const cascade = codeOf(path.join(ROOT, 'apps/api/test/cascade.compose.test.ts'));
    expect(cascade).toContain('removes both documents rows and both blobs from real Azurite');
    // The half that matters most: a delete that could NOT remove a blob must
    // say so, because a 204 over bytes still held makes the README's own
    // promise false in the one direction nobody would notice.
    expect(cascade).toContain('reports the delete as failed when a blob could NOT be removed');
  });

  it('the blob key is derived in exactly one place', () => {
    // Six defects in sub-project C came from a key derived inline. A blob
    // key built twice is a blob a delete cascade cannot find: the row goes,
    // the bytes stay, and every screen agrees the document is gone.
    const holders = [...API_SOURCES, ...WEB_SOURCES, ...CORE_SOURCES]
      .filter(f => /workspace\/\$\{|`workspace\//.test(codeOf(f)))
      .map(rel);
    expect(holders).toEqual(['apps/api/src/blob/store.ts']);
  });

  // ---- the uploader moves the owner's data and names what it could not ----

  it('the uploader never assigns `complete`; it is derived from what is in the report', () => {
    const report = codeOf(path.join(ROOT, 'src/lib/upload/report.ts'));
    expect(report).toMatch(/export function seal/);
    expect(report).toMatch(/complete:\s*isComplete\(/);
    const run = codeOf(path.join(ROOT, 'src/lib/upload/run.ts'));
    // `runUpload` must not be able to declare success. If it could, a run
    // that crashed half way could still say "Everything moved".
    expect(run).not.toMatch(/complete:\s*(true|false)/);
  });

  it('the uploader deletes none of the OWNER\'S data, on any path', () => {
    /*
     * §13.1 and "never delete what you cannot read": the local copy is the
     * owner's only copy until the server one is confirmed good, so nothing
     * here may remove the IndexedDB database, an object store's contents, or
     * the v1 `localStorage` templates backup the migration deliberately
     * never deleted.
     *
     * SCOPED TO THE OWNER'S DATA, and that scoping is the finding rather
     * than a relaxation. The first draft of this test forbade
     * `localStorage.removeItem` outright and failed on
     * `forgetUploadComplete`, which removes the UPLOADER'S OWN banner flag —
     * `lexprompt.upload.complete.v1`, a fact about this browser's progress
     * that a person may legitimately want to clear. A guard that cannot tell
     * a bookkeeping key from a person's matters is a guard that gets relaxed
     * to nothing the first time it fires, so it names the three things that
     * actually matter instead.
     */
    const OWNER_DATA = [
      /deleteDB\s*\(|deleteDatabase\s*\(/,          // the whole IndexedDB database
      /\.clear\s*\(\s*\)/,                           // an object store emptied
      /removeItem\s*\(\s*['"`]lexprompt\.templates/, // the v1 templates backup
      /\bdelete\s*\(\s*(?:rec|record|id|key)\b/,     // a record removed by id
    ];
    // Each pattern bites on the thing it names.
    expect(OWNER_DATA[0].test('await deleteDB(DB_NAME)')).toBe(true);
    expect(OWNER_DATA[1].test('await store.clear()')).toBe(true);
    expect(OWNER_DATA[2].test("localStorage.removeItem('lexprompt.templates.v2')")).toBe(true);
    expect(OWNER_DATA[3].test('await store.delete(id)')).toBe(true);
    // …and NOT on the uploader's own banner flag, which is the false
    // positive that produced this list.
    expect(OWNER_DATA.some(p => p.test("localStorage.removeItem(KEY)"))).toBe(false);

    const uploadFiles = WEB_SOURCES.filter(f => rel(f).startsWith('src/lib/upload/')
      || rel(f).startsWith('src/features/upload/'));
    expect(uploadFiles.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const file of uploadFiles) {
      const code = codeOf(file);
      for (const pattern of OWNER_DATA) {
        if (pattern.test(code)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // ---- a precedent is stored, kept apart, and no screen denies it ----

  it('the precedent-promise search still exists, and still searches the test suite', () => {
    // The negative half of §18 item 3 is carried by
    // `src/test/precedentPromise.test.ts`, which scans `src/`, the README
    // AND the test suite. It is not restated here — a second copy of that
    // scanner is exactly the sibling drift this project keeps paying for —
    // but its EXISTENCE and its REACH are asserted, because a deleted guard
    // and a passing guard look identical from here.
    const promise = codeOf(path.join(ROOT, 'src/test/precedentPromise.test.ts'));
    expect(promise).toContain('finds no such claim anywhere under src/');
    expect(promise).toContain('finds no such claim in the README');
    // The test suite is in scope deliberately: a test still asserting the
    // old promise is a test somebody restores by treating red as regression.
    // Asserted through the scanner's own CODE — its self-check that it
    // reaches a test file — rather than through the comment saying it does,
    // which is what a comment-stripped read is for.
    expect(promise).toContain("expect(files).toContain('src/App.redlines.test.tsx')");
    expect(promise).toContain("expect(files).toContain('src/features/redlines/PrecedentIntake.tsx')");
  });

  it('the replacement promise is on the intake screen, from the one module that owns it', () => {
    // The positive half, and it is not decoration: every negative assertion
    // above is satisfied by a screen that says nothing at all about storage,
    // which is worse than the old sentence rather than better — a lawyer
    // choosing a client's marked-up lease, told nothing about where it goes.
    const intake = codeOf(path.join(ROOT, 'src/features/redlines/PrecedentIntake.tsx'));
    expect(intake).toContain('PRECEDENT_STORAGE_PRIVACY');
    const copy = codeOf(path.join(ROOT, 'src/lib/privacyCopy.ts'));
    expect(copy).toMatch(/export const PRECEDENT_STORAGE_PRIVACY/);
    expect(copy).toContain('never offered as something to review');
    // Said ONCE. Two wordings of one promise on one screen has cost this
    // project a defect already.
    const uses = [...WEB_SOURCES]
      .filter(f => /\{PRECEDENT_STORAGE_PRIVACY\}/.test(codeOf(f)))
      .map(rel);
    expect(uses).toEqual(['src/features/redlines/PrecedentIntake.tsx']);
  });

  it('a precedent is refused as a review target and as a collection member, by the API', () => {
    const precedent = codeOf(path.join(ROOT, 'apps/api/test/precedent.pg.test.ts'));
    expect(precedent).toContain('REFUSES a precedent as a review target — not merely absent from a picker');
    expect(precedent).toContain('REFUSES a precedent as a collection member, base or varies');
    expect(precedent).toContain('refuses a precedent by DIRECT id fetch through the matter-document route');
  });

  it('every matter-context document query is held to `kind`, by a scanner over the SQL', () => {
    // §19 names this as the thing to watch, because such a query fails by
    // showing TOO MUCH — another client's precedent where a lawyer expects
    // the deal in hand — and nothing on screen looks wrong.
    const scope = codeOf(path.join(ROOT, 'apps/api/test/workspaceScope.test.ts'));
    expect(scope).toContain('every statement reading `document` in a matter context also names kind');
    // Its own vacuity guard, which is what makes the check above worth
    // anything.
    expect(scope).toContain('finds matter-context document statements at all');
  });

  // ---- credentials: where they are, and where they are not ----

  it('no OpenRouter or provider key survives anywhere (Stage 1 DoD, re-checked)', () => {
    // Re-run rather than inherited. Four dependencies and two stores arrived
    // this stage, and a key pasted into a seed fixture is exactly the shape
    // that slips in.
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      // Raw text, not comment-stripped: a real credential in a comment is a
      // credential in the repository.
      if (/\bsk-or-v1-/.test(readFileSync(file, 'utf8'))) offenders.push(rel(file));
    }
    if (/\bsk-or-v1-/.test(readme())) offenders.push('README.md');
    expect(offenders).toEqual([]);
    expect(/\bsk-or-v1-/.test('sk-or-v1-abc')).toBe(true);
  });

  it('no database or blob credential is READ outside apps/api/src/config.ts', () => {
    /*
     * A READ off the environment, not a MENTION of the key's name.
     *
     * The distinction is the finding: `apps/api/src/blob/credential.ts`
     * names `API_BLOB_CONNECTION_STRING` in the sentence it refuses with —
     * "API_BLOB_CREDENTIAL_SOURCE is connection-string, but
     * API_BLOB_CONNECTION_STRING is …" — and that is the message doing
     * exactly what this project asks of a refusal: naming the key an
     * operator has to fix. A guard that forbade the NAME would force that
     * message to become vaguer, which is the opposite of what it is for. The
     * property that actually matters is that one file resolves these values
     * and everything else is handed them.
     */
    const KEY = /API_DATABASE_URL|API_DATABASE_MIGRATION_URL|API_BLOB_CONNECTION_STRING/;
    /** A line that both names a key AND touches an environment object. */
    const reads = (line: string): boolean => KEY.test(line) && /\benv\b/.test(line);

    // Both shapes `config.ts` actually uses, and neither of the two ways
    // this could pass vacuously.
    expect(reads("    databaseUrl: required(env, 'API_DATABASE_URL'),")).toBe(true);
    expect(reads('    connectionString: env.API_BLOB_CONNECTION_STRING,')).toBe(true);
    expect(reads("      'API_BLOB_CONNECTION_STRING is not set.',")).toBe(false);
    expect(reads('const port = int(env, "API_PORT", 8080);')).toBe(false);

    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      if (rel(file) === 'apps/api/src/config.ts') continue;
      for (const line of codeOf(file).split(/\r?\n/)) {
        if (reads(line)) offenders.push(`${rel(file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);

    // The one permitted file really does resolve all three, so the absence
    // above is a boundary rather than a pattern that matches nothing.
    const configLines = codeOf(path.join(ROOT, 'apps/api/src/config.ts')).split(/\r?\n/);
    for (const key of ['API_DATABASE_URL', 'API_DATABASE_MIGRATION_URL',
      'API_BLOB_CONNECTION_STRING']) {
      expect(configLines.some(l => l.includes(key) && /\benv\b/.test(l)), key).toBe(true);
    }
  });

  it('the gateway holds no database or blob credential, and no client for either', () => {
    /*
     * §5: "no database credential, no Blob credential and no read path to
     * either, so compromising it yields the calls in flight and never the
     * archive." A dependency is the shape this would arrive in, and it would
     * arrive looking reasonable — a gateway that could write its own audit
     * rows, say. §12 Q3 is explicit that the stdout call log and
     * `audit_event` are two logs and must stay two.
     */
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps/gateway/package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.length).toBeGreaterThan(2);
    for (const forbidden of ['pg', '@azure/storage-blob', 'postgres', 'knex', 'drizzle-orm']) {
      expect(deps, forbidden).not.toContain(forbidden);
    }
    for (const file of GATEWAY_SOURCES) {
      expect(codeOf(file), rel(file)).not.toMatch(/API_DATABASE|API_BLOB_|BlobServiceClient|from 'pg'/);
    }
  });

  it('exactly one file constructs a database pool, and one file constructs a blob client', () => {
    /*
     * The counterpart presence, so the absences above are a boundary rather
     * than an empty tree.
     *
     * `new Pool(` rather than `makePool`: `main.ts` CALLS `makePool` twice —
     * once for the app role, once for the migrator — and that is the
     * composition root doing its job, handing a resolved DSN to a factory.
     * What must exist in one place is the CONSTRUCTION, so that "which
     * client, with which options" is one decision. The first draft of this
     * test matched the caller too and reported `main.ts` as an offender,
     * which would have been an argument for hiding a legitimate call rather
     * than for anything real.
     */
    const poolHolders = ALL_SOURCES.filter(f => /new Pool\(/.test(codeOf(f))).map(rel);
    expect(poolHolders).toEqual(['apps/api/src/db/pool.ts']);
    const blobHolders = ALL_SOURCES.filter(f => /new BlobServiceClient\(|BlobServiceClient\.fromConnectionString/
      .test(codeOf(f))).map(rel);
    expect(blobHolders).toEqual(['apps/api/src/blob/store.ts']);
  });

  // ---- R-G1 binds until the mechanism is real ----

  it('no collaborative affordance shipped AHEAD OF ITS MECHANISM (R-G1)', () => {
    /*
     * R-G1's rule was never "no collaboration"; it was that an affordance
     * lands only where the mechanism behind it is real. Stage 4 made two of
     * them real and this guard moved with them rather than being deleted:
     *
     *  - **PRESENCE is real as of Task 22/23.** A roster is broadcast over
     *    the socket, expires on a TTL, and is rendered on the review screen
     *    and on the clause a colleague has selected. So `presence` is no
     *    longer a forbidden word in `src/`, and the words that WERE
     *    forbidden as its stand-ins go with it.
     *  - **ASSIGNMENT's mechanism is Task 24's and its Stage 4 surface is
     *    Task 25's**, but the CHIP and the "assigned to me" COUNTER are
     *    Stage 5 (S18) — cross-matter aggregations over a mechanism that now
     *    exists. Those two strings stay forbidden here, and that is now the
     *    whole of what this test forbids.
     *
     * The other half is unchanged and is the one that was always doing the
     * work: no `.tsx` may name `assigneeId`. A field carried through a data
     * structure is invisible; a field a component renders is an affordance.
     *
     * Stage 2 introduced real accounts, and the temptation that arrives with
     * them is an assignee chip.
     *
     * `assigneeId` WAS the awkward case, and S17's promise has been kept:
     * **Stage 3 Task 22 retired the field.** `Verification` no longer
     * declares it, `applyVerification` no longer carries it across a state
     * change, `resetVerification` takes no argument because that was the
     * only thing it carried, and `reviewMigration` DROPS it off a legacy
     * record rather than reading it through. Not a discard — Task 6's
     * migration report names every finding that carried a non-empty value,
     * and the frozen `review.findings` blob still holds them all (P18).
     *
     * ONE carrier is left and it is a different kind of thing: the
     * uploader's attribution rewrite, which walks an uploaded record's raw
     * JSON and rewrites every key naming a person. That code reads DATA, not
     * the type — an uploaded review exported before this change still has
     * the key in it, and leaving exactly one dangling local id behind on the
     * argument that nobody is looking is the argument that stops being true
     * the moment somebody does.
     *
     * The rule is therefore: **no `.tsx` may name it at all.** A field
     * carried through a data structure is invisible; a field a component
     * renders is an affordance. Each carrier is asserted to still name it,
     * so an exemption that has outlived its reason shows up here rather than
     * sitting inert — which is the failure mode `SCAN_EXEMPT` being empty
     * exists to avoid.
     */
    const ASSIGNEE_CARRIERS = [
      // The list was four (the type, the two verification helpers, the
      // legacy-record reader, the uploader's attribution rewrite). Stage 3
      // Task 22 retired the field and the first three stopped carrying it.
      // Shrinking this list is the point of the "every carrier still carries
      // it" assertion below: a stale exemption is an exemption nobody
      // re-reads.
      'src/lib/upload/attribution.ts',
    ];
    const ASSIGNEE = /\bassigneeId\b|\bassignedTo\b/;
    // STAGE 5'S TWO SURFACES, and no longer presence's stand-ins.
    //
    // The word boundaries are not decoration: without the leading `\b` this
    // pattern matched `ClausePresence` — the Task 23 component — through the
    // `usePresence` inside `ClaUSEPRESENCE`, and reported the shipped
    // presence marker as a forbidden hook. A scanner that fires on a
    // substring of an unrelated identifier is one that gets relaxed until it
    // stops biting.
    const AFFORDANCE = /assign(ed)?[- ]?to[- ]?me|\bassignedToMe\b|\bassigneeChip\b/i;
    expect(ASSIGNEE.test('const x = f.assigneeId')).toBe(true);
    expect(AFFORDANCE.test('const n = assignedToMe.length')).toBe(true);
    // …and it does NOT fire on the presence component's own name, which is
    // the false positive the boundaries above exist for.
    expect(AFFORDANCE.test('export function ClausePresence() {}')).toBe(false);

    const offenders: string[] = [];
    for (const file of [...WEB_SOURCES, ...CORE_SOURCES]) {
      const code = codeOf(file);
      const name = rel(file);
      if (AFFORDANCE.test(code)) offenders.push(`${name} names a collaboration affordance`);
      if (!ASSIGNEE.test(code)) continue;
      // A component naming it is a screen offering it.
      if (name.endsWith('.tsx')) offenders.push(`${name} renders an assignee field`);
      else if (!ASSIGNEE_CARRIERS.includes(name)) {
        offenders.push(`${name} uses an assignee field and is not a declared carrier`);
      }
    }
    expect(offenders.sort()).toEqual([]);

    // Every carrier still exists and still carries it. A stale exemption is
    // an exemption nobody re-reads.
    for (const carrier of ASSIGNEE_CARRIERS) {
      const full = path.join(ROOT, carrier);
      expect(existsSync(full), carrier).toBe(true);
      expect(ASSIGNEE.test(codeOf(full)), `${carrier} no longer names it`).toBe(true);
    }
  });

  it('nothing derives a human judgement — the engine writes only `unchecked()`', () => {
    // The rule the whole verification model rests on, re-checked at the
    // stage that gave verifications a real author for the first time.
    // The extractors moved to `packages/core` in Stage 3 Task 3 so the worker
    // can run them. That makes this check MORE load-bearing, not less: the
    // same two functions now decide what a verification starts as in two
    // processes, and `existsSync` is asserted first so a later move renames
    // this guard's target rather than quietly deleting it.
    for (const file of ['packages/core/src/review/extractClause.ts',
      'packages/core/src/review/extractCollectionClause.ts']) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      const code = codeOf(path.join(ROOT, file));
      expect(code, file).toContain('unchecked()');
      expect(code, file).not.toMatch(/state:\s*'verified'|state:\s*'flagged'|state:\s*'rejected'/);
    }
  });

  // ---- the README, which is where an honest account has to survive ----

  it('the README says plainly that nothing past sign-in has been driven in a browser', () => {
    /*
     * The largest gap in this stage, and the one most likely to be quietly
     * dropped by a later edit tidying up an uncomfortable paragraph. Two of
     * this project's worst defects — a review screen showing zero documents,
     * and a failed review becoming permanently unopenable — were invisible
     * to thousands of passing tests and appeared only against the real app.
     * A README that stops saying so is a README that implies otherwise.
     */
    const text = readme();
    expect(text).toContain('No credentials were entered');
    expect(text).toMatch(/has ever been watched in a browser|never been watched in a browser/);
    expect(text).toContain('This has not been deployed');
    // The four things the tests cover and no browser has looked at, named
    // individually so a tidy-up cannot shorten the list to one example.
    for (const unwatched of ['the four seeded accounts', 'data to the server',
      'precedent document', 'evidence panel']) {
      expect(text.toLowerCase(), unwatched).toContain(unwatched.toLowerCase());
    }
    // …and no sentence claiming the opposite.
    expect(text).not.toMatch(/verified end to end in a browser/i);
  });

  it('the README describes the two stores, and answers "what is stored, and where"', () => {
    const text = readme();
    expect(text).toContain('## The services, and the two stores');
    expect(text).toContain('### What is stored, and where');
    // §11.1's retention question (§17 Q3) is OPEN, and the README says so
    // rather than implying an answer.
    expect(text).toMatch(/How long precedent documents are kept is your firm's decision/);
    // The section it replaced said the opposite in its first clause.
    expect(text).not.toContain('## No database yet');
    expect(text).not.toContain('There are three services, and none of them is a database');
    expect(text).not.toContain('No backend, no server-side anything');
  });
});
