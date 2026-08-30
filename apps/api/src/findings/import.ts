import type { ReviewTarget } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import {
  FINDING_COLUMNS, findingValues, toFindingRow, type FindingKey,
} from './rows.ts';
import { readFindingsBlob } from './reconcile.ts';
import { ensureDisposition, setDisposition } from '../dispositions/service.ts';

/**
 * A review's findings, ARRIVING WHOLE, written as rows.
 *
 * ## The one thing that may still hand this service a findings map
 *
 * `PUT /v1/reviews/:id` refuses a body carrying findings for a review that
 * ALREADY EXISTS (Task 22): the blob is frozen, each finding is written by
 * the run that produced it and each judgement by its own route, and a client
 * that believes it saved sixty findings and did not is the shape of half the
 * defects on `CLAUDE.md`'s list. What is left is the IMPORT — the uploader
 * moving a whole exported dataset into this workspace, a review at a time,
 * for a review this workspace has never seen.
 *
 * That path cannot be answered by a refusal. An exported review's findings
 * carry verifications, rejection reasons and notes: a lawyer's judgements,
 * which is the content this application exists to record. Dropping them on
 * import would be a silent loss of exactly that; refusing the whole review
 * would leave the uploader unable to move a review at all. So they are
 * WRITTEN, as rows — never into the frozen column, which nothing writes.
 *
 * ## Why it inserts rather than reconciles
 *
 * This is not `writeFindingRows` returning. That function existed to keep
 * the rows in step with a blob a browser re-saved every two seconds, so it
 * upserted, compared each judgement against the stored one, and decided
 * whether a change had really happened. There is no such stream any more and
 * no blob to shadow: an import happens once, for a review with no rows, and
 * a second import of the same id is refused by the route before it reaches
 * here. So this INSERTS, and a duplicate key is a loud failure rather than a
 * silent overwrite.
 *
 * Built out of the shipped pieces rather than beside them —
 *
 *  - `readFindingsBlob` (the reader that survived into `reconcile.ts`) turns
 *    the body into cells, so a map this cannot store faithfully — a note
 *    naming nobody, a rejection with no reason, a findings key this review's
 *    own target does not explain — is refused BY NAME with a 400 rather than
 *    landing as a half-written row or a Postgres constraint message;
 *  - `toFindingRow`/`FINDING_COLUMNS` write the content, so a column added
 *    to `finding` and forgotten here is a compile error rather than a field
 *    that silently stops being imported;
 *  - `ensureDisposition`/`setDisposition` write the judgement, so the history
 *    row is written by the one module that writes either table, and an
 *    import cannot produce a disposition with no event behind it.
 *
 * The imported judgement keeps the HUMAN'S OWN INSTANT, not the moment of
 * the upload. The uploader has already rewritten every `byUserId` to the
 * signed-in person (`upload/attribution.ts`) — the server does not look
 * inside a findings map for that, which is exactly why the browser has to —
 * and `setDisposition`'s foreign key refuses an author this workspace does
 * not have.
 */
export async function importFindings(
  t: Tx,
  reviewId: string,
  workspaceId: string,
  target: ReviewTarget,
  blob: unknown,
): Promise<void> {
  const cells = readFindingsBlob(blob, target);
  for (const cell of cells) {
    await t.query(
      `insert into finding (${FINDING_COLUMNS.join(', ')})
       values (${FINDING_COLUMNS.map((c, i) =>
        (c === 'citations' || c === 'net_position' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
      findingValues(toFindingRow(cell.content, reviewId, cell.findingsKey, workspaceId)));

    const key: FindingKey = { reviewId, findingsKey: cell.findingsKey, clauseId: cell.clauseId };
    const row = await ensureDisposition(t, key, workspaceId);
    if (cell.verification.state !== 'unchecked') {
      // The human's OWN instant, not now(). A fixture that stamped the
      // present would make every "the history says when they decided"
      // assertion vacuous.
      await setDisposition(
        t, key,
        {
          state: cell.verification.state,
          ...(cell.verification.reason ? { reason: cell.verification.reason } : {}),
        },
        'human',
        { id: cell.verification.byUserId! },
        new Date(cell.verification.at!),
        Number(row.version));
    }

    for (const note of cell.notes) {
      await t.query(
        `insert into note (id, review_id, findings_key, clause_id, workspace_id, text,
                           by_user_id, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [note.id, reviewId, cell.findingsKey, cell.clauseId, workspaceId, note.text,
          note.byUserId, new Date(note.at)]);
    }
  }
}
