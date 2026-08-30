import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * §18 item 4's first clause: *"a run survives a worker restart mid-run and
 * completes"* — and it is not a claim a unit test can make.
 *
 * Everything here happens in the REAL containers: the api's own worker pool,
 * the real gateway over mTLS, the real Postgres. The api is restarted while
 * cells are in flight, and the run has to finish anyway.
 *
 * ## Why the run is seeded with SQL rather than created over HTTP
 *
 * `POST /v1/reviews/:id/runs` needs a bearer token, and the shipped Keycloak
 * realm has `directAccessGrantsEnabled: false` — deliberately, so the only
 * way to a token is the authorisation-code flow, which needs a browser.
 * Browser automation is unavailable in this environment. So this file seeds
 * the state that route leaves behind — a run, its cells, a `pending` finding
 * each — and tests the half the route does not do, which is the half this
 * task is about. `runQueue.pg.test.ts` proves the route produces exactly
 * this state, over the real SQL.
 *
 * `*.compose.test.ts` is excluded from `npm test` (it shells out to `docker
 * compose`, and the default gate must stay green with no Docker daemon at
 * all). Requires `npm run compose:up`.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const REVIEW = 'compose-restart-review';
const RUN = 'compose-restart-run';
const MATTER = 'compose-restart-matter';
const DOC = 'compose-restart-doc';
/** Enough cells that the run cannot finish before the restart lands. The
 *  gateway's own per-workspace rate limit (60/minute) is what makes this
 *  take minutes rather than seconds, and that is realistic rather than
 *  awkward: a real review of a long playbook meets the same limiter. */
const CELLS = 150;

/**
 * No `--env-file`, matching every other `*.compose.test.ts` here. Safe for
 * one reason: nothing in this file builds, recreates or `up`s anything — it
 * `exec`s into already-running containers and restarts one. `docker compose
 * up --build` is where an `--env-file` is mandatory.
 */
function compose(args: string[], timeoutMs = 60_000): string {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8', timeout: timeoutMs,
  });
}

/** One statement on the migrator connection, inside the postgres container.
 *  `-A -t` so the output is the value and nothing else. */
function sql(statement: string): string {
  return compose([
    'exec', '-T', 'postgres',
    'psql', '-U', 'lexprompt_migrator', '-d', 'lexprompt', '-A', '-t', '-c', statement,
  ]).trim();
}

const CLAUSES = Array.from({ length: CELLS }, (_, i) => `c${i + 1}`);

const SNAPSHOT = JSON.stringify({
  id: 'compose-v1', playbookId: 'compose-p1', version: 1, name: 'Restart',
  contractType: 'Assured shorthold tenancy',
  systemPrompt: 'You are a solicitor reviewing an assured shorthold tenancy.',
  formatPrompt: 'Answer strictly as JSON.', changeSummary: '', publishedAt: 1,
  publishedByUserId: 'u', schemaVersion: 7,
  clauses: CLAUSES.map(id => ({ id, title: id, extractPrompt: `What does ${id} say?` })),
});

/**
 * The workspace's settings row as it was BEFORE this test touched it, so it
 * can be put back.
 *
 * Found the hard way: this suite upserts `model_choice_id = 'offline'` and
 * left it there, and `workspaceSettings.pg.test.ts` — which asserts a fresh
 * workspace has no model chosen — then failed three ways in a run that had
 * nothing to do with it. These suites share one committed database, and a
 * test that leaves state behind is a test that breaks a different file's
 * assertions with a message pointing at the wrong feature.
 *
 * `null` means "there was no row", which is restored by deleting the one
 * this test created rather than by writing an empty one — the route creates
 * it lazily, and a row that exists is not the same fact as a row that does
 * not.
 */
let settingsBefore: string | null = null;

function cleanup(): void {
  sql(`delete from event where review_id = '${REVIEW}'`);
  sql(`delete from run where review_id = '${REVIEW}'`);
  sql(`delete from review where id = '${REVIEW}'`);
  sql(`delete from document where id = '${DOC}'`);
  sql(`delete from matter where id = '${MATTER}'`);
  if (settingsBefore === null) {
    sql(`delete from workspace_setting where workspace_id = '${WS}'`);
  } else {
    const [model, concurrency] = settingsBefore.split('|');
    sql(`update workspace_setting
            set model_choice_id = ${model === '' ? 'null' : `'${model}'`},
                concurrency = ${concurrency}
          where workspace_id = '${WS}'`);
  }
}

function seed(): void {
  // Read BEFORE the upsert below, and before `cleanup()` could act on it.
  const held = sql(`select coalesce(model_choice_id, '') || '|' || concurrency
                      from workspace_setting where workspace_id = '${WS}'`);
  settingsBefore = held === '' ? null : held;
  cleanup();
  sql(`insert into matter (id, workspace_id, name, created_at, updated_at)
       values ('${MATTER}', '${WS}', 'Restart', now(), now())`);
  // A document with a healthy text layer, so no blob read and no page render
  // is involved: this test is about the QUEUE surviving a restart, and a
  // scan would make it about the renderer too.
  sql(`insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                             parse_state, byte_size, mime, blob_key, role, added_at)
       values ('${DOC}', '${WS}', 'matter', '${MATTER}', 'lease.txt', 'txt',
               'The term is ten years from 1 January 2020. Rent is 24,000 a year.',
               'parsed', 64, 'text/plain', 'workspace/${WS}/document/${DOC}',
               'standalone', now())`);
  sql(`insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids, target,
                           findings, model_id, started_at)
       values ('${REVIEW}', '${WS}', '${MATTER}', $json$${SNAPSHOT}$json$::jsonb,
               '["${DOC}"]'::jsonb, '{"kind":"documents","documentIds":["${DOC}"]}'::jsonb,
               '{}'::jsonb, 'offline', now())`);
  sql(`insert into workspace_setting (workspace_id, model_choice_id, concurrency)
       values ('${WS}', 'offline', 4)
       on conflict (workspace_id) do update set model_choice_id = 'offline', concurrency = 4`);

  const user = sql(`select id from app_user where workspace_id = '${WS}'
                    order by id limit 1`);
  expect(user, 'no app_user exists — sign in once through the browser first').not.toBe('');
  sql(`insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
       values ('${RUN}', '${REVIEW}', '${WS}', 'queued', '${user}', 4)`);
  const keys = CLAUSES.map(c => `('${RUN}', '${DOC}', '${c}', '${WS}', 'queued')`).join(',');
  sql(`insert into run_cell (run_id, findings_key, clause_id, workspace_id, state) values ${keys}`);
  const findings = CLAUSES.map(c => `('${REVIEW}', '${DOC}', '${c}', '${WS}', 'pending')`).join(',');
  sql(`insert into finding (review_id, findings_key, clause_id, workspace_id, status)
       values ${findings}`);
}

