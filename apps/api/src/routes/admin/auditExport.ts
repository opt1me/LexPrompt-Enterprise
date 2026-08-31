import type { FastifyInstance } from 'fastify';
import {
  ModelError,
  type AuditExport, type AuditExportManifest, type AuditExportRow, type AuditExportSource,
} from '@lexprompt/core';
import type { Db } from '../../db/pool.ts';

/**
 * THE WORKSPACE'S AUDIT EXTRACT — the artefact that leaves the building.
 *
 * ## Why it carries a manifest
 *
 * §19 names the export as the worst-consequence artefact in this design: a
 * card has a reader who can refresh, a printed document does not. An audit
 * extract is that with legal weight attached — read months later, by
 * somebody who was not there, as evidence. A file with rows in it and no
 * statement of what it covers is a file whose gaps are indistinguishable
 * from absences of activity.
 *
 * So every extract states its workspace, its range, when it was taken, who
 * took it, the time zone the instants are in, and EVERY SOURCE BY NAME with
 * its row count — a source with zero rows is listed with zero, because an
 * omitted source reads as a source that was not covered. That is the
 * blank-CSV-cell defect on an evidence file.
 *
 * ## It REFUSES rather than truncating (P57)
 *
 * One statement per source, `limit $n + 1`. If the extra row comes back the
 * whole request is refused with 413 `export_too_large`, naming the source
 * and asking for a narrower range. A `limit` that silently truncated would
 * produce a file that looks complete and is not — and `complete: true` on
 * the manifest would then be a lie in the one document a firm would treat as
 * evidence.
 *
 * ## The counts come from the rows, not from a second query
 *
 * `count(*)` and a differently-scoped `select` are two claims that can
 * disagree, and the manifest is the thing a reader trusts when they cannot
 * check. Each source's count is `rows.length` for that source, measured
 * after the delivery.
 *
 * ## Three arms, and no fourth
 *
 * `routes/activity.ts`'s three, with the matter predicate removed and the
 * workspace predicate kept. A second query language for the same three
 * tables is exactly the drift S22 was written about; this reads as one
 * statement per source rather than one union only because each source has to
 * be counted and capped separately, which a single union cannot do.
 *
 * A disposition change comes from `finding_disposition_event` and NEVER from
 * `audit_event` (S22) — `AUDIT_ACTIONS` has no disposition verb in it, so an
 * auditor reconciling the two logs finds no discrepancy that is really a
 * duplicate.
 */

export interface AuditExportCaps {
  /** `API_AUDIT_EXPORT_MAX_ROWS` — the ceiling ONE SOURCE may deliver.
   *  DECLARED rather than invented here, like every other cap. */
  maxRows: number;
}

interface FeedRow {
  at: Date;
  source: AuditExportSource;
  kind: string;
  by_user_id: string;
  matter_id: string | null;
  matter_name: string | null;
  review_id: string | null;
  review_name: string | null;
  clause_id: string | null;
  cause: string | null;
  subject_type: string | null;
  subject_id: string | null;
}

/**
 * ONE STATEMENT PER SOURCE, each naming `workspace_id` in its own `where`.
 *
 * Written as three literals so `workspaceScope.test.ts` can read each whole:
 * a statement that guard cannot parse is a statement nothing is checking.
 *
 * The range is INCLUSIVE of `from` and EXCLUSIVE of `to`, so two adjacent
 * extracts neither double-count a row on the boundary nor miss one.
 */
const QUERIES: Record<AuditExportSource, string> = {
  audit_event: `
    select a.at as at, 'audit_event' as source, a.action as kind,
           a.actor_user_id::text as by_user_id, a.matter_id as matter_id,
           m.name as matter_name, a.review_id as review_id, null as review_name,
           null as clause_id, null as cause,
           a.subject_type as subject_type, a.subject_id as subject_id
      from audit_event a
      left join matter m on m.id = a.matter_id and m.workspace_id = a.workspace_id
     where a.workspace_id = $1 and a.at >= $2 and a.at < $3
     order by a.at asc
     limit $4`,
  finding_disposition_event: `
    select e.at as at, 'finding_disposition_event' as source, e.to_state as kind,
           e.by_user_id::text as by_user_id, r.matter_id as matter_id,
           m.name as matter_name, e.review_id as review_id,
           r.playbook_snapshot ->> 'name' as review_name, e.clause_id as clause_id,
           e.cause as cause, null as subject_type, null as subject_id
      from finding_disposition_event e
      join review r on r.id = e.review_id and r.workspace_id = e.workspace_id
      left join matter m on m.id = r.matter_id and m.workspace_id = r.workspace_id
     where e.workspace_id = $1 and e.at >= $2 and e.at < $3
     order by e.at asc
     limit $4`,
  run: `
    select coalesce(n.started_at, n.created_at) as at, 'run' as source, n.state as kind,
           n.requested_by_user_id::text as by_user_id, r.matter_id as matter_id,
           m.name as matter_name, n.review_id as review_id,
           r.playbook_snapshot ->> 'name' as review_name, null as clause_id,
           null as cause, null as subject_type, null as subject_id
      from run n
      join review r on r.id = n.review_id and r.workspace_id = n.workspace_id
      left join matter m on m.id = r.matter_id and m.workspace_id = r.workspace_id
     where n.workspace_id = $1
       and coalesce(n.started_at, n.created_at) >= $2
       and coalesce(n.started_at, n.created_at) < $3
     order by 1 asc
     limit $4`,
};

