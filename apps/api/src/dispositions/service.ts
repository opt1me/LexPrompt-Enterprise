import {
  ModelError, effectiveReason, requiresReason,
  type DispositionCause, type DispositionEventView, type DispositionView,
  type VerificationState,
} from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import type { FindingKey } from '../findings/rows.ts';

/**
 * The ONLY place `finding_disposition` or `finding_disposition_event` is
 * written, anywhere in this codebase. Task 25's scanner asserts it.
 *
 * Both rows, one transaction, never one without the other (§6.3) — so a
 * current state whose history does not explain it cannot exist. That is the
 * property `recomputes finding_disposition from its history and finds it
 * equal` checks, and it is the reason the event insert is a separate
 * statement rather than a trigger: a reader of this file has to be able to
 * see both writes, and delete one to watch a test fail.
 */

// One declaration, in `@lexprompt/core` beside the wire shapes that carry
// it — the browser renders a cause and this module writes one, and two
// copies of a two-value union is exactly how they come to disagree.
export type { DispositionCause };

export interface DispositionRow {
  review_id: string;
  findings_key: string;
  clause_id: string;
  workspace_id: string;
  state: VerificationState;
  reason: string | null;
  by_user_id: string | null;
  at: Date | null;
  changed_count: number;
  /** `bigint`, which `pg` hands back as a STRING — compared for equality on
   *  the way back in, so it is narrowed at every use site below. */
  version: string | number;
}

export interface DispositionChange {
  state: VerificationState;
  reason?: string;
}

const SELECT = `select review_id, findings_key, clause_id, workspace_id, state, reason,
                       by_user_id, at, changed_count, version
                from finding_disposition
                where review_id = $1 and findings_key = $2 and clause_id = $3`;

function versionOf(row: DispositionRow): number {
  return typeof row.version === 'number' ? row.version : Number(row.version);
}

/** The current disposition, or `undefined` when the finding has none yet. */
export async function dispositionFor(t: Tx, key: FindingKey): Promise<DispositionRow | undefined> {
  const rows = await t.query<DispositionRow>(SELECT,
    [key.reviewId, key.findingsKey, key.clauseId]);
  return rows[0];
}

/** One `finding_disposition_event` row. */
export interface DispositionEventRow {
  /** `bigint`, which `pg` hands back as a STRING. */
  id: string | number;
  from_state: VerificationState;
  to_state: VerificationState;
  reason: string | null;
  cause: DispositionCause;
  by_user_id: string;
  at: Date;
}

/**
 * The history of one finding's disposition, NEWEST FIRST.
 *
 * In this module rather than in the route, because it reads the table this
 * module is the only writer of — a second file composing its own query over
 * `finding_disposition_event` is how the two come to disagree about what an
 * event is. Two callers: `GET …/history`, and the disposition write, which
 * hands back the event it just produced so `fromState` is on hand at first
 * render without a second round trip (§8).
 *
 * Scoped by workspace as well as by key: the key alone is a text triple, and
 * a route that had already checked the finding would still be issuing an
 * unscoped read of a table holding every firm's judgements.
 */
export async function readDispositionEvents(
  t: Tx, key: FindingKey, workspaceId: string, limit = 200,
): Promise<DispositionEventRow[]> {
  return t.query<DispositionEventRow>(
    `select id, from_state, to_state, reason, cause, by_user_id::text as by_user_id, at
       from finding_disposition_event
      where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4
      order by id desc
      limit $5`,
    [key.reviewId, key.findingsKey, key.clauseId, workspaceId, limit]);
}

/**
 * A stored row as the WIRE shape, and the only producer of one.
 *
 * It lived in `routes/findings.ts` while that file was the only thing
 * answering with a `DispositionView`. Stage 4's findings read answers with
 * one too (§8), and two mappers for one shape — one composing it from a
 * disposition row, one from a join's `d_*` columns — is this project's most
 * repeated defect in the form where the two are in different directories.
 * So it moved HERE, beside the row type it reads, and both callers import
 * it. "When you find yourself writing a second copy, extract it then."
 *
 * ABSENT, never `byUserId: undefined`: a finding nobody has touched names
 * nobody (§6.3), and `structuredClone` preserves an undefined-valued key —
 * so an `in` check on a round-tripped record would read it as a name that is
 * there.
 */
