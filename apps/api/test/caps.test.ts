import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';
import {
  ConfigError, assertBackoffOutlivedByHeartbeat, assertImagesFitTheBody, assertLeaseOutlastsCell,
  assertPresenceOutlivesBeat, assertWorkerPoolFits,
  describeConfig, loadConfig,
} from '../src/config.ts';

/**
 * EVERY CAP IS DECLARED, AND EVERY DECLARED CAP IS READ.
 *
 * Three undeclared-cap defects have been found in this repository, all on the
 * scanned-document path: Fastify's `bodyLimit`, nginx's
 * `client_max_body_size`, busboy's `fieldSize`. Every one was a library
 * default nobody had written down, and every one surfaced as a request that
 * failed with a message naming no key anybody could change.
 *
 * A queue adds more, and worse ones — a lease that is too short answers a
 * clause twice, a heartbeat that is too slow reaps a healthy run, a worker
 * pool that is too small makes a run crawl for a reason no value states.
 * This suite is what makes the fourth defect of that family loud.
 *
 * Two halves, and both are needed. A cap DECLARED and never read is a knob an
 * operator turns and then trusts; a cap READ and never declared is the
 * original defect. And the caps that constrain EACH OTHER are checked at
 * load, because two values an operator chose that contradict each other is a
 * configuration fault and not a runtime surprise.
 */

/**
 * The complete list, written out rather than derived from `config.ts`.
 *
 * Deriving it from the module would make this test agree with whatever the
 * module happens to say, which is the shape of a test that cannot fail: a cap
 * deleted from `config.ts` would vanish from the derived list too and the
 * suite would stay green. A literal list is the only version of this check
 * that notices a removal.
 */
const DECLARED = [
  'API_RUN_CELL_TIMEOUT_MS', 'API_RUN_LEASE_MS', 'API_RUN_HEARTBEAT_MS',
  'API_RUN_ATTEMPTS_MAX', 'API_RUN_WORKERS', 'API_RUN_POLL_MS', 'API_RUN_RETRY_BACKOFF_MS',
  'API_WORKSPACE_RUN_CONCURRENCY', 'API_PARSE_WORKERS',
  'API_PARSE_TIMEOUT_MS', 'API_PARSE_STUCK_REPORT_MS',
  'API_PAGE_RENDER_TIMEOUT_MS', 'API_PAGE_IMAGE_MAX_PAGES', 'API_PAGE_IMAGE_LRU_BYTES',
  'API_RUN_IMAGE_BYTES_MAX', 'API_WORKER_POOL_MAX',
  'API_EVENT_RETENTION_DAYS', 'API_EVENT_PAGE_MAX',
  // Stage 4's live transport. `API_WS_PING_MS` is the one with a
  // relationship outside this file -- it must stay below nginx's
  // proxy_read_timeout on the socket location and below Container Apps'
  // ingress idle timeout -- and `API_HUB_TICK_MS` is the floor live change
  // degrades to when the LISTEN connection has dropped, which is a silent
  // failure and therefore exactly the kind that needs a declared number.
  'API_WS_PING_MS', 'API_WS_MAX_CONNECTIONS', 'API_WS_MAX_SUBSCRIPTIONS',
  'API_WS_MAX_FRAME_BYTES', 'API_HUB_TICK_MS',
  // Presence (Task 22). The TTL is the number that keeps this feature
  // honest -- a roster entry outliving it claims a colleague is present who
  // is not -- and the heartbeat is the interval the server ASKS the browser
  // for, on the `hello` frame, so the two cannot be set independently in two
  // places. `assertPresenceOutlivesBeat` refuses a pair that would expire
  // everybody between beats.
  'API_PRESENCE_HEARTBEAT_MS', 'API_PRESENCE_TTL_MS',
  // Stage 5's cross-matter inbox. The ceiling a counter renders `200+`
  // against -- an undeclared one here would be a number a lawyer's queue
  // stopped at with nothing on screen saying so.
  'API_ASSIGNMENT_INBOX_LIMIT',
  // The firm-wide search's per-arm ceiling. Per SOURCE rather than overall,
  // because a capped arm is reported by name -- an overall cap would starve
  // whichever arm finished last with nothing on screen saying which.
  'API_SEARCH_LIMIT_PER_SOURCE',
  // The workspace audit extract's per-source ceiling. The ONE cap in this
  // list that REFUSES rather than truncating: an evidence file whose rows
  // stop at a number nobody stated has gaps that read as absences of
  // activity.
  'API_AUDIT_EXPORT_MAX_ROWS',
];

