import {
  ModelError, OUTCOMES, effectiveReason, findingsKeyFor, requiresReason,
  type Finding, type ReviewTarget, type VerificationState,
} from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import { toFindingRow, type FindingContent, type FindingRow } from './rows.ts';

/**
 * Every difference between `review.findings` and the `finding` /
 * `finding_disposition` / `note` rows for one review, as a list a human can
 * read. Empty means they agree.
 *
 * Compared BY KEY and field by field, never by count: a count-only check
 * passes when two findings swap places. The fields compared are every one
 * `toFindingRow` writes, plus the disposition's state, reason, actor and
 * instant and the notes' ids, authors, text and instants — that is, exactly
 * what a reader would lose if the flip in Task 14 were wrong.
 *
 * This exists to FIND something. A reconciliation that has only ever been
 * observed returning `[]` is a reconciliation that returns `[]`, and this
 * project has shipped a scanner that matched nothing — so its own suite
 * corrupts a row directly in SQL and asserts the discrepancy names the key.
 */

export interface Discrepancy {
  /** `findingsKey/clauseId`, or `findingsKey/clauseId/noteId` for a note. */
  key: string;
  field: string;
  blob: string;
  rows: string;
}

interface ReviewRowSlice {
  target: unknown;
  findings: unknown;
  workspace_id: string;
}

interface DispositionSlice {
  findings_key: string;
  clause_id: string;
  state: string;
  reason: string | null;
  by_user_id: string | null;
  at: Date | null;
}

interface NoteSlice {
  id: string;
  findings_key: string;
  clause_id: string;
  text: string;
  by_user_id: string;
  at: Date;
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** A value as a string a person can read in a failure message. `undefined`
 *  and `null` are rendered distinctly, because absent and empty are different
 *  facts everywhere else in this codebase and a diff that blurred them would
 *  be unreadable at the moment it mattered. */
function show(value: unknown): string {
  if (value === undefined) return '(absent)';
  if (value === null) return '(null)';
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v);
    return ms(a) === ms(b);
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return (a ?? null) === (b ?? null);
}

/** The `finding` columns compared, and the ONE list of them — derived from
 *  `toFindingRow`'s own output so a column added there cannot be forgotten
 *  here. */
const IDENTITY = new Set(['review_id', 'findings_key', 'clause_id', 'workspace_id']);

