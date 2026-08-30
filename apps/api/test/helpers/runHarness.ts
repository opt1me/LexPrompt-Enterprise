import { expect } from 'vitest';
import type { AllowedModel, Jurisdiction, ProviderId } from '@lexprompt/core';
import type { Db, Tx } from '../../src/db/pool.ts';
import { dbOn } from './pgHarness.ts';
import { memoryBlobStore, type MemoryBlobStore } from './memoryBlobs.ts';
import { makePageImageCache } from '../../src/parse/hydrate.ts';
import type { BlobStore } from '../../src/blob/store.ts';
import type { GatewayClient } from '../../src/gatewayClient.ts';
import type { RunWorkerCaps, RunWorkerDeps } from '../../src/run/worker.ts';
import type { ParseWorkerDeps } from '../../src/parse/parseWorker.ts';

/**
 * The fixtures the three run suites share — the queue's, the worker's and
 * the lifecycle's.
 *
 * Extracted at the SECOND copy rather than the third (`CLAUDE.md`: "when you
 * find yourself writing a second copy, extract it then", and `uid()` is the
 * cautionary tale about waiting for the seventh). The seeds are the thing
 * most likely to drift: a run fixture whose review has no playbook snapshot,
 * or whose document is `pending`, fails in a way that reads as a defect in
 * the feature.
 */

export const WS = '00000000-0000-0000-0000-000000000001';

export const MODEL: AllowedModel = {
  id: 'test-model',
  provider: 'recorded',
  model: 'recorded/lease-reviewer',
  label: 'Recorded (fixtures)',
  jurisdiction: { bloc: 'other', region: 'local', label: 'Local fixtures' },
  contextLength: 128_000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: true,
};

export interface GatewayLog {
  infer: Record<string, unknown>[];
  models: number;
}

export interface FakeGatewayOptions {
  /** What the model returns as its JSON content, per call. A function so a
   *  test can answer differently per clause. */
  content?: (body: Record<string, unknown>) => string;
  /** Overrides the response envelope's `provider`/`jurisdiction` — the two
   *  fields `run.provider`/`run.jurisdiction` are written from. */
  provider?: ProviderId;
  jurisdiction?: Jurisdiction;
  /** Makes `infer` answer this status instead of 200. */
  status?: number;
  /** Makes `infer` hang until its signal aborts, so a cancel or a cell
   *  timeout can be observed rather than asserted about. */
  hang?: boolean;
  /** Models the gateway lists. Defaults to `[MODEL]`; an empty list is how
   *  "the configured model is not on the allowlist" is reproduced. */
  models?: AllowedModel[];
}

const DEFAULT_CONTENT = JSON.stringify({
  summary: 'The break notice period is six months.',
  citations: ['six months'],
  risk_level: 'Medium',
  risk_analysis: 'A six-month notice period is longer than the market standard.',
});

export function fakeGateway(
  opts: FakeGatewayOptions = {},
): { gateway: GatewayClient; log: GatewayLog } {
  const log: GatewayLog = { infer: [], models: 0 };
  const gateway: GatewayClient = {
    async infer(body: unknown, signal?: AbortSignal) {
      log.infer.push(body as Record<string, unknown>);
      if (opts.hang) {
        // Rejects with an `AbortError` exactly as undici does — which is
        // what both extractors already test for, and therefore the only
        // faithful way to reproduce a cancelled or timed-out call.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('This operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      if (opts.status && opts.status >= 400) {
        return { status: opts.status, json: { error: { code: 'unknown', message: 'no' } } };
      }
      return {
        status: 200,
        json: {
          content: opts.content
            ? opts.content(body as Record<string, unknown>)
            : DEFAULT_CONTENT,
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          callId: 'call-1',
          provider: opts.provider ?? 'recorded',
          jurisdiction: opts.jurisdiction ?? MODEL.jurisdiction,
          stopReason: 'stop',
        },
      };
    },
    async models() {
      log.models += 1;
      return { status: 200, json: { models: opts.models ?? [MODEL] } };
    },
    stream() {
      throw new Error('the run worker does not stream');
    },
  };
  return { gateway, log };
}

export const CAPS: RunWorkerCaps = {
  runWorkers: 1,
  runLeaseMs: 60_000,
  runCellTimeoutMs: 30_000,
  // HIGH ON PURPOSE. The cancel poll and the heartbeat both issue their own
  // queries, and every suite here runs against ONE pinned client inside a
  // rolled-back transaction — `pg` cannot serve two queries on one
  // connection at once. A test that wants to observe a cancellation drives
  // the abort itself rather than waiting for a ticker.
  runHeartbeatMs: 600_000,
  runAttemptsMax: 3,
  runPollMs: 10,
  runRetryBackoffMs: 50,
  workspaceRunConcurrency: 8,
  pageRenderTimeoutMs: 5_000,
  pageImageMaxPages: 10,
  runImageBytesMax: 12_000_000,
};

