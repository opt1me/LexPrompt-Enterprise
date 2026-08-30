import { ModelError, type ReviewTarget } from '@lexprompt/core';
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
 * ## WHOSE JUDGEMENT AN IMPORT MAY RECORD, AND ON WHOSE AUTHORITY
 *
 * **The authenticated actor's, and nobody else's.** A `byUserId` naming
 * anyone else is refused by name, and nothing is written.
 *
 * This file used to pass `cell.verification.byUserId` and `note.byUserId`
 * straight from the request body into `setDisposition` and into the `note`
 * insert, with `cause: 'human'`. Those are the two fields
 * `routes/findings.ts:parseDisposition` refuses BY NAME — *"byUserId and at
 * are the server's — a request that could state them could put somebody
 * else's name on a judgement"* — and this route took both. Any signed-in
 * user could read a colleague's `app_user` id off any review they can see
 * and then `PUT /v1/reviews/<a fresh id>` with a findings map whose
 * verifications carry that id and any instant they chose. The result was a
 * `finding_disposition` row and a `finding_disposition_event` with
 * `cause = 'human'` and the colleague's name on it, indistinguishable at
 * every screen, every export and every `positionHealth` count from a
 * judgement they actually made. The whole point of the event history is
 * that attribution is evidence; it is worth nothing if the current row can
 * be written with an arbitrary name.
 *
 * The old justification here — *"the uploader has already rewritten every
 * `byUserId` to the signed-in person"* — was a client-side guarantee about
 * the one field a client may never state, and it was not even what the
 * uploader promises: `upload/attribution.ts`'s rule 3 deliberately LEAVES
 * ALONE any id it cannot map, and counts it.
 *
 * ## What the server can actually vouch for
 *
 * One identity: the actor on the token. Nothing else in a `PUT` body is
 * evidence of anything. Attributing an imported judgement to a colleague
 * would need a capability that does not exist in this system — an export
 * signed by the workspace it came from, or an importer role the owner
 * granted for a migration and audited afterwards. Neither exists, and
 * inventing a silent one out of a jsonb field is how a forged verification
 * gets into an export. So an import of somebody else's judgement is
 * REFUSED, and the refusal says why. That is a real limit on the uploader:
 * a browser whose local profile could not be read, or whose records carry
 * an id it cannot map (`upload/attribution.ts` rule 3), can no longer move
 * those reviews — and the honest answer is a 400 rather than a row bearing
 * a name the server never verified.
 *
 * ## What it still takes from the body, and why that one is safe
 *
 * The INSTANT. The imported judgement keeps the HUMAN'S OWN INSTANT, not
 * the moment of the upload — an exported review's verification was made
 * weeks ago and stamping it `now()` would say when the network was busy
 * rather than when they decided. It is safe only BECAUSE the name is now
 * the actor's: a person restating when they themselves decided is a claim
 * about their own work, which is a different thing entirely from putting a
 * colleague's name on it. `setDisposition`'s `at` parameter exists for
 * exactly this, and the disposition route refuses it for exactly the other.
 *
 * ## The one path that MAY preserve a foreign attribution
 *
 * `findings/backfill.ts`, the one-time migration, and it is a different
 * authority: it runs as `lexprompt_migrator` inside `runMigrations`, over
 * data this server's OWN routes wrote into `review.findings`, not over a
 * body somebody posted — and it refuses by name any `byUserId` that
 * resolves to no `app_user`. That is provenance the server established
 * itself. A `PUT` body is not.
 */

/**
 * Refuses an imported attribution that names anyone but the actor.
 *
 * One function for the verification and the note, because they are the same
 * claim about the same person, and two copies is how one of them comes to
 * be relaxed. It returns nothing on purpose: the value written below is
 * `actor`, never the body's, so there is no path from a body-supplied id to
 * a column even if this check were somehow skipped.
 */
function refuseForeignAuthor(what: string, byUserId: string, actor: { id: string }): void {
  if (byUserId === actor.id) return;
  throw new ModelError(
    `LexPrompt could not save this review (${what} is attributed to `
    + `${JSON.stringify(byUserId)}, who is not the person signed in. byUserId is the server's `
    + '— a request that could state it could put somebody else\'s name on a judgement. An '
    + 'import may record the signed-in person\'s own judgements and nobody else\'s, because '
    + 'there is no way for this server to check a claim that somebody else made this one. '
    + 'Nothing has been saved).',
    'unknown', 400);
}

export async function importFindings(
  t: Tx,
  reviewId: string,
  workspaceId: string,
  target: ReviewTarget,
  blob: unknown,
  /** The person signed in. The ONLY author an import may record — see the
   *  attribution section above. Required rather than optional, so a caller
   *  that does not have one cannot import at all. */
  actor: { id: string },
): Promise<void> {
  const cells = readFindingsBlob(blob, target);

  // EVERY attribution in the whole map is checked BEFORE the first row is
  // written. A refusal partway through would roll back — this runs inside
  // the route's one transaction — but the reader would be told about the
  // ninth cell while the first was already wrong, and a check interleaved
  // with its own writes is one somebody later moves inside the `if` that
  // skips it.
  for (const cell of cells) {
    const where = `${cell.findingsKey}/${cell.clauseId}`;
    if (cell.verification.state !== 'unchecked') {
      refuseForeignAuthor(`the ${cell.verification.state} verification at ${where}`,
        cell.verification.byUserId!, actor);
    }
    for (const note of cell.notes) {
      refuseForeignAuthor(`the note ${JSON.stringify(note.id)} at ${where}`, note.byUserId, actor);
    }
  }

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
        // `actor`, NEVER `cell.verification.byUserId`. The body's id has
        // already been refused above unless it IS this one; passing the
        // actor rather than the (now equal) body value is what leaves no
        // expression here that a forged name could travel through.
        { id: actor.id, workspaceId },
        new Date(cell.verification.at!),
        Number(row.version));
    }

    for (const note of cell.notes) {
      await t.query(
        `insert into note (id, review_id, findings_key, clause_id, workspace_id, text,
                           by_user_id, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        // `actor.id` for the same reason, and the note's own instant for the
        // same reason as the verification's.
        [note.id, reviewId, cell.findingsKey, cell.clauseId, workspaceId, note.text,
          actor.id, new Date(note.at)]);
    }
  }
}
