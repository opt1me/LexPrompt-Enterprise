import type { ReviewTarget } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import { toFindingRow, type FindingRow } from './rows.ts';
import { readFindingsBlob, type Cell } from './write.ts';

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
