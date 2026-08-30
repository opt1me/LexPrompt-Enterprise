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

function cleanup(): void {
  sql(`delete from event where review_id = '${REVIEW}'`);
  sql(`delete from run where review_id = '${REVIEW}'`);
  sql(`delete from review where id = '${REVIEW}'`);
  sql(`delete from document where id = '${DOC}'`);
  sql(`delete from matter where id = '${MATTER}'`);
}

function seed(): void {
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