/** The order the sources are named in, everywhere. A fixed list rather than
 *  `Object.keys`, so a manifest cannot start listing them in whatever order
 *  a runtime happened to build a map in. */
export const AUDIT_EXPORT_SOURCES: AuditExportSource[] = [
  'audit_event', 'finding_disposition_event', 'run',
];

/** Every optional field ABSENT rather than `undefined`-valued — the same
 *  rule `toActivityRow` follows, and it matters more here: this row becomes
 *  a cell in a file somebody reads as evidence. */
function toRow(row: FeedRow): AuditExportRow {
  return {
    at: row.at.getTime(),
    source: row.source,
    kind: row.kind,
    byUserId: row.by_user_id,
    ...(row.matter_id ? { matterId: row.matter_id } : {}),
    ...(row.matter_name ? { matterName: row.matter_name } : {}),
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(row.review_name ? { reviewName: row.review_name } : {}),
    ...(row.clause_id ? { clauseId: row.clause_id } : {}),
    ...(row.cause ? { cause: row.cause } : {}),
    ...(row.subject_type ? { subjectType: row.subject_type } : {}),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
  };
}

/** A bounded range, or a refusal. An UNBOUNDED range is refused rather than
 *  defaulted to everything: "the whole history" is a decision, and a default
 *  would make it one nobody took. */
function rangeOf(query: unknown): { from: number; to: number } {
  const q = (query ?? {}) as { from?: unknown; to?: unknown };
  const from = Number(q.from);
  const to = Number(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new ModelError(
      'An audit extract needs a range: `from` and `to`, in epoch milliseconds. There is no '
      + 'default, deliberately — "everything this workspace has ever done" is a decision '
      + 'somebody makes, not one this route makes for them.',
      'unknown', 400,
    );
  }
  if (to <= from) {
    throw new ModelError(
      'The end of the range must be after its start.', 'unknown', 400);
  }
  return { from, to };
}

export function registerAuditExport(
  app: FastifyInstance, db: Db, caps: AuditExportCaps,
): void {
  app.get('/v1/admin/audit-export', async (req): Promise<AuditExport> => {
    const ws = req.actor!.workspaceId;
    const { from, to } = rangeOf(req.query);
    // TAKEN AT, measured before the reads. Different from `to`, always — and
    // measured at the start so it can never appear to precede a row the
    // extract contains.
    const takenAt = Date.now();

    const rows: AuditExportRow[] = [];
    const sources: AuditExportManifest['sources'] = [];

    for (const source of AUDIT_EXPORT_SOURCES) {
      // `limit + 1`, ONE statement, and the same statement delivers. Never
      // `count(*)` and then `select`: those are two claims about one range
      // and they can disagree, on the one document nobody can check.
      const found = await db.query<FeedRow>(
        QUERIES[source],
        [ws, new Date(from), new Date(to), caps.maxRows + 1]);
      if (found.length > caps.maxRows) {
        throw new ModelError(
          `This range holds more than ${caps.maxRows} rows in ${source} alone, which is more `
          + 'than one extract may carry. LexPrompt refuses rather than delivering part of it: '
          + 'a file whose rows stop at a ceiling nobody stated is a file whose gaps read as '
          + 'absences of activity. Narrow the range and take it in pieces.',
          'export_too_large', 413,
        );
      }
      for (const r of found) rows.push(toRow(r));
      // COUNTED FROM WHAT WAS DELIVERED. A source with zero rows is listed
      // with zero — an omitted source reads as one that was not covered.
      sources.push({ source, rows: found.length });
    }

    // Oldest first across the whole extract, so a reader follows one
    // chronology rather than three.
    rows.sort((a, b) => a.at - b.at);

    return {
      manifest: {
        workspaceId: ws,
        from,
        to,
        takenAt,
        takenByUserId: req.actor!.id,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        sources,
        // TRUE because the alternative was refused above, not because it was
        // asserted here. A future paged export cannot ship without deciding
        // what to put in this field.
        complete: true,
      },
      rows,
    };
  });
}
