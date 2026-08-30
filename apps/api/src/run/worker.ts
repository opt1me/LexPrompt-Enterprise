import {
  extractClause, extractCollectionClause, isCollectionTarget, isRetryableStatus, orderedMembers,
  type AllowedModel, type CollectionMember, type DocumentFile, type Finding,
  type InferResponse, type PlaybookClause, type PlaybookVersion, type ReviewTarget,
  type WorkspaceSettings,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import type { BlobStore } from '../blob/store.ts';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Actor } from '../auth/actor.ts';
import { fromDocumentRow, fromCollectionRow, type CollectionRow, type DocumentRecord, type DocumentRow } from '../db/rows.ts';
import { fromWorkspaceSettingRow, type WorkspaceSettingRow } from '../routes/workspaceSettings.ts';
import { toFindingRow, FINDING_COLUMNS, findingValues } from '../findings/rows.ts';
import { workerModelClient } from './modelClient.ts';
import { appendEvent } from './events.ts';
import { cancelPendingCells, exhaustCell } from './lifecycle.ts';
import { settleRunIfFinished, type RunCellRow, type RunRow } from './queue.ts';
import { documentFileForReview, type PageImageCache } from '../parse/hydrate.ts';

/**
 * The run worker — leasing, one cell per transaction, every cap declared.
 *
 * ## The lease is the whole design
 *
 * `for update skip locked` is what lets N workers share one queue with no
 * coordinator: a row another worker holds is skipped, not waited for. One
 * cell per slot, not per poll — a slot that grabs five cells and dies
 * orphans five leases instead of one.
 *
 * `attempts` increments ON LEASE, never on failure. A worker that dies
 * without reporting still consumes an attempt; otherwise a cell that crashes
 * the worker is retried forever, and the run never ends.
 *
 * ## The model call happens OUTSIDE the transaction
 *
 * A five-minute HTTP call must not hold a pool connection or a row lock. So
 * the shape is: a short transaction to claim, the call, a short transaction
 * to write. The write re-reads the lease first and abandons quietly if it
 * has expired or the run is cancelling — another worker may already have the
 * cell, and two writers on one finding is the thing this stage exists to
 * end.
 *
 * ## The worker writes model-authored columns and NOTHING else
 *
 * It connects as `lexprompt_worker`, which holds no grant on
 * `finding_disposition` or `finding_disposition_event` — revoked explicitly
 * in 006. So `carryHumanState`'s reason for existing is gone BY
 * CONSTRUCTION rather than by care: there is no snapshot of a run held out
 * here, so there is nothing to merge back, and a line that tried to write a
 * verification would be refused by the database rather than by a review.
 *
 * ## Never fall back from one extractor to the other
 *
 * A collection cell calls `extractCollectionClause` over the ordered,
 * review-hydrated members; a document cell calls `extractClause`. If a
 * collection's members cannot be assembled, the CELL becomes `error` naming
 * that and the run continues. `handleRetryCell`'s comment says why: falling
 * back would replace a synthesis across several documents with a
 * one-document answer, on screen indistinguishable from a correct re-run.
 */

export interface RunWorkerCaps {
  runWorkers: number;
  runLeaseMs: number;
  runCellTimeoutMs: number;
  runHeartbeatMs: number;
  runAttemptsMax: number;
  runPollMs: number;
  runRetryBackoffMs: number;
  workspaceRunConcurrency: number;
  pageRenderTimeoutMs: number;
  pageImageMaxPages: number;
  runImageBytesMax: number;
}

export interface RunWorkerDeps {
  /** The WORKER's connection. See `config.databaseWorkerUrl` for why there
   *  is no fallback to the app's. */
  db: Db;
  blobs: BlobStore;
  gateway: GatewayClient;
  cache: PageImageCache;
  caps: RunWorkerCaps;
  /** Identifies this process in `run_cell.leased_by`. A slot suffix is added
   *  per worker, so a stuck lease names which one. */
  workerId: string;
}

export interface WorkerHandle { stop(): Promise<void> }

/**
 * THE CLAIM.
 *
 * Corrected against a real Postgres and against the plan's own sketch, which
 * required `r.state = 'running'`. Nothing ever sets a run running except a
 * worker picking it up, so that predicate made the queue claim nothing at
 * all, forever — and, worse, it would have done so silently: every cell
 * stays `queued`, the run stays `queued`, no error is raised anywhere, and
 * the symptom is a review that never starts. `'queued'` is admitted here and
 * the run is promoted in the same transaction.
 *
 * The two concurrency tiers (P26) are predicates rather than a coordinator,
 * and both are read AT LEASE TIME rather than at creation, so a cancelled
 * run releases its share immediately.
 */
