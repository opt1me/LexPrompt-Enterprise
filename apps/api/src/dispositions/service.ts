import { ModelError, requiresReason, type VerificationState } from '@lexprompt/core';
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

export type DispositionCause = 'human' | 'rerun_reset';

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
  const nextReason = requiresReason(change.state) && reason ? reason : null;

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