export async function reconcileFindings(t: Tx, reviewId: string): Promise<Discrepancy[]> {
  const reviews = await t.query<ReviewRowSlice>(
    'select target, findings, workspace_id from review where id = $1', [reviewId]);
  if (!reviews[0]) {
    return [{ key: reviewId, field: 'review', blob: '(no such review)', rows: '(nothing)' }];
  }
  const ws = reviews[0].workspace_id;
  const cells = readFindingsBlob(
    parsedJson(reviews[0].findings), parsedJson(reviews[0].target) as ReviewTarget);
  const byKey = new Map<string, Cell>(cells.map(c => [`${c.findingsKey}/${c.clauseId}`, c]));

  const out: Discrepancy[] = [];

  // ---- the findings themselves ----
  const rows = await t.query<FindingRow>(
    'select * from finding where review_id = $1 and workspace_id = $2', [reviewId, ws]);
  const rowByKey = new Map(rows.map(r => [`${r.findings_key}/${r.clause_id}`, r]));
  for (const [key, cell] of byKey) {
    const row = rowByKey.get(key);
    if (!row) {
      out.push({ key, field: 'finding', blob: 'present in the blob', rows: '(nothing)' });
      continue;
    }
    const expected = toFindingRow(cell.content, reviewId, cell.findingsKey, ws) as
      unknown as Record<string, unknown>;
    const actual = row as unknown as Record<string, unknown>;
    for (const column of Object.keys(expected)) {
      if (IDENTITY.has(column)) continue;
      const a = column === 'citations' || column === 'net_position'
        ? parsedJson(expected[column]) : expected[column];
      const b = column === 'citations' || column === 'net_position'
        ? parsedJson(actual[column]) : actual[column];
      if (!same(a, b)) {
        out.push({ key, field: column, blob: show(a), rows: show(b) });
      }
    }
  }
  for (const key of rowByKey.keys()) {
    if (!byKey.has(key)) {
      out.push({ key, field: 'finding', blob: '(nothing)', rows: 'a row the blob no longer has' });
    }
  }

  // ---- the dispositions ----
  const dispositions = await t.query<DispositionSlice>(
    `select findings_key, clause_id, state, reason, by_user_id::text as by_user_id, at
     from finding_disposition where review_id = $1 and workspace_id = $2`, [reviewId, ws]);
  const dispByKey = new Map(dispositions.map(d => [`${d.findings_key}/${d.clause_id}`, d]));
  for (const [key, cell] of byKey) {
    const stored = dispByKey.get(key);
    if (!stored) {
      out.push({ key, field: 'disposition', blob: cell.verification.state, rows: '(nothing)' });
      continue;
    }
    if (stored.state !== cell.verification.state) {
      out.push({ key, field: 'disposition.state',
        blob: cell.verification.state, rows: stored.state });
    }
    if ((stored.reason ?? null) !== (cell.verification.reason ?? null)) {
      out.push({ key, field: 'disposition.reason',
        blob: show(cell.verification.reason), rows: show(stored.reason) });
    }
    // The actor and the instant are compared only on a judgement that HAS one.
    // A cleared verification carries neither by construction
    // (`resetVerification` drops them), and the disposition records who
    // cleared it — a fact the blob deliberately no longer holds, not a
    // disagreement.
    if (cell.verification.state !== 'unchecked') {
      if (stored.by_user_id !== cell.verification.byUserId) {
        out.push({ key, field: 'disposition.byUserId',
          blob: show(cell.verification.byUserId), rows: show(stored.by_user_id) });
      }
      if (stored.at?.getTime() !== cell.verification.at) {
        out.push({ key, field: 'disposition.at',
          blob: show(cell.verification.at), rows: show(stored.at) });
      }
    }
  }
  for (const key of dispByKey.keys()) {
    if (!byKey.has(key)) {
      out.push({ key, field: 'disposition', blob: '(nothing)', rows: 'a disposition for a finding the blob no longer has' });
    }
  }

  // ---- the notes ----
  const notes = await t.query<NoteSlice>(
    `select id, findings_key, clause_id, text, by_user_id::text as by_user_id, at
     from note where review_id = $1 and workspace_id = $2`, [reviewId, ws]);
  const noteByKey = new Map(notes.map(n => [`${n.findings_key}/${n.clause_id}/${n.id}`, n]));
  for (const cell of cells) {
    for (const note of cell.notes) {
      const key = `${cell.findingsKey}/${cell.clauseId}/${note.id}`;
      const stored = noteByKey.get(key);
      if (!stored) {
        out.push({ key, field: 'note', blob: 'present in the blob', rows: '(nothing)' });
        continue;
      }
      if (stored.text !== note.text) {
        out.push({ key, field: 'note.text', blob: note.text, rows: stored.text });
      }
      if (stored.by_user_id !== note.byUserId) {
        out.push({ key, field: 'note.byUserId', blob: note.byUserId, rows: stored.by_user_id });
      }
      if (stored.at.getTime() !== note.at) {
        out.push({ key, field: 'note.at', blob: show(note.at), rows: show(stored.at) });
      }
    }
  }
  const blobNoteKeys = new Set(cells.flatMap(c =>
    c.notes.map(n => `${c.findingsKey}/${c.clauseId}/${n.id}`)));
  for (const key of noteByKey.keys()) {
    if (!blobNoteKeys.has(key)) {
      out.push({ key, field: 'note', blob: '(nothing)', rows: 'a note the blob no longer has' });
    }
  }

  return out;
}

/** The list as lines, for a failure message or a log. */
export function describeDiscrepancies(found: Discrepancy[]): string {
  return found.map(d => `${d.key}: ${d.field} — the blob says ${d.blob}, the rows say ${d.rows}`)
    .join('\n');
}

/* ------------------------------------------------------------------ *
 *  Reading the FROZEN blob                                            *
 * ------------------------------------------------------------------ */

/**
 * `readFindingsBlob` AND ITS HELPERS MOVED HERE FROM `findings/write.ts`,
 * WHICH IS DELETED (Task 22).
 *
 * That module was the shadow writer (P17): it kept `finding`,
 * `finding_disposition` and `note` in step with `review.findings` inside the
 * same transaction that wrote the blob, so there was never only one copy of
 * a judgement inside the change that altered it. The blob is frozen now
 * (migration 010) and no application role may update it, so there is nothing
 * left to shadow and the writer goes.
 *
 * What does NOT go is the READER, because `reconcileFindings` is the one
 * tool for a future doubt about the migration and it works for exactly as
 * long as the frozen column exists (P18, interface note 11). It lives here
 * rather than in a module named `write.ts` that no longer writes: one module
 * reads the frozen blob, and it is the one that compares it against the
 * rows.
 *
 * Unchanged from the version that shipped, deliberately - this is a move,
 * not a rewrite. The one thing to know about it is what its own docstring
 * below says: it reads the blob a SECOND time, for a different purpose from
 * `parseReview`'s, and refuses by name anything it cannot read faithfully.
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
      // `effectiveReason`, NOT the raw one. A reason on anything but
      // `rejected` is dropped when it is stored (`setDisposition`), so a cell
      // that kept it here compared an undropped blob value against a dropped
      // stored one — never equal, on every autosave, forever. The result was
      // a fresh `finding_disposition_event` row roughly every two seconds of
      // a live run for one flagged clause, in the table 006 calls evidence,
      // and a `reconcileFindings` discrepancy that no number of saves could
      // clear.
      ...(effectiveReason(state, reason) ? { reason: effectiveReason(state, reason)! } : {}),
      ...(typeof v.byUserId === 'string' && v.byUserId ? { byUserId: v.byUserId } : {}),
      ...(typeof v.at === 'number' ? { at: v.at } : {}),
    },
    notes,
  };
}