const CLAIM = `
with claimable as (
  select c.run_id, c.findings_key, c.clause_id
  from run_cell c
  join run r on r.id = c.run_id
  where r.state in ('queued','running')
    and r.cancel_requested_at is null
    and c.attempts < $1
    and (c.state = 'queued'
         or (c.state = 'leased' and c.lease_expires_at < now()))
    -- The per-run bound: this run's currently-leased cells, live.
    and (select count(*) from run_cell x
          where x.run_id = c.run_id and x.state = 'leased'
            and x.lease_expires_at > now()) < r.concurrency
    -- The per-workspace ceiling, across every run in the workspace.
    and (select count(*) from run_cell y join run ry on ry.id = y.run_id
          where ry.workspace_id = r.workspace_id and y.state = 'leased'
            and y.lease_expires_at > now()) < $2
  order by c.run_id, c.findings_key, c.clause_id
  for update of c skip locked
  limit 1
)
update run_cell c
   set state = 'leased', leased_by = $3,
       lease_expires_at = now() + ($4 || ' milliseconds')::interval,
       attempts = c.attempts + 1
  from claimable k
 where c.run_id = k.run_id and c.findings_key = k.findings_key and c.clause_id = k.clause_id
returning c.*`;

interface LeasedCell {
  cell: RunCellRow;
  run: RunRow;
}

/**
 * Claims one cell, promotes its run to `running`, marks the finding
 * `running` and appends `finding.running` — all in one transaction, so a
 * reader never sees a leased cell whose finding still says `pending`.
 */
export async function leaseCell(
  db: Db, deps: Pick<RunWorkerDeps, 'caps'>, workerId: string,
): Promise<LeasedCell | null> {
  return db.tx(async t => {
    const cells = await t.query<RunCellRow>(CLAIM, [
      deps.caps.runAttemptsMax,
      deps.caps.workspaceRunConcurrency,
      workerId,
      String(deps.caps.runLeaseMs),
    ]);
    const cell = cells[0];
    if (!cell) return null;

    const runs = await t.query<RunRow>(
      `update run set state = 'running',
                      started_at = coalesce(started_at, now()),
                      heartbeat_at = now(),
                      version = case when state = 'queued' then version + 1 else version end
        where id = $1 returning *`, [cell.run_id]);
    const run = runs[0];

    const updated = await t.query<{ version: string | number }>(
      `update finding set status = 'running', version = version + 1, updated_at = now()
        where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4
        returning version`,
      [run.review_id, cell.findings_key, cell.clause_id, cell.workspace_id]);

    await appendEvent(t, {
      workspaceId: cell.workspace_id,
      type: 'finding.running',
      reviewId: run.review_id,
      runId: run.id,
      payload: {
        runId: run.id,
        reviewId: run.review_id,
        findingsKey: cell.findings_key,
        clauseId: cell.clause_id,
        version: Number(updated[0]?.version ?? 0),
      },
    });
    return { cell, run };
  });
}

/** Everything one cell needs, read once per cell. */
interface CellContext {
  target: ReviewTarget;
  template: PlaybookVersion;
  clause: PlaybookClause;
  settings: WorkspaceSettings;
  matterId: string;
  /** The person who ASKED FOR THE RUN. Every gateway call is logged against
   *  them, never against a service identity (§10, §12 Q5). */
  actor: Actor;
}

/**
 * The run's requester, as an `Actor` for `withActor`.
 *
 * Read from `app_user` rather than assembled from the run row alone, because
 * the gateway's call log is what answers "on whose behalf has privileged
 * text been processed" and a row that named an id with no person behind it
 * would make that log unreadable.
 */
async function actorForRun(t: Pick<Tx, 'query'>, run: RunRow): Promise<Actor> {
  const rows = await t.query<{
    id: string; issuer: string; subject: string; display_name: string; initials: string;
    role: Actor['role'];
  }>(
    'select id::text as id, issuer, subject, display_name, initials, role from app_user '
    + 'where id = $1', [run.requested_by_user_id]);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `Run ${run.id} was requested by ${run.requested_by_user_id}, who is no longer a user of `
      + 'this workspace. The gateway logs every call against the person who asked for it, and '
      + 'a call this process could not attribute would be a call nobody can account for.');
  }
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.display_name,
    initials: row.initials,
    role: row.role,
    workspaceId: run.workspace_id,
  };
}

