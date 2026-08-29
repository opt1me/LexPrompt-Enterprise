import type { FastifyInstance } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import { fromReviewRow, toReviewRow, type Review, type ReviewRow } from '../db/rows.ts';
import { refuseForeignDocuments } from './matterMembership.ts';

/**
 * The `reviews` repository, server side — Task 9's seven properties, plus
 * the three things that are true of this table and of no other.
 *
 * ## 1. It is the largest record by far, and it is written repeatedly
 *
 * A 3-document x 20-clause review holds sixty findings with citations, and
 * the debounced saver writes the WHOLE record every two seconds during a
 * run. That was cheap over IndexedDB and is not over HTTP. It stays a
 * whole-record write in Stage 2 anyway (P11) — findings become rows in Stage
 * 3, with the engine that forces it — so the size of the body is a real
 * constraint here rather than a hypothetical. `API_MAX_BODY_BYTES` (16 MiB,
 * declared, reported in the boot banner, and applied to multipart too) is
 * what governs it, and the review path must not become the second place a
 * body limit surprises somebody.
 *
 * ## 2. A stale write is REFUSED, and that is the whole point
 *
 * Verification state is set only by a human action and nothing derives it
 * (CLAUDE.md). The failure available here is a run's debounced saver — which
 * holds its own copy of the review and knows nothing about anyone else's
 * writes — overwriting a verification somebody recorded seconds ago, with
 * nothing on any screen to show it. `carryHumanState` closes that WITHIN one
 * tab; nothing could close it across two, because the second tab's write was
 * never in the first tab's snapshot to carry.
 *
 * So `where review.version = $N` on the DO UPDATE is load-bearing in the
 * strongest sense in this file: it turns "your colleague's verification was
 * silently erased" into "this review is not saving", which the browser puts
 * on screen. A refused save costs a reload; an applied one costs a lawyer's
 * judgement.
 *
 * ## 3. A review may only INTRODUCE documents in its own matter
 *
 * `ReviewTarget` carries document ids, and a target pointing outside the
 * matter is a review that would cite the wrong client's document. Checked in
 * the SAME transaction as the write, so a document moved between the check
 * and the insert cannot slip through.
 *
 * Scoped to the ids a write ADDS, though — never re-run over the ids the
 * stored row already holds. Deleting a document from a matter is a single
 * click that touches no review, and re-validating a historical review's own
 * ids against today's membership made every later save of it fail 400
 * forever: a review that still opened, still read, and could never record
 * another verification. See the block that does it for the long form.
 */
