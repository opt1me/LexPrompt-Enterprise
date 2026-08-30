import {
  ModelError, OUTCOMES, findingsKeyFor, requiresReason, type Finding, type ReviewTarget,
  type VerificationState,
} from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import {
  FINDING_COLUMNS, findingValues, toFindingRow, type FindingContent, type FindingKey,
} from './rows.ts';
import { dispositionFor, ensureDisposition, setDisposition } from '../dispositions/service.ts';

/**
 * The shadow writer (P17), and it is temporary by design — deleted in Task 22
 * with the blob write it exists to shadow.
 *
 * The browser owns `review.findings` for the whole of Part 3A. Task 6 built
 * rows for every review that existed; without this they would go stale the
 * moment anybody verified anything. So every whole-review save writes the rows
 * too, IN THE SAME TRANSACTION as the blob, which is what makes it impossible
 * for a crash to leave the two disagreeing. `reconcileFindings` is what proves
 * it, key by key, on every write in the `.pg.test.ts` suite.
 *
 * There is never only one copy of a judgement inside the change that alters
 * it. That is the whole of P17 and the reason this file exists at all.
 */

const STATES: VerificationState[] = ['unchecked', 'verified', 'flagged', 'rejected'];
const STATUSES: Finding['status'][] = ['pending', 'running', 'done', 'error', 'cancelled'];
const RISKS = ['High', 'Medium', 'Low', 'Info'];

export interface BlobNote {
  id: string;
  findingId: string;
  text: string;
  byUserId: string;
  at: number;
}

export interface Cell {
  findingsKey: string;
  clauseId: string;
  content: FindingContent;
  verification: { state: VerificationState; reason?: string; byUserId?: string; at?: number };
  notes: BlobNote[];
}