async function loadContext(
  db: Db, run: RunRow, clauseId: string, allowlist: AllowedModel[],
): Promise<CellContext> {
  const reviews = await db.query<{
    matter_id: string; target: unknown; playbook_snapshot: unknown;
  }>('select matter_id, target, playbook_snapshot from review where id = $1 and workspace_id = $2',
    [run.review_id, run.workspace_id]);
  if (!reviews[0]) throw new Error(`Review ${run.review_id} no longer exists.`);

  const target = parsedJson(reviews[0].target) as ReviewTarget;
  const template = parsedJson(reviews[0].playbook_snapshot) as PlaybookVersion;
  const clause = (template.clauses ?? []).find(c => c.id === clauseId);
  if (!clause) {
    throw new Error(
      `Clause ${clauseId} is not in this review's playbook snapshot. The snapshot is what the `
      + 'review claims to have checked, and a cell for a clause it does not contain cannot be '
      + 'answered against it.');
  }

  const settingRows = await db.query<WorkspaceSettingRow>(
    'select * from workspace_setting where workspace_id = $1', [run.workspace_id]);
  if (!settingRows[0]) {
    throw new Error('This workspace has no model configured. An administrator chooses one in '
      + 'Settings before a review can run.');
  }
  const stored = fromWorkspaceSettingRow(settingRows[0]);
  const settings = withCapabilities(stored, allowlist);

  return {
    target, template, clause, settings,
    matterId: reviews[0].matter_id,
    actor: await actorForRun(db, run),
  };
}

/**
 * The three capability fields, resolved from the gateway's allowlist.
 *
 * They are not stored anywhere — the browser resolves them the same way, by
 * cross-referencing `modelChoiceId` against `GET /v1/models` — so the worker
 * has to as well. **Refusing rather than defaulting is the point.**
 * `extractClause` treats an unknown capability as "cannot"
 * (`settings.modelSupportsImages ?? false`), which is the right default for
 * a browser whose list has not loaded yet and the wrong one here: it would
 * make every scanned document report "the model selected in Settings doesn't
 * support image input" whatever model was chosen, and would quietly apply a
 * 32,000-token fallback context budget to a model with ten times that —
 * truncating long leases with a note nobody reads.
 */