export function toDispositionView(row: DispositionRow): DispositionView {
  return {
    reviewId: row.review_id,
    findingsKey: row.findings_key,
    clauseId: row.clause_id,
    state: row.state,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.by_user_id ? { byUserId: row.by_user_id } : {}),
    ...(row.at ? { at: row.at.getTime() } : {}),
    changedCount: row.changed_count,
    version: Number(row.version),
  };
}

/** One stored event as the wire shape, and the only producer of one — the
 *  same rule, for the same reason, on the evidence half. */
export function toEventView(row: DispositionEventRow): DispositionEventView {
  return {
    id: Number(row.id),
    fromState: row.from_state,
    toState: row.to_state,
    ...(row.reason ? { reason: row.reason } : {}),
    cause: row.cause,
    byUserId: row.by_user_id,
    at: row.at.getTime(),
  };
}

/**
 * The `unchecked` row every finding starts with.
 *
 * `changed_count = 0`, `by_user_id` NULL, `at` NULL, and NO event: nobody has
 * touched it, so there is nothing to attribute, and §6.3 says such a finding
 * renders as "Not checked" and names nobody. Creating it here rather than in
 * a trigger keeps this module the only writer; `on conflict do nothing` makes
 * it safe to call on every write of a finding that already has one.
 */
export async function ensureDisposition(
  t: Tx,
  key: FindingKey,
  workspaceId: string,
): Promise<DispositionRow> {
  await t.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     values ($1, $2, $3, $4, 'unchecked', 0)
     on conflict (review_id, findings_key, clause_id) do nothing`,
    [key.reviewId, key.findingsKey, key.clauseId, workspaceId]);
  const row = await dispositionFor(t, key);
  if (!row) {
    // Unreachable through the insert above; named rather than non-null
    // asserted, because the failure it would replace is `undefined.state`
    // three frames later.
    throw new Error(
      `No disposition exists for ${key.reviewId}/${key.findingsKey}/${key.clauseId} and one could `
      + 'not be created. The finding row it belongs to is probably missing.');
  }
  return row;
}

/**
 * The same `unchecked` row, for EVERY cell of a run, in one statement.
 *
 * Here rather than in `run/queue.ts` because this module is the only writer
 * of `finding_disposition` anywhere in this codebase, and `stage3aDoD`'s
 * scanner enforces that by name — correctly. A third writer appearing there
 * is exactly the thing that scanner exists to catch, whatever the writer's
 * intentions, because "a lawyer's judgement written from somewhere that is
 * neither a person's request nor the one-time migration" is not a claim a
 * reader should have to check file by file.
 *
 * `createRun` needs it because a run started through
 * `POST /v1/reviews/:id/runs` over a review with no findings blob seeded no
 * disposition at all, and the first verification a reviewer made on it
 * answered 404. `ensureDisposition` above does this one key at a time, which
 * is forty round trips inside the transaction a caller is holding open.
 *
 * `on conflict do nothing`: a re-run's findings already have theirs, and
 * whatever they say is a judgement `resetDispositions` is about to deal with
 * properly. Creating a row is not recording a judgement — `changed_count`
 * is 0, the actor and the instant are NULL, and no event is written.
 */
export async function ensureDispositions(
  t: Tx, reviewId: string, workspaceId: string, findingsKeys: string[], clauseIds: string[],
): Promise<void> {
  await t.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     select $1, k, c, $2, 'unchecked', 0 from unnest($3::text[], $4::text[]) as a(k, c)
     on conflict (review_id, findings_key, clause_id) do nothing`,
    [reviewId, workspaceId, findingsKeys, clauseIds]);
}