function refuse(detail: string): never {
  // A 400 rather than a 500 with a constraint name in it. Every one of these
  // is a body this service cannot store faithfully, and the alternative to
  // saying so is a Postgres error naming a column in front of a lawyer.
  throw new ModelError(`LexPrompt could not save this review (${detail}).`, 'unknown', 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The findings blob, checked rather than cast.
 *
 * `parseReview` deliberately stores and returns `findings` UNREAD beyond its
 * outer shape, and that must not change — it is what keeps an ABSENT optional
 * key absent. This reads the same blob a second time, for a different purpose:
 * deciding what can be written as rows. A cell it cannot read is refused by
 * name here rather than reaching Postgres as a check-constraint violation.
 *
 * The keys are used EXACTLY as the body carries them, and checked against the
 * review's own target through `findingsKeyFor` — the only place a findings key
 * is decided. Note what this does NOT do: it does not re-validate against
 * anything outside the body. C1's lesson is that re-checking a stored review
 * against today's membership makes it permanently unsavable; a body that is
 * self-consistent passes this check forever, whatever else changes.
 */
export function readFindingsBlob(findings: unknown, target: ReviewTarget): Cell[] {
  if (!isRecord(findings)) refuse('findings is not an object');
  const cells: Cell[] = [];
  for (const [findingsKey, byClause] of Object.entries(findings)) {
    if (!isRecord(byClause)) {
      refuse(`the findings under ${JSON.stringify(findingsKey)} are not an object of clause id `
        + 'to finding, so every finding under that key would be lost');
    }
    let expected: string;
    try {
      expected = findingsKeyFor(target, findingsKey);
    } catch {
      refuse(`the findings key ${JSON.stringify(findingsKey)} cannot belong to this review's `
        + 'target');
    }
    if (expected !== findingsKey) {
      refuse(`the findings key ${JSON.stringify(findingsKey)} is not one this review's target `
        + `explains — a collection review keys its findings by the collection `
        + `(${JSON.stringify(expected)}), not by a document`);
    }
    for (const [clauseId, value] of Object.entries(byClause)) {
      cells.push(readCell(findingsKey, clauseId, value));
    }
  }
  return cells;
}

function readCell(findingsKey: string, clauseId: string, value: unknown): Cell {
  const where = `${findingsKey}/${clauseId}`;
  if (!isRecord(value)) refuse(`the finding at ${where} is not an object`);
  const status = value.status;
  if (typeof status !== 'string' || !STATUSES.includes(status as Finding['status'])) {
    refuse(`the finding at ${where} has status ${JSON.stringify(status)}, which is not one of `
      + STATUSES.join(', '));
  }
  const string = (key: string): string | undefined => {
    const v = value[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') refuse(`${key} at ${where} is not a string`);
    return v;
  };
  const flag = (key: string): boolean | undefined => {
    const v = value[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') refuse(`${key} at ${where} is not a boolean`);
    return v;
  };
  const oneOf = (key: string, allowed: string[]): string | undefined => {
    const v = string(key);
    if (v !== undefined && !allowed.includes(v)) {
      refuse(`${key} at ${where} is ${JSON.stringify(v)}, which is not one of ${allowed.join(', ')}`);
    }
    return v;
  };
  if (value.citations !== undefined && !Array.isArray(value.citations)) {
    refuse(`the citations at ${where} are not an array`);
  }
  if (value.truncatedDocuments !== undefined
    && !(Array.isArray(value.truncatedDocuments)
      && value.truncatedDocuments.every(d => typeof d === 'string'))) {
    refuse(`truncatedDocuments at ${where} is not an array of document names`);
  }
  if (value.netPosition !== undefined && value.netPosition !== null
    && !isRecord(value.netPosition)) {
    refuse(`the net position at ${where} is not an object`);
  }

  // `absentUnless`'s rule applied to a value being BUILT rather than read: a
  // key spread in as `undefined` would reach `toFindingRow` as present, and
  // the difference between an absent `truncatedDocuments` and an empty one is
  // a fact this whole layer exists to keep.
  const content: FindingContent = {
    clauseId,
    status: status as Finding['status'],
    citations: (value.citations ?? []) as FindingContent['citations'],
    ...(string('summary') === undefined ? {} : { summary: string('summary')! }),
    ...(oneOf('riskLevel', RISKS) === undefined ? {}
      : { riskLevel: oneOf('riskLevel', RISKS) as FindingContent['riskLevel'] }),
    ...(string('riskAnalysis') === undefined ? {} : { riskAnalysis: string('riskAnalysis')! }),
    ...(string('error') === undefined ? {} : { error: string('error')! }),
    ...(flag('edited') === undefined ? {} : { edited: flag('edited')! }),
    ...(flag('authError') === undefined ? {} : { authError: flag('authError')! }),
    ...(flag('truncated') === undefined ? {} : { truncated: flag('truncated')! }),
    ...(value.truncatedDocuments === undefined ? {}
      : { truncatedDocuments: value.truncatedDocuments as string[] }),
    ...(flag('noContent') === undefined ? {} : { noContent: flag('noContent')! }),
    ...(isRecord(value.netPosition)
      // Cast through `unknown`: the net position is stored and returned
      // UNREAD at this layer, exactly as `parseReview` treats the blob, so a
      // field-by-field parse here would be a second place deciding what a net
      // position is.
      ? { netPosition: value.netPosition as unknown as FindingContent['netPosition'] } : {}),
    ...(oneOf('positionOutcome', [...OUTCOMES]) === undefined ? {}
      : { positionOutcome: oneOf('positionOutcome', [...OUTCOMES]) as FindingContent['positionOutcome'] }),
    ...(string('positionRationale') === undefined ? {}
      : { positionRationale: string('positionRationale')! }),
  };

  const raw = value.verification;
  if (raw !== undefined && !isRecord(raw)) refuse(`the verification at ${where} is not an object`);
  const v = (raw ?? {}) as Record<string, unknown>;
  const state = (v.state ?? 'unchecked') as VerificationState;
  if (!STATES.includes(state)) {
    refuse(`the verification at ${where} has state ${JSON.stringify(v.state)}, which is not one `
      + `of ${STATES.join(', ')}`);
  }
  const reason = typeof v.reason === 'string' ? v.reason.trim() : undefined;
  if (requiresReason(state) && !reason) {
    refuse(`the finding at ${where} is rejected with no reason. A rejection with no reason is a `
      + 'silent disagreement, useless to whoever reads the export');
  }
  if (state !== 'unchecked') {
    // The same posture as the backfill's: an author and an instant are facts
    // the browser already holds, and inventing either would put somebody's
    // name — or the moment of the autosave — on a judgement they did not make
    // then.
    if (typeof v.byUserId !== 'string' || !v.byUserId) {
      refuse(`the verification at ${where} is ${state} but names nobody`);
    }
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) {
      refuse(`the verification at ${where} is ${state} but has no timestamp`);
    }
  }

  const notes: BlobNote[] = [];
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes)) refuse(`the notes at ${where} are not an array`);
    for (const note of value.notes) {
      if (!isRecord(note)) refuse(`a note at ${where} is not an object`);
      if (typeof note.id !== 'string' || !note.id) refuse(`a note at ${where} has no id`);
      if (typeof note.text !== 'string' || !note.text.trim()) {
        refuse(`note ${JSON.stringify(note.id)} at ${where} has no text`);
      }
      if (typeof note.byUserId !== 'string' || !note.byUserId) {
        refuse(`note ${JSON.stringify(note.id)} at ${where} names no author. A note is a person's `
          + 'remark, and a remark with no somebody behind it is not one anybody can weigh');
      }
      if (typeof note.at !== 'number' || !Number.isFinite(note.at)) {
        refuse(`note ${JSON.stringify(note.id)} at ${where} has no timestamp`);
      }
      notes.push({
        id: note.id, findingId: String(note.findingId ?? ''), text: note.text,
        byUserId: note.byUserId, at: note.at,
      });
    }
  }

  return {
    findingsKey,
    clauseId,
    content,
    verification: {
      state,
      ...(reason ? { reason } : {}),
      ...(typeof v.byUserId === 'string' && v.byUserId ? { byUserId: v.byUserId } : {}),
      ...(typeof v.at === 'number' ? { at: v.at } : {}),
    },
    notes,
  };
}