/** `API_RUN_LEASE_MS` -> `runLeaseMs`, the naming `config.ts` uses without
 *  exception. A cap whose field is named something else is a cap this scan
 *  cannot follow, which is a reason to rename the field rather than to relax
 *  the scan. */
export function fieldNameFor(name: string): string {
  return name
    .replace(/^API_/, '')
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const CONFIG = path.join(ROOT, 'apps/api/src/config.ts');

/** Every shipped source file in `apps/api/src` except the config module —
 *  the files that have to READ what the config module declares. */
function allSourceExceptConfig(): string[] {
  return walk(path.join(ROOT, 'apps/api/src'))
    .filter(f => f !== CONFIG)
    .map(f => codeOf(f));
}

const BASE: NodeJS.ProcessEnv = {
  API_ISSUER: 'https://issuer.example/realms/lexprompt',
  API_AUDIENCE: 'lexprompt-api',
  API_GATEWAY_URL: 'https://gateway:8081',
  API_WORKSPACE_ID: '00000000-0000-0000-0000-000000000001',
  API_DATABASE_URL: 'postgres://lexprompt_app:pw@postgres:5432/lexprompt',
  API_DATABASE_MIGRATION_URL: 'postgres://lexprompt_migrator:pw@postgres:5432/lexprompt',
  API_WORKER_DATABASE_URL: 'postgres://lexprompt_worker:pw@postgres:5432/lexprompt',
  API_ROLE_MAPPINGS: 'https://issuer.example/realms/lexprompt|reviewers|reviewer',
  API_BLOB_CREDENTIAL_SOURCE: 'connection-string',
  API_BLOB_CONNECTION_STRING: 'UseDevelopmentStorage=true',
};

describe('every declared cap has a reader, and every reader has a declaration', () => {
  it('reads a realistic number of source files (a scan of nothing passes vacuously)', () => {
    const rest = allSourceExceptConfig();
    expect(rest.length).toBeGreaterThan(30);
    // …and the scan is reading CODE, not prose about code: `config.ts` is
    // excluded, so a cap that appears only in another file's comment must
    // not count as a reader.
    expect(rest.some(f => f.includes('runLeaseMs'))).toBe(true);
  });

  it('converts an environment name to the field name config.ts uses', () => {
    expect(fieldNameFor('API_RUN_CELL_TIMEOUT_MS')).toBe('runCellTimeoutMs');
    expect(fieldNameFor('API_WORKSPACE_RUN_CONCURRENCY')).toBe('workspaceRunConcurrency');
    expect(fieldNameFor('API_EVENT_PAGE_MAX')).toBe('eventPageMax');
    expect(fieldNameFor('API_ASSIGNMENT_INBOX_LIMIT')).toBe('assignmentInboxLimit');
  });

  it('gives every declared cap a reader in the shipped source', () => {
    const config = codeOf(CONFIG);
    const rest = allSourceExceptConfig();
    for (const name of DECLARED) {
      expect(config, `${name} is not read in config.ts`).toContain(name);
      const field = fieldNameFor(name);
      expect(rest.some(f => f.includes(field)), `${field} is declared and never used`).toBe(true);
    }
  });

  it('gives every worker loop a declared TIMEOUT, which is the direction this suite was missing', () => {
    /*
     * THE SECOND DIRECTION, and it was named in the describe title and never
     * written. "Every declared cap has a reader" was the only half that
     * existed, so the missing-parse-timeout defect — the fourth in the
     * family this suite's preamble names, on the same scanned-document path
     * — was invisible to the suite written to catch exactly it.
     *
     * A general "no numeric literal acts as a bound" scan is not writeable
     * without a pile of exemptions. This is the specific shape that has
     * actually gone wrong twice: a loop that claims a unit of work and does
     * it, with nothing bounding how long the doing may take. The parse
     * worker had no timeout, no attempt counter and no reaper, and one slow
     * document at the head of a single-slot FIFO blocked every upload in the
     * deployment while the only reachable message said "try again in a
     * moment".
     */
    const loops = walk(path.join(ROOT, 'apps/api/src'))
      .filter(f => /while\s*\(running\)/.test(codeOf(f)));
    // The sanity check: the scan finds the loops it is about. A pattern that
    // matched nothing would pass this test with every bound removed.
    expect(loops.map(rel).sort()).toEqual([
      'apps/api/src/parse/parseWorker.ts',
      'apps/api/src/run/worker.ts',
    ]);
    const timeouts = DECLARED.filter(n => /_TIMEOUT_MS$/.test(n)).map(fieldNameFor);
    expect(timeouts.length).toBeGreaterThan(0);
    for (const file of loops) {
      const code = codeOf(file);
      expect(
        timeouts.some(field => code.includes(field)),
        `${rel(file)} claims work in a loop and names no declared timeout, so nothing bounds how `
        + 'long one unit of it may take',
      ).toBe(true);
    }
  }, 20_000);

  it('names each cap in the boot banner, so an operator can read what is in force', () => {
    /*
     * THIS CHECKED FIFTEEN SUBSTRINGS AND SAID "EACH CAP" (cross-stage seam
     * review, m2).
     *
     * The fragment list was hand-written and ended at Stage 4's
     * `'Presence: heartbeat'`. Stage 5's three caps — the inbox limit, the
     * per-source search ceiling and the audit export's refusal threshold —
     * were declared, were read, and WERE printed, and this test would not
     * have noticed if they were not: deleting
     * `Search: at most … hit(s) per source` from `describeConfig` left it
     * green. A test whose title says "each" and whose body says "these
     * fifteen" is a list somebody has to remember to extend, which is the
     * same failure `importBoundary` had one directory over.
     *
     * So the completeness half is DERIVED: every declared cap's VALUE must
     * appear in the banner. `DECLARED` itself is still the hand-written
     * literal it has always been (a derived list could not notice a removal
     * — see its own docstring), so this stays a check of the module against
     * a ledger rather than against itself.
     *
     * The env below gives five caps that share a default a distinct value.
     * Without it, `API_SEARCH_LIMIT_PER_SOURCE` (20) would be "found" in the
     * banner by `API_WS_MAX_SUBSCRIPTIONS`'s 20, and the scan would pass over
     * a cap that had stopped being printed — a check satisfied by a
     * coincidence, which is the shape of the defect this suite exists for.
     */
    const DISTINCT: NodeJS.ProcessEnv = {
      ...BASE,
      API_PARSE_STUCK_REPORT_MS: '300001',
      API_PRESENCE_TTL_MS: '15001',
      API_HUB_TICK_MS: '1001',
      API_WS_MAX_CONNECTIONS: '501',
      API_SEARCH_LIMIT_PER_SOURCE: '21',
    };
    const cfg = loadConfig({ ...DISTINCT });
    const values = new Map<string, string>();
    for (const name of DECLARED) {
      values.set(name, String((cfg as unknown as Record<string, unknown>)[fieldNameFor(name)]));
    }
    // The scan cannot be satisfied by a coincidence: no two caps share a
    // value, so a value found in the banner was printed by ITS cap.
    expect(new Set(values.values()).size, 'two caps share a value, so one could vanish from '
      + 'the banner and be "found" by the other').toBe(DECLARED.length);

    const text = describeConfig(cfg);
    const unprinted = [...values]
      .filter(([, value]) => !text.includes(value))
      .map(([name, value]) => `${name} = ${value}`);
    expect(unprinted, 'declared caps the boot banner does not print — an operator has to read '
      + 'the source to discover them').toEqual([]);

    // The SECTIONS, still named, because a number printed with no label
    // answers nothing. The banner is where "why is this run crawling" gets
    // answered.
    for (const fragment of [
      'Run queue:', 'worker(s)', 'lease ', 'heartbeat ', 'attempt(s)',
      'cell(s) per workspace', 'Events: kept', 'Page rendering:', 'Engine:',
      'Live socket: ping', 'fan-out tick', 'connection(s) per replica',
      'retry backoff ', 'Presence: heartbeat', 'believed for',
      'Inbox:', 'Search:', 'Audit export:',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    // …and never a password, on either DSN.
    expect(text).not.toContain('pw@');
  });
});

describe('the caps that constrain each other are checked at load, not at runtime', () => {
  it('refuses a worker pool too small for the slots it must serve', () => {
    expect(() => loadConfig({ ...BASE, API_RUN_WORKERS: '8', API_WORKER_POOL_MAX: '4' }))
      .toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, API_RUN_WORKERS: '8', API_WORKER_POOL_MAX: '4' }))
      .toThrow(/API_WORKER_POOL_MAX/);
    // …and accepts one that fits: 8 run slots + 1 parse slot + 1 headroom.
    expect(loadConfig({ ...BASE, API_RUN_WORKERS: '8', API_WORKER_POOL_MAX: '10' }).runWorkers)
      .toBe(8);
  });

  it('refuses a lease that does not outlast the cell it covers', () => {
    // The failure this prevents is silent: the first worker's write is
    // abandoned (it re-reads the lease), so the run simply takes twice as
    // long and costs twice as much, with nothing anywhere saying why.
    expect(() => loadConfig({
      ...BASE, API_RUN_LEASE_MS: '60000', API_RUN_CELL_TIMEOUT_MS: '60000',
    })).toThrow(/API_RUN_LEASE_MS/);
    expect(loadConfig({
      ...BASE, API_RUN_LEASE_MS: '61000', API_RUN_CELL_TIMEOUT_MS: '60000',
    }).runLeaseMs).toBe(61_000);
  });

  it('refuses an image budget that cannot fit in the body that carries it', () => {
    expect(() => loadConfig({
      ...BASE, API_MAX_BODY_BYTES: '2000000', API_RUN_IMAGE_BYTES_MAX: '4000000',
    })).toThrow(/API_RUN_IMAGE_BYTES_MAX/);
  });

  it('DERIVES the image budget from the body limit, so lowering one is enough', () => {
    // The reason the check above does not make a smaller body limit
    // unusable: an operator who lowers `API_MAX_BODY_BYTES` and has never
    // heard of the image key must still be able to start.
    const cfg = loadConfig({ ...BASE, API_MAX_BODY_BYTES: '2000000' });
    expect(cfg.runImageBytesMax).toBe(1_500_000);
    expect(() => assertImagesFitTheBody(cfg)).not.toThrow();
  });

  it('refuses a retry backoff the reaper would sweep a healthy run out from under', () => {
    /*
     * M10. A cell parked after a retryable 429/5xx keeps `state = 'leased'`
     * and clears `leased_by`, and the worker pool's `active` set — the runs
     * it heartbeats for — is built from `leased_by like '<workerId>#%'`. So
     * a run whose in-flight cells are ALL parked stops heartbeating for the
     * length of the backoff, and the reaper calls a run dead after three
     * missed intervals.
     *
     * At the defaults this survives by fifteen seconds, which nobody chose.
     * `API_RUN_RETRY_BACKOFF_MS=60000` — the exact answer that key's own
     * docstring invites for a per-minute rate limiter — reaped every
     * rate-limited run as `failed` with "This run stopped without finishing"
     * while it was doing precisely what it was configured to do.
     */
    expect(() => loadConfig({
      ...BASE, API_RUN_RETRY_BACKOFF_MS: '60000', API_RUN_HEARTBEAT_MS: '15000',
    })).toThrow(/API_RUN_RETRY_BACKOFF_MS/);
    // Equality races the sweep, and a race is not a margin.
    expect(() => loadConfig({
      ...BASE, API_RUN_RETRY_BACKOFF_MS: '45000', API_RUN_HEARTBEAT_MS: '15000',
    })).toThrow(ConfigError);
    // …and the repair the message names actually works, in both directions.
    expect(loadConfig({
      ...BASE, API_RUN_RETRY_BACKOFF_MS: '44000', API_RUN_HEARTBEAT_MS: '15000',
    }).runRetryBackoffMs).toBe(44_000);
    expect(loadConfig({
      ...BASE, API_RUN_RETRY_BACKOFF_MS: '60000', API_RUN_HEARTBEAT_MS: '30000',
    }).runRetryBackoffMs).toBe(60_000);
    // The defaults pass, which is what makes the refusal about the operator's
    // values rather than about the check being impossible to satisfy.
    expect(() => loadConfig({ ...BASE })).not.toThrow();
  });

  it('refuses a presence TTL that would expire everybody between heartbeats', () => {
    // The failure is not an outage and nobody would report it as one: every
    // colleague appears, vanishes and reappears on a cycle, which reads as
    // people opening and closing the review. A reader who learns to distrust
    // the roster has lost the whole feature while the app looks fine.
    expect(() => loadConfig({
      ...BASE, API_PRESENCE_HEARTBEAT_MS: '10000', API_PRESENCE_TTL_MS: '11000',
    })).toThrow(/API_PRESENCE_TTL_MS/);
    // …and the repair the message names works.
    expect(loadConfig({
      ...BASE, API_PRESENCE_HEARTBEAT_MS: '10000', API_PRESENCE_TTL_MS: '15000',
    }).presenceTtlMs).toBe(15_000);
    // The defaults pass, so the refusal is about an operator's values rather
    // than about a check nothing can satisfy.
    expect(() => loadConfig({ ...BASE })).not.toThrow();
  });

  it('each assertion is reachable on its own, so a caller can be checked in isolation', () => {
    const cfg = loadConfig({ ...BASE });
    expect(() => assertWorkerPoolFits({ ...cfg, runWorkers: 99 })).toThrow(ConfigError);
    expect(() => assertLeaseOutlastsCell({ ...cfg, runCellTimeoutMs: cfg.runLeaseMs }))
      .toThrow(ConfigError);
    expect(() => assertImagesFitTheBody({ ...cfg, runImageBytesMax: cfg.maxBodyBytes }))
      .toThrow(ConfigError);
    expect(() => assertBackoffOutlivedByHeartbeat({ ...cfg, runRetryBackoffMs: 10 * 60_000 }))
      .toThrow(ConfigError);
    expect(() => assertPresenceOutlivesBeat({ ...cfg, presenceTtlMs: cfg.presenceHeartbeatMs }))
      .toThrow(ConfigError);
  });
});