const runState = () => sql(`select state from run where id = '${RUN}'`);
const cellsIn = (state: string) =>
  Number(sql(`select count(*) from run_cell where run_id = '${RUN}' and state = '${state}'`));
const findingsIn = (status: string) =>
  Number(sql(`select count(*) from finding where review_id = '${REVIEW}' and status = '${status}'`));

async function waitFor(
  what: string, ok: () => boolean, timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ok()) return Date.now() - started;
    await new Promise(resolve => { setTimeout(resolve, 1_000); });
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}: `
    + `run=${runState()} queued=${cellsIn('queued')} leased=${cellsIn('leased')} `
    + `done=${cellsIn('done')} error=${cellsIn('error')}`);
}

describe('the run worker, against the real stack', () => {
  beforeAll(() => {
    // A loud failure naming the command that fixes it, rather than a skip: a
    // suite that skips itself reports green while testing nothing.
    const up = compose(['ps', '--services', '--filter', 'status=running']);
    for (const service of ['api', 'gateway', 'postgres']) {
      expect(up.split('\n').map(s => s.trim()), `${service} is not running — run \`npm run compose:up\``)
        .toContain(service);
    }
  });

  it('survives the API being killed mid-run and finishes', async () => {
    seed();
    try {
      // Some done, some still to do.
      const toStart = await waitFor('the first cells to finish', () => cellsIn('done') >= 5,
        120_000);
      const doneBefore = cellsIn('done');
      expect(cellsIn('queued')).toBeGreaterThan(0);

      // A RESTART, not a graceful stop of the pool: this is the container
      // going away with leases held and a heartbeat mid-beat.
      const restartStarted = Date.now();
      compose(['restart', 'api'], 120_000);
      const restartMs = Date.now() - restartStarted;

      const finishMs = await waitFor('the run to finish', () => runState() === 'succeeded',
        420_000);

      // Printed BEFORE the assertions, always. A failure here is a claim
      // about which cell and which finding disagree, and an assertion that
      // says only "expected 11 to be 0" sends the next reader back to the
      // database to find out what the eleven were.
      process.stdout.write(`
runWorker.compose: cells ${sql(
        `select string_agg(state || '=' || n, ' ') from (
           select state, count(*)::text as n from run_cell where run_id = '${RUN}'
           group by state order by 1) s`)}
`);
      process.stdout.write(`runWorker.compose: findings ${sql(
        `select string_agg(status || '=' || n, ' ') from (
           select status, count(*)::text as n from finding where review_id = '${REVIEW}'
           group by status order by 1) s`)}
`);
      process.stdout.write(`runWorker.compose: disagreeing ${sql(
        `select coalesce(string_agg(c.clause_id || ':' || c.state || '/' || f.status, ' '), 'none')
           from run_cell c
           join finding f on f.review_id = '${REVIEW}'
            and f.findings_key = c.findings_key and f.clause_id = c.clause_id
          where c.run_id = '${RUN}'
            and ((c.state in ('done','error') and f.status in ('pending','running'))
                 or (c.state = 'cancelled' and f.status <> 'cancelled'))`)}
`);

      // NOTHING is left in flight, and nothing is left `pending`: "an
      // abandoned run reopening with every cell spinning forever,
      // unfinishable" is the defect this whole task is named after.
      expect(cellsIn('queued')).toBe(0);
      expect(cellsIn('leased')).toBe(0);
      expect(findingsIn('pending')).toBe(0);
      expect(findingsIn('running')).toBe(0);
      // Every cell reached a terminal state, and every finding with it.
      expect(cellsIn('done') + cellsIn('error')).toBe(CELLS);
      expect(findingsIn('done') + findingsIn('error')).toBe(CELLS);
      // The work done BEFORE the restart survived it.
      expect(cellsIn('done')).toBeGreaterThanOrEqual(doneBefore);

      // The invariant between the two state machines, over real rows.
      expect(sql(`select count(*) from run_cell c
                    join run r on r.id = c.run_id
                    join finding f on f.review_id = r.review_id
                     and f.findings_key = c.findings_key and f.clause_id = c.clause_id
                   where c.state = 'done' and f.status in ('pending','running')`)).toBe('0');

      process.stdout.write(
        `\nrunWorker.compose: ${CELLS} cells; ${toStart}ms to the first five, `
        + `${restartMs}ms to restart the api, ${finishMs}ms from restart to succeeded; `
        + `${cellsIn('done')} done, ${cellsIn('error')} error.\n`);
    } finally {
      cleanup();
    }
  }, 600_000);
});