/**
 * Every person a judgement in this body names, resolved BEFORE anything is
 * written.
 *
 * `note.by_user_id` and `finding_disposition_event.by_user_id` are NOT NULL
 * foreign keys, so an unresolvable author is refused by Postgres whatever this
 * function does — the choice is only whether the reviewer reads a sentence or
 * a constraint name. Compared as TEXT rather than cast to `uuid`, because a
 * value that is not a uuid at all (an id minted by an older browser, say)
 * aborts the cast before the comparison and takes the whole save with it.
 */
async function refuseUnknownAuthors(t: Tx, cells: Cell[]): Promise<void> {
  const wanted = new Map<string, string>();
  for (const cell of cells) {
    const where = `${cell.findingsKey}/${cell.clauseId}`;
    if (cell.verification.state !== 'unchecked' && cell.verification.byUserId) {
      wanted.set(cell.verification.byUserId, `the ${cell.verification.state} verification at ${where}`);
    }
    for (const note of cell.notes) {
      wanted.set(note.byUserId, `note ${JSON.stringify(note.id)} at ${where}`);
    }
  }
  if (wanted.size === 0) return;
  const found = await t.query<{ id: string }>(
    'select id::text as id from app_user where id::text = any($1::text[])',
    [[...wanted.keys()]]);
  const known = new Set(found.map(r => r.id));
  const missing = [...wanted].filter(([id]) => !known.has(id));
  if (missing.length > 0) {
    refuse(missing.map(([id, where]) =>
      `${where} names ${JSON.stringify(id)}, who is not a user of this workspace`).join('; '));
  }
}

const UPSERT = `
  insert into finding (${FINDING_COLUMNS.join(', ')})
  values (${FINDING_COLUMNS.map((c, i) =>
    (c === 'citations' || c === 'net_position' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
  on conflict (review_id, findings_key, clause_id) do update set
    status = excluded.status, summary = excluded.summary, risk_level = excluded.risk_level,
    risk_analysis = excluded.risk_analysis, error = excluded.error,
    auth_error = excluded.auth_error, truncated = excluded.truncated,
    truncated_documents = excluded.truncated_documents, no_content = excluded.no_content,
    edited = excluded.edited, position_outcome = excluded.position_outcome,
    position_rationale = excluded.position_rationale, citations = excluded.citations,
    net_position = excluded.net_position,
    version = finding.version + 1, updated_at = now()
  where finding.workspace_id = excluded.workspace_id`;

/**
 * Every finding in `review.findings`, as rows — inside the caller's
 * transaction, which is the same one that wrote the blob.
 *
 * Deletes nothing it cannot see: it upserts every `(findings_key, clause_id)`
 * the body carries and deletes the rows for keys the body no longer has. A
 * clause removed from a re-saved review must not leave an orphan finding whose
 * disposition still counts toward a standard position's health.
 */