/**
 * Moves a finding's disposition, and records that it moved.
 *
 * `expectedVersion` is the version the caller was looking at. If the row has
 * moved on — another tab, another person — this REFUSES with the current row
 * (`ConflictError`) and applies nothing. Stage 4 puts "Priya changed this to
 * Rejected at 14:22" on that refusal; the refusal itself is here, because the
 * alternative is a silent overwrite of a judgement the changer never saw.
 *
 * `at` is a PARAMETER, not `now()`. The reference for this function omitted
 * it, and Task 7 cannot be written without it: a whole-review save translates
 * a verification the person made seconds or minutes earlier, and stamping the
 * history with the moment their browser next autosaved would say when the
 * network was busy rather than when they decided.
 *
 * `cause` is the one field that distinguishes a person from the system. A
 * `rerun_reset` may only ever move a disposition to `unchecked` — the
 * database refuses anything else — so the write the engine performs on its
 * own behalf can only remove a claim of human checking, never manufacture
 * one.
 */
export async function setDisposition(
  t: Tx,
  key: FindingKey,
  change: DispositionChange,
  cause: DispositionCause,
  actor: { id: string },
  at: Date,
  expectedVersion: number,
): Promise<DispositionRow> {
  const reason = change.reason?.trim();
  // The same rule as `applyVerification`'s, and read from the same predicate
  // rather than re-stated: only `rejected` demands a reason, and a reason on
  // anything else is DROPPED. A stale "wrong clause" left hanging on a
  // now-verified finding would read as if it still applied.
  if (requiresReason(change.state) && !reason) {
    throw new ModelError(
      'A rejected finding needs a reason. A rejection with no reason is a silent disagreement, '
      + 'useless to whoever reads the export.', 'unknown', 400);
  }
  if (cause === 'rerun_reset' && change.state !== 'unchecked') {
    // Refused here as well as by `rerun_reset_only_unchecks`, so the caller
    // gets a sentence rather than a constraint name — and so this rule is
    // stated in the one module that writes the table, where somebody
    // loosening it has to read what it is for.
    throw new Error(
      `A rerun reset can only move a disposition to unchecked, never to ${change.state}. `
      + 'The one write this system performs on its own behalf must only ever REMOVE a claim '
      + 'that a human checked something.');
  }
  // The shared rule, not a second copy of it. `findings/write.ts` reads the
  // same function when it decides what a blob's verification actually
  // carries, so the value compared and the value stored cannot disagree —
  // which is exactly how a flagged finding with a reason came to write a
  // history row on every autosave.
  const nextReason = effectiveReason(change.state, reason);

  const before = await dispositionFor(t, key);
  if (!before) {
    throw new ModelError(
      `There is no finding ${key.reviewId}/${key.findingsKey}/${key.clauseId} to record a `
      + 'judgement about.', 'not_found', 404);
  }
  if (versionOf(before) !== expectedVersion) {
    throw new ConflictError(before);
  }

  const updated = await t.query<DispositionRow>(
    `update finding_disposition
        set state = $4, reason = $5, by_user_id = $6, at = $7,
            changed_count = changed_count + 1, version = version + 1
      where review_id = $1 and findings_key = $2 and clause_id = $3 and version = $8
      returning review_id, findings_key, clause_id, workspace_id, state, reason,
                by_user_id, at, changed_count, version`,
    [key.reviewId, key.findingsKey, key.clauseId, change.state, nextReason,
      actor.id, at, expectedVersion]);
  if (!updated[0]) {
    // The row moved between the read and the update — a second writer inside
    // the same instant. Same refusal, re-read so the caller sees what won.
    throw new ConflictError(await dispositionFor(t, key));
  }

  // The half whose absence §14 names as the mutation to try: delete this and
  // the disposition clears without recording that it cleared.
  await t.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, reason,
        cause, by_user_id, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [key.reviewId, key.findingsKey, key.clauseId, before.workspace_id, before.state,
      change.state, nextReason, cause, actor.id, at]);

  return updated[0];
}