export function withCapabilities(
  settings: WorkspaceSettings, allowlist: AllowedModel[],
): WorkspaceSettings {
  const match = allowlist.find(m => m.id === settings.modelChoiceId);
  if (!match) {
    throw new Error(
      `This workspace is configured to use ${JSON.stringify(settings.modelChoiceId)}, which is `
      + 'not on the gateway\'s allowlist. LexPrompt will not guess what that model can read: '
      + 'assuming it cannot see images would review every scanned document as though it said '
      + 'nothing. An administrator should choose a model that is on the list.');
  }
  return {
    ...settings,
    modelChoiceLabel: match.label,
    modelChoiceModel: match.model,
    modelSupportsImages: match.supportsImages,
    modelSupportsStructuredOutput: match.supportsStructuredOutput,
    modelContextLength: match.contextLength,
  };
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * A persisted document, hydrated FOR REVIEW.
 *
 * The only route from a row to something an extractor may see. A raw record
 * or a view-hydrated file reviews a scanned document as though it said
 * nothing — this project's founding defect, which has reopened twice. A
 * missing row is reported as a `parseError` on a placeholder rather than as
 * a throw, so one absent document costs one cell and not the run.
 */
async function hydrateForReview(
  db: Db, deps: RunWorkerDeps, workspaceId: string, documentId: string,
): Promise<DocumentFile | null> {
  const rows = await db.query<DocumentRow>(
    "select * from document where id = $1 and workspace_id = $2 and kind = 'matter'",
    [documentId, workspaceId]);
  if (!rows[0]) return null;
  const record: DocumentRecord = fromDocumentRow(rows[0]);
  // A THUNK. `documentFileForReview` calls it only for a document whose
  // pages fall below `SCAN_TEXT_THRESHOLD` — see its own note — so a
  // forty-cell run over a text document reaches Blob Storage zero times.
  const readBytes = async (): Promise<Buffer | null> =>
    (await deps.blobs.get(rows[0].blob_key))?.bytes ?? null;
  return documentFileForReview(record, readBytes, rows[0].mime, {
    cache: deps.cache,
    pageRenderTimeoutMs: deps.caps.pageRenderTimeoutMs,
    pageImageMaxPages: deps.caps.pageImageMaxPages,
    runImageBytesMax: deps.caps.runImageBytesMax,
  });
}

/**
 * The COLLECTION's members, in reading order.
 *
 * `orderedMembers` decides the order and `documentDate` never sorts it: the
 * order in which amendments take effect is a legal judgement somebody
 * recorded when they built the collection. The worker READS the collection
 * record for it and does not re-derive it — and reads `collection` rather
 * than `document.role`, because the two are written non-atomically and the
 * record is authoritative.
 */
async function collectionMembers(
  db: Db, deps: RunWorkerDeps, workspaceId: string, collectionId: string,
): Promise<CollectionMember<DocumentFile>[]> {
  const rows = await db.query<CollectionRow>(
    'select * from collection where id = $1 and workspace_id = $2', [collectionId, workspaceId]);
  if (!rows[0]) {
    throw new Error(
      `The collection ${collectionId} this review was run over no longer exists, so its reading `
      + 'order cannot be read. LexPrompt will not review the documents as though they stood '
      + 'alone: an amendment read without the lease it amends answers the wrong question.');
  }
  const collection = fromCollectionRow(rows[0]);
  const ids = [collection.baseDocumentId, ...collection.variesDocumentIds];
  const files: DocumentFile[] = [];
  for (const id of ids) {
    const file = await hydrateForReview(db, deps, workspaceId, id);
    if (file) files.push(file);
  }
  // `orderedMembers` puts a missing document back at its rightful position
  // with `document: null` rather than dropping it, so the base is never
  // silently promoted away from position 1 by an amendment moving up.
  return orderedMembers(collection, files);
}

/** The gateway's allowlist, fetched once per poll cycle rather than per
 *  cell: forty cells is forty identical calls otherwise. */
async function allowlistOf(gateway: GatewayClient): Promise<AllowedModel[]> {
  const { status, json } = await gateway.models();
  if (status >= 400) {
    throw new Error(
      'LexPrompt could not read the list of permitted models from the gateway '
      + `(HTTP ${status}), so it cannot tell what the configured model is able to read.`);
  }
  const models = (json as { models?: unknown }).models;
  return Array.isArray(models) ? models as AllowedModel[] : [];
}

/**
 * A `GatewayClient` that reports each successful response envelope.
 *
 * `run.provider`/`jurisdiction` are written from WHAT THE GATEWAY SAID, not
 * from configuration (§6.5, S26) — a firm that changes its allowlist must
 * not silently rewrite where a review it ran last March was processed — and
 * `ModelClient.chatJson` returns only the parsed content, so the envelope has
 * to be caught here. Wrapping rather than changing `workerModelClient` keeps
 * Task 3's shipped file the one route to a model.
 */
function observing(
  gateway: GatewayClient,
  onResponse: (envelope: InferResponse) => void,
  onStatus: (status: number) => void,
): GatewayClient {
  return {
    infer: async (body, signal) => {
      const result = await gateway.infer(body, signal);
      onStatus(result.status);
      if (result.status < 400) {
        const envelope = result.json as Partial<InferResponse> | null;
        if (envelope && typeof envelope.provider === 'string') {
          onResponse(envelope as InferResponse);
        }
      }
      return result;
    },
    models: () => gateway.models(),
    stream: (body, signal) => gateway.stream(body, signal),
  };
}

export interface CellOutcome {
  finding: Finding;
  /** The gateway's own response envelope, or `null` when no call was made
   *  (an unreadable document is refused before the model is asked). What
   *  `run.provider`/`jurisdiction` are written from. */
  envelope: InferResponse | null;
  /**
   * The status the gateway answered with, when it was one a retry can fix
   * (429 or 5xx — `isRetryableStatus`, the same predicate the browser's
   * client has always used).
   *
   * `extractClause` never rejects, so a rate-limited cell arrives here as an
   * ordinary error `Finding` with a sentence in it and no status code. That
   * is right for a card and wrong for a scheduler: the difference between
   * "this clause cannot be answered" and "the gateway is busy" decides
   * whether the cell should be tried again, and only the transport knows it.
   */
  retryableStatus?: number;
  /** The `AllowedModel.id` this cell asked for. `run.model` comes from here
   *  and not from the envelope, because the gateway's response carries
   *  `provider`, `jurisdiction` and `callId` and no model name — a
   *  disagreement with the plan's own sketch, recorded rather than papered
   *  over. It is still a SNAPSHOT and not a re-derivation: it is what this
   *  run actually sent, at the moment it sent it. */
  modelChoiceId: string | null;
}

/**
 * Why a cell's call stopped, when it stopped early.
 *
 * `AbortSignal` carries no reason the extractors can read — both answer any
 * `AbortError` with a `cancelled` finding — so the caller has to remember
 * which of the two aborts it fired. "A person stopped this" and "this took
 * too long" are different things to put on a card, and collapsing them would
 * tell a reviewer somebody made a decision that nobody made.
 */
type AbortCause = 'timeout' | 'cancelled' | null;

/**
 * ONE CELL'S MODEL CALL, outside any transaction.
 *
 * `extractClause` and `extractCollectionClause` never reject — a failed
 * clause resolves to an error `Finding` — so a bad cell costs a cell. What
 * CAN throw here is the context load (a review deleted mid-run, a clause not
 * in the snapshot, a model that is not on the allowlist); the caller turns
 * that into the same error finding rather than letting it kill the run.
 */
export async function runOneCell(
  deps: RunWorkerDeps, leased: LeasedCell, allowlist: AllowedModel[],
  signal: AbortSignal,
): Promise<CellOutcome> {
  const { cell, run } = leased;
  const context = await loadContext(deps.db, run, cell.clause_id, allowlist);

  let envelope: InferResponse | null = null;
  let lastStatus = 0;
  const client = workerModelClient(
    observing(deps.gateway, e => { envelope = e; }, s => { lastStatus = s; }),
    run.workspace_id,
    context.actor,
  );

  const finding = isCollectionTarget(context.target)
    ? await extractCollectionClause(
      client,
      await collectionMembers(deps.db, deps, run.workspace_id, context.target.collectionId),
      context.clause, context.template, context.settings, signal,
      { matterId: context.matterId, reviewId: run.review_id })
    : await extractClause(
      client,
      await documentForCell(deps, run.workspace_id, cell.findings_key),
      context.clause, context.template, context.settings, signal,
      { matterId: context.matterId, reviewId: run.review_id });

  return {
    finding,
    envelope,
    modelChoiceId: context.settings.modelChoiceId || null,
    ...(finding.status === 'error' && isRetryableStatus(lastStatus)
      ? { retryableStatus: lastStatus } : {}),
  };
}

/**
 * The document a DOCUMENT cell is about.
 *
 * `cell.findings_key` IS the document id for a document review — that is
 * what `findingsKeyFor` returned when the cell was created — and reading it
 * back that way is the same rule in the other direction. A missing document
 * becomes a placeholder carrying a `parseError`, which `extractClause`
 * answers with *"Could not read X"*: one cell's error, not the run's.
 */
async function documentForCell(
  deps: RunWorkerDeps, workspaceId: string, documentId: string,
): Promise<DocumentFile> {
  const file = await hydrateForReview(deps.db, deps, workspaceId, documentId);
  if (file) return file;
  return {
    id: documentId,
    name: documentId,
    text: '',
    file: new File([], documentId),
    kind: 'txt',
    parseError: 'This document is no longer in LexPrompt, so there was nothing to review.',
  };
}

/**
 * The write: one short transaction, after the call.
 *
 * 1. re-read the cell and ABANDON QUIETLY if the lease has expired or the
 *    run is cancelling — another worker may already hold it, and a write
 *    onto a cell this process no longer owns is the second writer this whole
 *    design exists to prevent;
 * 2. update the `finding` from `toFindingRow`, `version = version + 1`;
 * 3. update the `run_cell`;
 * 4. append exactly one event.
 *
 * `settleRunIfFinished` runs in the SAME transaction, so the `run.finished`
 * event and the last cell's event are committed together — a client cannot
 * see a run finish before the finding that finished it.
 */
export async function writeCellResult(
  deps: RunWorkerDeps, leased: LeasedCell, outcome: CellOutcome, workerId: string,
): Promise<'written' | 'abandoned'> {
  const { cell, run } = leased;
  return deps.db.tx(async t => {
    const held = await t.query<RunCellRow & { run_state: string; cancel_requested_at: Date | null }>(
      `select c.*, r.state as run_state, r.cancel_requested_at
         from run_cell c join run r on r.id = c.run_id
        where c.run_id = $1 and c.findings_key = $2 and c.clause_id = $3 and c.workspace_id = $4
        for update of c`,
      [cell.run_id, cell.findings_key, cell.clause_id, cell.workspace_id]);
    const current = held[0];
    if (!current
      || current.state !== 'leased'
      || current.leased_by !== workerId
      || (current.lease_expires_at !== null && current.lease_expires_at.getTime() <= Date.now())) {
      return 'abandoned';
    }

    const finding = outcome.finding;

    if (current.cancel_requested_at !== null) {
      // A person asked this run to stop while the call was in flight. The
      // answer is discarded rather than written: a finding produced after a
      // cancellation would appear on a card the reader has been told is
      // finished, attributed to a run that ended before it existed.
      await t.query(
        `update run_cell set state = 'cancelled', leased_by = null, lease_expires_at = null
          where run_id = $1 and findings_key = $2 and clause_id = $3`,
        [cell.run_id, cell.findings_key, cell.clause_id]);
      await t.query(
        `update finding set status = 'cancelled', version = version + 1, updated_at = now()
          where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4
            and status in ('pending','running')`,
        [run.review_id, cell.findings_key, cell.clause_id, cell.workspace_id]);
      await cancelPendingCells(t, run.id, run.review_id, run.workspace_id);
      await settleRunIfFinished(t, run.id, run.workspace_id);
      return 'written';
    }

    // A FAILURE A RETRY GENUINELY FIXES, parked rather than recorded.
    //
    // 429 and 5xx are the two the browser's own client has always retried,
    // and a 200-cell review against the real stack proved why it matters:
    // the gateway's rate limiter answered 429 for 140 cells and the run
    // reported 140 permanent failures for a condition that cleared inside a
    // minute. `attempts` was already spent on the lease, so the bound still
    // holds — this only decides whether the last word on the cell is "the
    // gateway was busy" or an answer.
    //
    // The cell is parked by PUSHING ITS LEASE INTO THE FUTURE with no holder,
    // which is exactly the shape the claim query already understands: a
    // `leased` cell is claimable only once `lease_expires_at` has passed. No
    // second timer column, no second state. The FINDING stays `running`,
    // because it is: something is still going to answer this clause, and
    // writing an error a later attempt would overwrite would put a red card
    // in front of a reader for thirty seconds and then take it away.
    //
    // No event is appended. Nothing terminal happened, and an event saying
    // otherwise is the network-era form of a quiet wrong answer.
    if (outcome.retryableStatus !== undefined
      && current.attempts < deps.caps.runAttemptsMax) {
      await t.query(
        `update run_cell set leased_by = null, last_error = $4,
                             lease_expires_at = now() + ($5 || ' milliseconds')::interval
          where run_id = $1 and findings_key = $2 and clause_id = $3`,
        [cell.run_id, cell.findings_key, cell.clause_id,
          `${finding.error ?? `HTTP ${outcome.retryableStatus}`} (attempt ${current.attempts} of `
          + `${deps.caps.runAttemptsMax}; waiting ${deps.caps.runRetryBackoffMs}ms)`,
          String(deps.caps.runRetryBackoffMs)]);
      return 'written';
    }

    // WHAT THE GATEWAY SAID, once, and never overwritten.
    //
    // `model` is the model this run ASKED for, snapshotted at the first call
    // — the gateway's response envelope carries `provider`, `jurisdiction`
    // and `callId` but no model name, so there is nothing to read it from.
    // Recorded from the run's own settings rather than left null, because
    // "which model ran this review" is the question §6.5 is about and the
    // workspace setting can change afterwards.
    if (outcome.envelope) {
      await t.query(
        `update run set provider = coalesce(provider, $2),
                        jurisdiction = coalesce(jurisdiction, $3::jsonb),
                        model = coalesce(model, $4)
          where id = $1 and (provider is null or jurisdiction is null or model is null)`,
        [run.id, outcome.envelope.provider, JSON.stringify(outcome.envelope.jurisdiction),
          outcome.modelChoiceId]);
    }

    // `verification` and `notes` are DESTRUCTURED OFF, not spread as
    // `undefined`. `FindingContent` is `Omit<Finding, 'verification' |
    // 'notes'>` by type precisely so this line cannot carry a human's
    // judgement into a worker's write — and the worker's role holds no grant
    // that would let it if it tried.
    const { verification: _verification, notes: _notes, ...content } = finding;
    const row = toFindingRow(content, run.review_id, cell.findings_key, cell.workspace_id);
    const updated = await t.query<{ version: string | number }>(
      `update finding set ${FINDING_COLUMNS.slice(4).map((c, i) =>
        (c === 'citations' || c === 'net_position' ? `${c} = $${i + 5}::jsonb` : `${c} = $${i + 5}`))
        .join(', ')}, version = version + 1, updated_at = now()
        where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4
        returning version`,
      findingValues(row));
    if (!updated[0]) {
      // The finding row is seeded at run creation and cascades with the
      // review, so its absence means the review was deleted mid-run. The
      // cell is closed rather than retried: there is nothing left to write
      // an answer onto.
      await t.query(
        `update run_cell set state = 'error', last_error = $4, leased_by = null,
                             lease_expires_at = null
          where run_id = $1 and findings_key = $2 and clause_id = $3`,
        [cell.run_id, cell.findings_key, cell.clause_id,
          'The review this cell belongs to was deleted while it was running.']);
      await settleRunIfFinished(t, run.id, run.workspace_id);
      return 'written';
    }

    const failed = finding.status === 'error';
    await t.query(
      `update run_cell set state = $4, last_error = $5, leased_by = null, lease_expires_at = null
        where run_id = $1 and findings_key = $2 and clause_id = $3`,
      [cell.run_id, cell.findings_key, cell.clause_id, failed ? 'error' : 'done',
        finding.error ?? null]);

    await appendEvent(t, {
      workspaceId: cell.workspace_id,
      type: failed ? 'finding.error' : 'finding.done',
      reviewId: run.review_id,
      runId: run.id,
      payload: {
        runId: run.id,
        reviewId: run.review_id,
        findingsKey: cell.findings_key,
        clauseId: cell.clause_id,
        version: Number(updated[0].version),
        ...(failed && finding.error ? { error: finding.error } : {}),
      },
    });

    await settleRunIfFinished(t, run.id, run.workspace_id);
    return 'written';
  });
}

/**
 * One full step: claim, call, write. Exported so a test can drive exactly
 * one rather than racing a loop — a suite that starts a pool and waits
 * proves whatever the clock happened to allow.
 */
export async function runOneStep(
  deps: RunWorkerDeps, workerId: string, allowlist: AllowedModel[],
): Promise<boolean> {
  const leased = await leaseCell(deps.db, deps, workerId);
  if (!leased) return false;

  // THE TWO REASONS A CELL STOPS EARLY, and one controller so the extractors
  // see the single `AbortSignal` they already understand.
  //
  // The timeout is the declared cap. The cancel poll is what makes Cancel a
  // button that stops work rather than one that stops the QUEUE while the
  // calls already in flight run to completion and are billed — the run's
  // `cancel_requested_at` is set by the route, and nothing would otherwise
  // reach a call that has been open for four minutes.
  const controller = new AbortController();
  let cause: AbortCause = null;
  const timer = setTimeout(() => {
    cause = 'timeout';
    controller.abort();
  }, deps.caps.runCellTimeoutMs);
  const cancelPoll = setInterval(() => {
    void deps.db.query<{ cancel_requested_at: Date | null }>(
      'select cancel_requested_at from run where id = $1', [leased.run.id],
    ).then(rows => {
      if (rows[0]?.cancel_requested_at) {
        cause = 'cancelled';
        controller.abort();
      }
    }).catch(() => { /* the next poll tries again; the timeout still bounds it */ });
  }, deps.caps.runHeartbeatMs);
  timer.unref?.();
  cancelPoll.unref?.();

  let outcome: CellOutcome;
  try {
    outcome = await runOneCell(deps, leased, allowlist, controller.signal);
  } catch (error) {
    // Everything the extractors do NOT catch: a review deleted mid-run, a
    // clause missing from the snapshot, a collection whose record is gone, a
    // model that is not on the allowlist. One cell's error, named, never the
    // run's death — `extractClause` "returns one Finding and never rejects",
    // and a worker that let anything AROUND it reject would turn one bad
    // cell into a lost review.
    outcome = {
      finding: {
        clauseId: leased.cell.clause_id,
        status: 'error',
        citations: [],
        error: error instanceof Error ? error.message : String(error),
      } as Finding,
      envelope: null,
      modelChoiceId: null,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(cancelPoll);
  }

  // A `cancelled` finding is what both extractors return for ANY
  // `AbortError`, so on its own it cannot say which abort fired. A cell
  // stopped by the declared timeout must not read as a person's decision to
  // stop: `cause` is the only thing that knows, and this is where it is
  // spent.
  if (outcome.finding.status === 'cancelled' && cause !== 'cancelled') {
    outcome = {
      ...outcome,
      finding: {
        ...outcome.finding,
        status: 'error',
        error: `This clause took longer than ${deps.caps.runCellTimeoutMs}ms to answer and was `
          + 'stopped (API_RUN_CELL_TIMEOUT_MS). Nobody cancelled it. Retrying may work; a '
          + 'document this long may need a model with a larger context window.',
      },
    };
  }

  const result = await writeCellResult(deps, leased, outcome, workerId);
  if (result === 'abandoned') {
    process.stderr.write(
      `api: worker ${workerId} finished a cell it no longer held `
      + `(${leased.cell.run_id}/${leased.cell.findings_key}/${leased.cell.clause_id}); the `
      + 'answer was discarded and another worker owns it.\n');
  }
  return true;
}

/**
 * The pool, plus the heartbeat that is the whole difference between a run
 * that is in flight and one that is stuck.
 *
 * The heartbeat is a SEPARATE ticker rather than something the cell loop
 * does between cells, because a single cell may legitimately take minutes
 * and a run whose heartbeat only moved between cells would be reaped in the
 * middle of its longest clause.
 */
/**
 * THE LEASES THIS PROCESS LEFT BEHIND WHEN IT LAST DIED.
 *
 * A cell leased by a worker that is killed keeps its lease until it expires,
 * and `API_RUN_LEASE_MS` is ten minutes because a single clause against a
 * slow model may legitimately take that long. So without this, "a run
 * survives a worker restart and completes" is true and takes ten minutes —
 * which reads to anybody watching as a run that is stuck, and is exactly the
 * state the heartbeat exists to distinguish from being in flight.
 *
 * A process may safely expire a lease stamped with ITS OWN identity: if this
 * process is starting, whatever held that lease is gone. `workerId` is the
 * container's hostname rather than its pid for precisely this reason — a pid
 * changes on every restart and would make a process unable to recognise its
 * own orphans. It does NOT touch another host's leases: those belong to a
 * worker that may well still be running, and stealing one would put two
 * writers on a finding.
 */
export async function releaseOwnOrphanedLeases(deps: RunWorkerDeps): Promise<number> {
  const rows = await deps.db.query<{ run_id: string }>(
    // `now() - 1 second`, not `now()`: the claim query re-leases a cell whose
    // `lease_expires_at < now()`, strictly, and an expiry set to exactly now
    // is not less than the now of the next statement often enough to rely
    // on. A lease pushed one second into the past is claimable immediately
    // and unambiguously.
    `update run_cell set lease_expires_at = now() - interval '1 second', leased_by = null
      where state = 'leased' and leased_by like $1 and lease_expires_at > now()
      returning run_id`,
    [`${deps.workerId}#%`]);
  return rows.length;
}

export function startWorkerPool(deps: RunWorkerDeps): WorkerHandle {
  let running = true;
  const active = new Set<string>();
  const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

  const heartbeat = setInterval(() => {
    if (active.size === 0) return;
    void deps.db.query(
      'update run set heartbeat_at = now() where id = any($1::text[])', [[...active]],
    ).catch((error: Error) => {
      process.stderr.write(`api: run heartbeat failed: ${error.message}\n`);
    });
  }, deps.caps.runHeartbeatMs);
  // A ticker must not keep an idle process alive; `unref` is what lets
  // `stop()` actually stop.
  heartbeat.unref?.();

  const loop = async (slot: number): Promise<void> => {
    const workerId = `${deps.workerId}#${slot}`;
    while (running) {
      let did = false;
      try {
        const allowlist = await allowlistOf(deps.gateway);
        did = await runOneStep(deps, workerId, allowlist);
      } catch (error) {
        // A failure to CLAIM, or to reach the gateway for the allowlist. It
        // must not kill the loop and must not spin: the run stays live, its
        // heartbeat keeps beating, and the next poll tries again.
        process.stderr.write(`api: run worker ${workerId}: ${(error as Error).message}\n`);
      }
      if (!did) await sleep(deps.caps.runPollMs);
    }
  };

  // The active-run set, kept by a cheap query rather than by the loops
  // themselves — a loop that threw between claiming and releasing would
  // otherwise leave a run in the set forever, and a heartbeat that outlives
  // its worker is exactly the lie the reaper exists to catch.
  const track = setInterval(() => {
    void deps.db.query<{ run_id: string }>(
      "select distinct run_id from run_cell where state = 'leased' and leased_by like $1 "
      + 'and lease_expires_at > now()', [`${deps.workerId}#%`],
    ).then(rows => {
      active.clear();
      for (const row of rows) active.add(row.run_id);
    }).catch(() => { /* the heartbeat's own failure is already reported */ });
  }, Math.max(1000, Math.floor(deps.caps.runHeartbeatMs / 2)));
  track.unref?.();

  // Before the first claim: reclaim what this process left behind last time.
  // Reported rather than silent — a restart that recovered eleven cells is a
  // fact an operator reading the boot log should see.
  const reclaimed = releaseOwnOrphanedLeases(deps).then(n => {
    if (n > 0) {
      process.stderr.write(
        `api: released ${n} lease(s) this process left behind before it restarted
`);
    }
  }).catch((error: Error) => {
    process.stderr.write(`api: could not release own orphaned leases: ${error.message}
`);
  });

  const loops = Array.from({ length: deps.caps.runWorkers },
    (_, i) => reclaimed.then(() => loop(i + 1)));
  return {
    async stop() {
      running = false;
      clearInterval(heartbeat);
      clearInterval(track);
      await Promise.allSettled(loops);
    },
  };
}

export { exhaustCell };