export async function writeFindingRows(
  t: Tx,
  review: { id: string; target: unknown; findings: unknown },
  workspaceId: string,
  actor: { id: string },
): Promise<void> {
  const cells = readFindingsBlob(review.findings, review.target as ReviewTarget);

  // Removed keys first, so a clause that moved between two keys in one save
  // does not delete the row it was just written to.
  await refuseUnknownAuthors(t, cells);
  await t.query(
    `delete from finding f
      where f.review_id = $1 and f.workspace_id = $2
        and not exists (
          select 1 from unnest($3::text[], $4::text[]) as a(k, c)
          where a.k = f.findings_key and a.c = f.clause_id)`,
    [review.id, workspaceId, cells.map(c => c.findingsKey), cells.map(c => c.clauseId)]);

  for (const cell of cells) {
    const key: FindingKey = {
      reviewId: review.id, findingsKey: cell.findingsKey, clauseId: cell.clauseId,
    };
    await t.query(UPSERT, findingValues(toFindingRow(
      cell.content, review.id, cell.findingsKey, workspaceId)));
    await writeDisposition(t, key, workspaceId, cell, actor);
    await writeNotes(t, key, workspaceId, cell);
  }
}

/**
 * The disposition half, and the ONE place in this design where a disposition
 * is written from something other than a deliberate disposition request. The
 * next reader will be right to be suspicious, so:
 *
 * The browser still writes a verification inside the findings blob (it does
 * until Task 19), and dropping it here would lose a human's judgement between
 * Part 3A and Part 3B. So it is translated — but ONLY on a real change, and
 * with the human's own instant, so the history says when they decided rather
 * than when their browser next autosaved. This path is deleted in Task 22,
 * with the blob write it exists to shadow.
 *
 * The comparison is on STATE and REASON, and deliberately not on the actor or
 * the instant. A whole-review save repeats the same verification every two
 * seconds during a run, and a comparison that could see a difference between
 * two identical autosaves would fill the history with a hundred rows and make
 * the one real change unfindable. The actor is compared too, but only when the
 * blob's state is not `unchecked` — a cleared verification carries no author
 * by construction (`resetVerification` drops it), so comparing against the
 * stored one would differ on every single save.
 *
 * `cause` is always `human` here, and that is honest rather than convenient:
 * in Part 3A the server never re-runs anything, so every disposition change
 * this path sees was caused by a person at a browser — including a clearing,
 * which is a person clicking Retry. `rerun_reset` is for the engine acting on
 * its own behalf, which arrives with the server-side re-run in Task 16.
 */
async function writeDisposition(
  t: Tx,
  key: FindingKey,
  workspaceId: string,
  cell: Cell,
  actor: { id: string },
): Promise<void> {
  const stored = await ensureDisposition(t, key, workspaceId);
  const reason = cell.verification.reason ?? null;
  const sameActor = cell.verification.state === 'unchecked'
    || stored.by_user_id === cell.verification.byUserId;
  if (stored.state === cell.verification.state && (stored.reason ?? null) === reason && sameActor) {
    return;
  }
  const cleared = cell.verification.state === 'unchecked';
  await setDisposition(
    t, key,
    { state: cell.verification.state, ...(reason ? { reason } : {}) },
    'human',
    // A cleared verification names nobody in the blob, because
    // `resetVerification` drops the attribution along with the judgement it
    // described. The person who caused the clearing is the one saving, and
    // that is a fact rather than a guess.
    { id: cleared ? actor.id : cell.verification.byUserId! },
    cleared ? new Date() : new Date(cell.verification.at!),
    typeof stored.version === 'number' ? stored.version : Number(stored.version));
}

/** Notes, by id. Added and withdrawn, never edited — the `note` table holds
 *  no UPDATE grant for anybody, so a changed note is a different note. */
async function writeNotes(
  t: Tx, key: FindingKey, workspaceId: string, cell: Cell,
): Promise<void> {
  await t.query(
    `delete from note
      where review_id = $1 and findings_key = $2 and clause_id = $3
        and id <> all($4::text[])`,
    [key.reviewId, key.findingsKey, key.clauseId, cell.notes.map(n => n.id)]);
  for (const note of cell.notes) {
    await t.query(
      `insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [note.id, key.reviewId, key.findingsKey, key.clauseId, workspaceId, note.text,
        note.byUserId, new Date(note.at)]);
  }
}