export function registerReviews(app: FastifyInstance, db: Db): void {
  app.get('/v1/matters/:id/reviews', async (req): Promise<Review[]> => {
    const { id } = req.params as { id: string };
    // Most recently started first, tiebroken on write sequence descending —
    // the order `listReviews` sorted for itself, moved to where the database
    // can do it.
    const rows = await db.query<ReviewRow>(
      `select * from review where matter_id = $1 and workspace_id = $2
       order by started_at desc, seq desc`,
      [id, req.actor!.workspaceId]);
    return rows.map(fromReviewRow);
  });

  app.get('/v1/reviews/:id', async (req): Promise<Review> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<ReviewRow>(
      'select * from review where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such review.', 'not_found', 404);
    return fromReviewRow(rows[0]);
  });

  // NOT `app.put<{ Params: … }>(…)` — see `matters.ts`'s note.
  app.put('/v1/reviews/:id', async (req): Promise<Review> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const input = parseReview(id, req.body);
    const row = toReviewRow({ ...input, createdByUserId: req.actor!.id }, ws);

    return db.tx(async t => {
      // The matter, IN THIS WORKSPACE. 404 rather than 403: a 403 would
      // confirm the matter id exists somewhere.
      const matter = await t.query<{ id: string }>(
        'select id from matter where id = $1 and workspace_id = $2', [input.matterId, ws]);
      if (!matter[0]) {
        throw new ModelError(
          `There is no matter ${input.matterId} for this review to belong to.`, 'not_found', 404);
      }

      // `playbook_version_id` is a FOREIGN KEY, and an id naming no version
      // in this workspace reaches Postgres as a constraint violation — a 500
      // carrying a raw `review_playbook_version_id_fkey` message, which is
      // exactly the shape `registerErrorEnvelope` exists to replace. Checked
      // here so the refusal names the cause and the repair.
      //
      // It CAN happen, and only one way: deleting a playbook clears this
      // pointer on every review that named one of its versions (R-D4, in
      // `playbooks.ts`), so a browser holding a copy read BEFORE that delete
      // still carries the old id. Refusing is recoverable — reload, save
      // again — and is the honest answer, because the alternative is storing
      // NULL for it silently, which would tell a later reader that no
      // version was ever recorded for a review that ran against one.
      //
      // WORTH KNOWING, and reported as a finding: with this foreign key in
      // place a DANGLING `playbookVersionId` cannot be stored at all, so
      // R-D15's distinction between "never recorded" and "recorded, then
      // deleted" is not representable server-side. `reviewMigration.ts`
      // still keeps a stale id on READ and `ReviewVersionLine` still renders
      // the difference — but only until the review is next saved.
      if (input.playbookVersionId !== undefined) {
        const version = await t.query<{ id: string }>(
          'select id from playbook_version where id = $1 and workspace_id = $2',
          [input.playbookVersionId, ws]);
        if (!version[0]) {
          throw new ModelError(
            `This review names playbook version ${input.playbookVersionId}, which is no longer `
            + 'here — its playbook has been deleted since this review was opened. Reload the '
            + 'review and save again; nothing about it has been lost.',
            'conflict', 400);
        }
      }

      // Every document this write INTRODUCES must be IN THIS MATTER. A
      // review citing a document from another matter is the wrong client's
      // contract quoted with apparent authority — the failure S23 exists to
      // prevent, one table early. Checked inside the transaction, so a
      // document moved between the check and the write cannot slip through.
      //
      // INTRODUCES, not "names": the ids the stored row already holds are
      // grandfathered, and that distinction is the whole of this block.
      // Removing a document from a matter is one click that touches no
      // review (`handleRemoveMatterDocument`), and spec §9 deliberately
      // keeps such a review OPENABLE — `openReview` renders a placeholder
      // saying the document was removed. Re-validating the ids already on
      // the row turned that into a review that opens, reads, and can never
      // be written again: every verification, note, net-position
      // confirmation, retry and auto-save on it answered 400, permanently,
      // with no UI anywhere that can edit a stored review's `documentIds`.
      // A review is the record of what was examined; the matter's
      // membership having changed since does not make that record false, and
      // "the reviewer must never see a state the store did not actually
      // take" is not survivable by a store that refuses every take.
      //
      // The guard is not weakened by this, because an id can only be in the
      // stored row's set by having passed this same check on the write that
      // first put it there, and `matter_id` is NOT in the DO UPDATE list —
      // so a review cannot be walked into another matter and have its ids
      // re-read as native there.
      //
      // `and kind = 'matter'` (Task 19, §11.1). A precedent document is
      // somebody else's deal, and a review naming one would cite the wrong
      // client's lease with this app's full authority. REFUSED by the API,
      // not merely absent from a picker: a picker that omits it is a UI
      // convention, and S23 is explicit that this distinction has to survive
      // somebody writing a new query.
      //
      // The predicate is redundant TODAY — `matter_id` is nullable now, so
      // joining on it already excludes precedents — and relying on that is
      // exactly the convention S23 refuses. A predicate that is redundant
      // today and load-bearing after the next schema change is the cheap
      // half of the ruling.
      const held = await t.query<{ document_ids: unknown; target: unknown }>(
        'select document_ids, target from review where id = $1 and workspace_id = $2',
        [row.id, ws]);
      const already = new Set(held[0] ? documentIdsIn(held[0]) : []);
      const ids = documentIdsIn(input).filter(docId => !already.has(docId));
      if (ids.length > 0) {
        const found = await t.query<{ id: string }>(
          `select id from document
           where workspace_id = $1 and matter_id = $2 and kind = 'matter' and id = any($3::text[])`,
          [ws, input.matterId, ids]);
        if (found.length !== ids.length) {
          const missing = ids.filter(docId => !found.some(r => r.id === docId));
          throw await refuseForeignDocuments(t, ws, missing, 'review');
        }
      }

      // Every jsonb parameter is a JSON STRING with an explicit `::jsonb`
      // cast. `pg` serialises a plain object into `json` correctly, but an
      // ARRAY parameter is ambiguous — `text[]` or `jsonb`? — and getting it
      // wrong is a cryptic type error at run time rather than at typecheck.
      // `document_ids` and a finding's citation arrays are both arrays.
      const rows = await t.query<ReviewRow>(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, playbook_version_id,
                             document_ids, target, findings, model_id, started_at, completed_at,
                             cancelled_at, created_by_user_id)
         values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $14)
         on conflict (id) do update set
           playbook_snapshot = excluded.playbook_snapshot,
           playbook_version_id = excluded.playbook_version_id,
           document_ids = excluded.document_ids, target = excluded.target,
           findings = excluded.findings, model_id = excluded.model_id,
           completed_at = excluded.completed_at, cancelled_at = excluded.cancelled_at,
           version = review.version + 1
         where review.workspace_id = $2 and review.version = $13
         returning *`,
        [row.id, ws, row.matter_id, row.playbook_snapshot, row.playbook_version_id,
          row.document_ids, row.target, row.findings, row.model_id, row.started_at,
          row.completed_at, row.cancelled_at, input.version ?? null, row.created_by_user_id]);
      if (!rows[0]) {
        // THE REFUSAL THAT MATTERS. The row moved on — another tab, another
        // person — so applying this write would overwrite work nobody has
        // seen, and a verification is the one thing in this record that only
        // a human can put there. The CURRENT row travels with the refusal so
        // a caller can show what replaced it without a second round trip.
        const current = await t.query<ReviewRow>(
          'select * from review where id = $1 and workspace_id = $2', [row.id, ws]);
        throw new ConflictError(current[0] ? fromReviewRow(current[0]) : undefined);
      }
      return fromReviewRow(rows[0]);
    });
  });

  app.delete('/v1/reviews/:id', async (req, reply): Promise<void> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<{ id: string }>(
      'delete from review where id = $1 and workspace_id = $2 returning id',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such review.', 'not_found', 404);
    await reply.code(204).send();
  });
}

/**
 * Every document id a review claims to cover, from the target AND from
 * `documentIds`.
 *
 * Both, because `documentIds` is a convenience MIRROR of the ids nested in
 * `target` and the two are written separately — so checking only one leaves
 * the other free to name a document from somebody else's matter. The union
 * is de-duplicated, since the two normally agree.
 *
 * Read off ANY carrier of the pair: the parsed body, or a stored `review`
 * row. ONE function rather than two, because "which ids does this review
 * claim to cover" must mean exactly the same thing when the answer decides
 * what to REFUSE as it does when the answer decides what to GRANDFATHER —
 * two copies drifting apart here would either re-open C1 or re-open the hole
 * C1 was fixed without opening.
 */
function documentIdsIn(carrier: { documentIds?: unknown; target?: unknown }): string[] {
  const strings = (value: unknown): string[] => (Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
    : []);
  // A stored row's jsonb arrives parsed from `pg`, but `toReviewRow` writes
  // it as a JSON STRING, so a value read back through a path that did not
  // parse it would be a string. Handled rather than assumed: reading `[` as
  // an id is not a failure anything downstream would name.
  const parse = (value: unknown): unknown =>
    (typeof value === 'string' ? JSON.parse(value) as unknown : value);
  const target = parse(carrier.target) as { documentIds?: unknown } | null;
  return [...new Set([...strings(parse(carrier.documentIds)), ...strings(target?.documentIds)])];
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this review (${detail}).`, 'unknown', 400);
}

/**
 * The body, checked rather than cast.
 *
 * `findings` and `playbookSnapshot` are stored and returned UNREAD beyond
 * their outer shape. That is deliberate and it is what keeps an ABSENT
 * optional key absent: `positionOutcome` missing means "no standard position
 * to compare against" and `'unclear'` means "we have one and could not tell"
 * — different facts, and only the first should produce no comparison. A
 * parser that rebuilt each finding field by field would have to decide what
 * to do with every key it did not know about, and the honest answer for a
 * jsonb blob is to not touch it.
 */
export function parseReview(id: string, body: unknown): Review & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== id) {
    bad(`the body's id ${JSON.stringify(b.id)} is not the one in the URL`);
  }
  const matterId = typeof b.matterId === 'string' ? b.matterId.trim() : '';
  if (!matterId) bad('matterId is missing or empty');
  if (typeof b.playbookSnapshot !== 'object' || b.playbookSnapshot === null
    || Array.isArray(b.playbookSnapshot)) {
    // A review that cannot say what it claims to have checked is worse than
    // no review — `playbookSnapshot` is the whole basis of "ran against v4".
    bad('playbookSnapshot is missing or is not an object');
  }
  if (typeof b.target !== 'object' || b.target === null || Array.isArray(b.target)) {
    bad('target is missing or is not an object');
  }
  const kind = (b.target as { kind?: unknown }).kind;
  if (kind !== 'documents' && kind !== 'collection') {
    bad(`the target's kind is ${JSON.stringify(kind)}, which is not documents or collection`);
  }
  if (!Array.isArray(b.documentIds)
    || !b.documentIds.every(v => typeof v === 'string' && v !== '')) {
    bad('documentIds is missing or contains something that is not a document id');
  }
  if (typeof b.findings !== 'object' || b.findings === null || Array.isArray(b.findings)) {
    // An ARRAY of findings would be a different record shape entirely, and
    // the `jsonb_typeof(findings) = 'object'` check would refuse it anyway —
    // named here so the refusal says which field.
    bad('findings is missing or is not an object');
  }
  if (typeof b.modelId !== 'string' || !b.modelId) bad('modelId is missing or empty');
  if (typeof b.startedAt !== 'number' || !Number.isFinite(b.startedAt)) {
    bad('startedAt is missing or is not a timestamp');
  }
  const time = (key: 'completedAt' | 'cancelledAt') =>
    (typeof b[key] === 'number' && Number.isFinite(b[key]) ? { [key]: b[key] as number } : {});
  if (b.version !== undefined && !Number.isInteger(b.version)) {
    bad('version is present but is not a whole number');
  }
  return {
    id,
    matterId,
    playbookSnapshot: b.playbookSnapshot,
    // ABSENT, never `playbookVersionId: undefined`. R-D4 makes it optional
    // because a review whose playbook was deleted has no version to point
    // at, and "never recorded" must stay distinguishable from "recorded,
    // then deleted".
    ...(typeof b.playbookVersionId === 'string' && b.playbookVersionId
      ? { playbookVersionId: b.playbookVersionId } : {}),
    documentIds: b.documentIds as string[],
    target: b.target,
    findings: b.findings,
    modelId: b.modelId,
    startedAt: b.startedAt,
    ...time('completedAt'),
    ...time('cancelledAt'),
    // Read off the body and DISCARDED — the handler replaces it with the
    // authenticated actor.
    createdByUserId: '',
    ...(typeof b.version === 'number' ? { version: b.version } : {}),
  };
}