describe('the engine has its own database role, and there is no way around it', () => {
  it('refuses to start with no worker DSN rather than reusing the app role', () => {
    const env = { ...BASE };
    delete env.API_WORKER_DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    // The message has to say WHY, not just which key: the repair somebody
    // reaches for is to point it at API_DATABASE_URL, and that silently
    // gives the engine back the grants 006 revoked.
    expect(() => loadConfig(env)).toThrow(/API_DATABASE_URL/);
    expect(() => loadConfig(env)).toThrow(/finding_disposition/);
  });

  it('nothing in the shipped source falls back to the app connection for the worker', () => {
    // The mutation this exists for: replace `config.databaseWorkerUrl` in
    // `main.ts` with `config.databaseUrl` and confirm this fails. A run would
    // still work, every test would still pass, and the guarantee would be
    // gone.
    const main = codeOf(path.join(ROOT, 'apps/api/src/main.ts'));
    expect(main).toContain('config.databaseWorkerUrl');
    // The worker pool is built from the worker URL and from nothing else.
    const workerPool = /makePool\(\s*config\.databaseWorkerUrl/.test(main);
    expect(workerPool, 'the engine pool is not built from API_WORKER_DATABASE_URL').toBe(true);
  });

  it('the worker holds no grant on either disposition table, in the migrations', () => {
    // Read from the SQL rather than from a comment about the SQL. §14: the
    // grant is the guarantee, not the behaviour — and every migration in
    // this project explains its grants at length in `--` comments, so a scan
    // over the raw text finds the sentence saying the worker holds NO grant
    // on `finding_disposition` and reports it as a grant. Comments are
    // stripped first, for the same reason `codeOf` strips TypeScript's: a
    // scanner that cannot tell a statement from a sentence about one gets
    // relaxed until it stops biting.
    const dir = path.join(ROOT, 'apps/api/migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    const sql = files
      .map(f => readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, ''))
      .join('\n');
    // The strip keeps the statements and drops the prose.
    expect(sql).toContain('grant select, insert, update on finding to lexprompt_worker');
    expect(sql).not.toContain('the grant is the guarantee');
    // A grant of any kind on either table to the worker role, on one line.
    const OFFENDING = /grant[^;]*\bon\b[^;]*finding_disposition[^;]*lexprompt_worker/i;
    expect(OFFENDING.test(sql), 'a migration grants the worker a disposition table').toBe(false);
    // …and the scan bites: the same pattern over a line that DOES grant one.
    expect(OFFENDING.test(
      'grant select, insert on finding_disposition to lexprompt_worker;')).toBe(true);
    // The explicit revoke is still there.
    expect(sql).toMatch(
      /revoke all on finding_disposition, finding_disposition_event from lexprompt_worker/);
  });
});

describe('the source files this suite names still exist', () => {
  it('names apps/api/src/config.ts and it is there', () => {
    expect(rel(CONFIG)).toBe('apps/api/src/config.ts');
    expect(codeOf(CONFIG).length).toBeGreaterThan(1000);
  });
});