/**
 * The parse worker's deps, with its two caps at test scale.
 *
 * A helper rather than an object literal at each call site: `parseTimeoutMs`
 * and `parseStuckReportMs` were added because the parse queue shipped with
 * NO bound at all, and six inline literals is how the next cap added to that
 * interface gets a different value in each suite.
 *
 * The timeout is generous (30s) because these suites parse real PDFs on a
 * laptop; a test that wants to see the bound bite passes its own.
 */
export function parseDeps(
  db: Db, blobs: BlobStore, over: Partial<ParseWorkerDeps> = {},
): ParseWorkerDeps {
  return { db, blobs, pollMs: 1, parseTimeoutMs: 30_000, parseStuckReportMs: 300_000, ...over };
}

export function workerDeps(
  t: Tx,
  gateway: GatewayClient,
  over: Partial<RunWorkerCaps> = {},
  blobs: MemoryBlobStore = memoryBlobStore(),
): RunWorkerDeps & { blobs: MemoryBlobStore } {
  return {
    db: dbOn(t),
    blobs,
    gateway,
    cache: makePageImageCache(1_000_000),
    caps: { ...CAPS, ...over },
    workerId: 'test-worker',
  };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export async function aUser(t: Tx, name = 'A B'): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'https://issuer.example/realms/lexprompt',
             's-' || gen_random_uuid()::text, $2, 'AB', 'reviewer', 'active')
     returning id`, [WS, name]);
  return rows[0].id;
}

export async function aMatter(t: Tx, id: string): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Brookvale', now(), now()) on conflict (id) do nothing`, [id, WS]);
}

export async function aDocument(
  t: Tx, id: string, matterId: string, text = '[Page 1]\nThe break notice period is six months.\n\n',
): Promise<void> {
  await t.query(
    `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text, parse_state,
                           byte_size, mime, blob_key, role, added_at)
     values ($1, $2, 'matter', $3, $4, 'pdf', $5, 'parsed', 4, 'application/pdf', $6,
             'standalone', now())`,
    [id, WS, matterId, `${id}.pdf`, text, `workspace/${WS}/document/${id}`]);
}

export const SNAPSHOT = (clauses: string[], over: Record<string, unknown> = {}) => ({
  id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'Lease',
  systemPrompt: 'You are a lease reviewer.', formatPrompt: 'Answer as JSON.',
  changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 7,
  clauses: clauses.map(id => ({ id, title: id, extractPrompt: `What about ${id}?` })),
  ...over,
});

export async function aReview(
  t: Tx, id: string, matterId: string, target: unknown, clauses: string[],
): Promise<void> {
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids, target,
                         findings, model_id, started_at)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb, 'test-model', now())`,
    [id, WS, matterId, JSON.stringify(SNAPSHOT(clauses)),
      JSON.stringify((target as { documentIds?: string[] }).documentIds ?? []),
      JSON.stringify(target)]);
}

export async function aModelChoice(t: Tx, id = 'test-model'): Promise<void> {
  await t.query(
    `insert into workspace_setting (workspace_id, model_choice_id, concurrency)
     values ($1, $2, 5)
     on conflict (workspace_id) do update set model_choice_id = $2`, [WS, id]);
}

/**
 * A run with its cells and `pending` findings — the state
 * `POST /v1/reviews/:id/runs` leaves behind, built directly so a worker
 * suite does not have to go through the route to set up.
 */
export async function aRun(
  t: Tx, runId: string, reviewId: string, cells: { key: string; clause: string }[],
  userId: string, concurrency = 5,
): Promise<void> {
  await t.query(
    `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
     values ($1, $2, $3, 'queued', $4, $5)`, [runId, reviewId, WS, userId, concurrency]);
  await t.query(
    `insert into run_cell (run_id, findings_key, clause_id, workspace_id, state)
     select $1, k, c, $2, 'queued' from unnest($3::text[], $4::text[]) as a(k, c)`,
    [runId, WS, cells.map(c => c.key), cells.map(c => c.clause)]);
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     select $1, k, c, $2, 'pending' from unnest($3::text[], $4::text[]) as a(k, c)
     on conflict do nothing`,
    [reviewId, WS, cells.map(c => c.key), cells.map(c => c.clause)]);
}

/**
 * THE INVARIANT between the two state machines (Task 8 Step 2, Task 11 Step
 * 6), run after EVERY scenario rather than once.
 *
 * `run_cell.state` is the queue's and `finding.status` is the reader's, and
 * the worker writes both in one transaction. A `done` cell whose finding is
 * still `pending` or `running` is a card that spins forever over work that
 * has finished — and an invariant checked in one scenario is an assertion
 * about one scenario.
 */
export async function assertStatesAgree(t: Tx): Promise<void> {
  const broken = await t.query<{ run_id: string; clause_id: string; status: string }>(
    `select c.run_id, c.clause_id, f.status
       from run_cell c
       join run r on r.id = c.run_id
       join finding f on f.review_id = r.review_id
        and f.findings_key = c.findings_key and f.clause_id = c.clause_id
      where c.state = 'done' and f.status in ('pending','running')`);
  expect(broken, 'a done cell whose finding is still open').toEqual([]);
}
