import type { FastifyInstance } from 'fastify';
import {
  ModelError, NetPositionError, amendPosition, confirmPosition, uid,
  type DispositionEventView, type DispositionHistory, type DispositionView,
  type DispositionWriteResult, type NetPosition, type NetPositionAction,
  type NetPositionWriteResult, type Note, type VerificationState,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import { readFindings, type FindingsRead } from '../findings/read.ts';
import { appendEvent } from '../run/events.ts';
import type { FindingKey } from '../findings/rows.ts';
import {
  readDispositionEvents, setDisposition, toDispositionView, toEventView,
  type DispositionEventRow, type DispositionRow,
} from '../dispositions/service.ts';

/**
 * The findings routes: Task 14's read, and Task 15's human writes.
 *
 * ## THE ONLY WRITERS ARE PEOPLE
 *
 * Everything below is a request a person made. There is no body field that
 * can make one of these writes look like anything else — see `cause` in the
 * disposition handler — and the run worker connects as `lexprompt_worker`,
 * which holds no grant on `finding_disposition`, `finding_disposition_event`
 * or (for writing) `note`. That is enforced by Postgres, not by this file:
 * a path that needed the engine to write one of these would fail at the
 * database rather than be caught in review.
 *
 * ## The read
 *
 * `GET /v1/reviews/:id/findings` is Task 14's flip: a finding's answer, a
 * person's judgement about it and their notes on it are READ FROM ROWS. A
 * review this workspace cannot see answers 404 rather than an empty findings
 * map — "this review has no findings yet" and "this review is not yours / is
 * gone" render identically once one has been flattened into `{}`, and a
 * findings pane that says nothing was found about a contract is the founding
 * defect of this project.
 */
export function registerFindings(app: FastifyInstance, db: Db): void {
  app.get('/v1/reviews/:id/findings', async (req): Promise<FindingsRead> => {
    const { id } = req.params as { id: string };
    return readFindings(db, id, req.actor!.workspaceId);
  });

  /**
   * A person's judgement about one answer.
   *
   * AWAIT-THEN-APPLY at the other end of the wire: this returns the row the
   * store actually took, and the browser renders that and nothing else. A
   * stale `version` is REFUSED with 409 carrying the current row
   * (`ConflictError`, raised inside `setDisposition`) — never merged, never
   * retried. P25: the refusal is the feature. The alternative is silently
   * overwriting a judgement the writer never saw, and a verification is the
   * one thing in this system that only a human can put there.
   *
   * Stage 4 puts *"Priya changed this to Rejected at 14:22, after you loaded
   * it"* on that refusal; Stage 3 shows a plain one (P28). Half of an
   * attribution surface is not built here.
   */
  app.put('/v1/reviews/:id/findings/:findingsKey/:clauseId/disposition',
    async (req): Promise<DispositionWriteResult> => {
      const ws = req.actor!.workspaceId;
      const key = keyOf(req.params);
      const body = parseDisposition(req.body);

      return db.tx(async t => {
        await requireFinding(t, key, ws);
        const disposition = await asView(() => setDisposition(
          t, key, { state: body.state, ...(body.reason ? { reason: body.reason } : {}) },
          // NOT FROM THE BODY. A request can only ever produce `cause =
          // 'human'`; `'rerun_reset'` is written by the retry handler alone.
          // A body field here would be a way for a client to write a history
          // row that lies about why a judgement moved — and `rerun_reset`
          // is the cause the database lets move a disposition without a
          // person behind it.
          'human',
          // NOT FROM THE BODY EITHER. The actor and the instant are the
          // server's; a client that could state them could put somebody
          // else's name on a rejection.
          { id: req.actor!.id }, new Date(), body.version));
        const events = await readDispositionEvents(t, key, ws, 1);
        const event = eventWritten(events[0]);
        /*
         * THE PUSH, IN THE TRANSACTION THAT WROTE THE ROW (§8, Task 15).
         *
         * `appendEvent` takes a `Tx` and that signature is the rule: a push
         * that commits while its write rolls back is a client told about a
         * judgement that does not exist, and — the worse half — has no way
         * to find out.
         *
         * The payload carries the WHOLE new disposition row AND the event
         * that produced it, which is §8 verbatim. That is what lets a
         * receiving card render "Rejected by R. Okafor, 16:04 — was
         * Verified" from one frame with no second query, and it is exactly
         * the pair this handler already has in hand.
         */
        await appendEvent(t, {
          workspaceId: ws,
          type: 'finding.disposition_changed',
          reviewId: key.reviewId,
          payload: {
            reviewId: key.reviewId,
            findingsKey: key.findingsKey,
            clauseId: key.clauseId,
            disposition,
            event,
            // The SAME number the stale-change refusal turns on, not a
            // second one. A receiving client drops an event whose version
            // is not newer than what it holds.
            version: disposition.version,
          },
        });
        return { disposition, event };
      });
    });

  /**
   * A note: a person's remark about the clause.
   *
   * NOT a component of their judgement on one answer, which is why a
   * disposition change does not touch it and why a re-run does not clear it.
   * The actor and the instant come from the server, as they do above.
   *
   * Added and withdrawn, never edited — `note` holds no UPDATE grant for
   * anybody, so a changed note is a different note. There is no withdrawal
   * route in Stage 3 because no screen offers one.
   */
  app.post('/v1/reviews/:id/findings/:findingsKey/:clauseId/notes',
    async (req, reply): Promise<Note> => {
      const ws = req.actor!.workspaceId;
      const key = keyOf(req.params);
      const text = parseNote(req.body);

      const note = await db.tx(async t => {
        await requireFinding(t, key, ws);
        const at = new Date();
        const id = uid();
        await t.query(
          `insert into note (id, review_id, findings_key, clause_id, workspace_id, text,
                             by_user_id, at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, key.reviewId, key.findingsKey, key.clauseId, ws, text, req.actor!.id, at]);
        const written = {
          id,
          // `findingId` is `${findingsKey}::${clauseId}`, derived rather than
          // stored — see `findings/read.ts`, which reconstructs it the same
          // way through the same function.
          findingId: `${key.findingsKey}::${key.clauseId}`,
          text,
          byUserId: req.actor!.id,
          at: at.getTime(),
        } satisfies Note;
        // In the SAME transaction as the insert, for the reason the
        // disposition route gives above. A note APPENDS at the far end — the
        // payload carries one note, never the list, so a receiver cannot
        // replace a fresh array with a stale one.
        await appendEvent(t, {
          workspaceId: ws,
          type: 'note.added',
          reviewId: key.reviewId,
          payload: {
            reviewId: key.reviewId,
            findingsKey: key.findingsKey,
            clauseId: key.clauseId,
            note: written,
          },
        });
        return written;
      });

      // `reply.code(201)` and NOT `await reply.code(201)` — a `FastifyReply`
      // is thenable, and awaiting one means "I am sending this myself", so an
      // awaited `.code()` with no `.send()` hangs until the client gives up.
      reply.code(201);
      return note;
    });

  /**
   * A HUMAN CONFIRMS OR AMENDS A NET POSITION.
   *
   * *"A net position is synthesised text no document contains"* — it
   * describes what a collection's documents, read in order, say now, not
   * what any one of them literally says. It is the most dangerous output
   * this app produces, and it starts UNCONFIRMED for the same reason a
   * finding starts `unchecked()`. Only a human confirms it, or amends it —
   * a stronger claim than confirming, because a person wrote every word.
   *
   * The body carries the ACTION, never the resulting `NetPosition`. A body
   * carrying the object could state `state: 'confirmed'` with anybody's name
   * on it. `confirmPosition`/`amendPosition` (`@lexprompt/core`) are the
   * only producers of one, and they run HERE, over the STORED position, with
   * the authenticated actor and this server's clock — the same refusal the
   * disposition route makes about `byUserId` and `at`, for the same reason.
   *
   * A stale `version` is refused with 409. The current row is the finding
   * itself, and re-reading the findings map is what a caller does next, so
   * nothing travels with the refusal.
   */
  app.put('/v1/reviews/:id/findings/:findingsKey/:clauseId/net-position',
    async (req): Promise<NetPositionWriteResult> => {
      const ws = req.actor!.workspaceId;
      const key = keyOf(req.params);
      const body = parseNetPosition(req.body);

      return db.tx(async t => {
        const row = await requireFinding(t, key, ws);
        const stored = (typeof row.net_position === 'string'
          ? JSON.parse(row.net_position) : row.net_position) as NetPosition | null;
        if (!stored) {
          // ABSENT is not "unconfirmed". A standalone finding has no net
          // position at all, and confirming one that does not exist would
          // manufacture a synthesis nobody produced.
          throw new ModelError(
            `Clause ${key.clauseId} has no synthesised position to confirm — only a collection `
            + 'review produces one.', 'not_found', 404);
        }
        const at = Date.now();
        let next: NetPosition;
        try {
          next = body.action === 'amend'
            ? amendPosition(stored, body.text, req.actor!.id, at)
            : confirmPosition(stored, req.actor!.id, at);
        } catch (e) {
          if (e instanceof NetPositionError) throw new ModelError(e.message, 'unknown', 400);
          throw e;
        }

        const updated = await t.query<{ version: string | number }>(
          `update finding set net_position = $5::jsonb, version = version + 1, updated_at = now()
            where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4
              and version = $6
            returning version`,
          [key.reviewId, key.findingsKey, key.clauseId, ws, JSON.stringify(next), body.version]);
        if (!updated[0]) {
          throw new ConflictError(undefined,
            'This clause changed since you opened it — it may have been re-run. Reload the '
            + 'review before confirming this position; nothing was saved.');
        }
        return { netPosition: next, version: Number(updated[0].version) };
      });
    });

  /**
   * WHO CHANGED THIS, WHEN, AND WHAT FROM — newest first.
   *
   * **STAGE 4'S HISTORY PANEL IS THE CALLER**, and it is the only one:
   * `src/features/review/DispositionHistory.tsx`, opened in one action from
   * the line beneath a card's state chip (§6.3), through
   * `getDispositionHistory` in `src/lib/api/findings.ts`.
   *
   * Nothing rendered it in Stage 3 (P28), deliberately rather than by
   * oversight: it landed there because it is one query over a table that
   * stage created, so the panel could inherit a tested, authorised endpoint
   * rather than write one against a table it was meeting for the first
   * time. That sentence is replaced rather than deleted, because "there is
   * no caller yet" and "here is the caller" are the two states a reader of
   * this route needs to be able to tell apart.
   *
   * It is NOT cached in the browser, and that is the panel's decision worth
   * knowing here: a history is what somebody asked to see once, about one
   * clause, and it is the surface most likely to have changed since the page
   * loaded.
   */
  app.get('/v1/reviews/:id/findings/:findingsKey/:clauseId/history',
    async (req): Promise<DispositionHistory> => {
      const ws = req.actor!.workspaceId;
      const key = keyOf(req.params);
      return db.tx(async t => {
        await requireFinding(t, key, ws);
        const events = await readDispositionEvents(t, key, ws);
        return { events: events.map(toEventView) };
      });
    });
}

function keyOf(params: unknown): FindingKey {
  const p = params as { id: string; findingsKey: string; clauseId: string };
  return { reviewId: p.id, findingsKey: p.findingsKey, clauseId: p.clauseId };
}

/**
 * The finding must EXIST, in this workspace, before anything is written
 * about it.
 *
 * 404, and never a row created on the fly: a disposition on a finding that
 * does not exist is a judgement about nothing, and a note on one is a remark
 * addressed to nobody. `ensureDisposition` deliberately is NOT called here —
 * it creates the `unchecked` row every finding starts with, which belongs to
 * the write that creates the finding.
 *
 * Scoped by workspace, so a key from another firm's review answers 404
 * rather than 403: a 403 would confirm the review id exists somewhere.
 */
async function requireFinding(
  t: Tx, key: FindingKey, workspaceId: string,
): Promise<{ net_position: unknown; version: string | number }> {
  // ONE statement, and it reads the two columns the writes below need
  // beyond existence: the stored net position (which the net-position route
  // transforms rather than replaces) and the row's version, its
  // optimistic-concurrency token. It reads no content a card renders.
  const rows = await t.query<{ net_position: unknown; version: string | number }>(
    `select clause_id, net_position, version from finding
      where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $4`,
    [key.reviewId, key.findingsKey, key.clauseId, workspaceId]);
  if (!rows[0]) {
    throw new ModelError(
      `There is no finding for clause ${key.clauseId} under ${key.findingsKey} in this review, `
      + 'so there is nothing to record a judgement or a note about.', 'not_found', 404);
  }
  return rows[0];
}

const STATES: VerificationState[] = ['unchecked', 'verified', 'flagged', 'rejected'];

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this request (${detail}).`, 'unknown', 400);
}

interface DispositionBody {
  state: VerificationState;
  reason?: string;
  version: number;
}

/**
 * The body, checked rather than cast.
 *
 * The reasonless rejection is refused BY NAME here as well as by
 * `disposition_reason_on_reject` and by `setDisposition`. The constraint is
 * what makes it true; this is what makes the refusal say which field, rather
 * than putting a constraint name in front of a lawyer.
 */
function parseDisposition(body: unknown): DispositionBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    bad('the body is not a record');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.state !== 'string' || !STATES.includes(b.state as VerificationState)) {
    bad(`state is ${JSON.stringify(b.state)}, which is not one of ${STATES.join(', ')}`);
  }
  if (b.cause !== undefined) {
    // Refused rather than ignored. A client sending one believes it decides
    // this, and the honest answer is that it never can.
    bad('cause is not a field a request may set — a request is always a person, '
      + 'and a re-run reset is written by the retry handler alone');
  }
  if (b.byUserId !== undefined || b.at !== undefined) {
    bad('byUserId and at are the server\'s — a request that could state them could put '
      + 'somebody else\'s name on a judgement');
  }
  const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined;
  if (b.state === 'rejected' && !reason) {
    bad('reason is missing, and a rejected finding needs one. A rejection with no reason is '
      + 'a silent disagreement, useless to whoever reads the export');
  }
  if (!Number.isInteger(b.version)) {
    bad('version is missing or is not a whole number, and without it this write could '
      + 'silently overwrite a judgement nobody has seen');
  }
  return {
    state: b.state as VerificationState,
    ...(reason ? { reason } : {}),
    version: b.version as number,
  };
}

/**
 * The net-position body: an ACTION, and the version it was decided against.
 *
 * `state`, `byUserId`, `at` and `amended` are refused rather than ignored,
 * for the reason the disposition parser gives about `cause`: a client
 * sending one believes it decides that, and the honest answer is that it
 * never can.
 */
function parseNetPosition(body: unknown): NetPositionAction {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    bad('the body is not a record');
  }
  const b = body as Record<string, unknown>;
  for (const forbidden of ['state', 'byUserId', 'at', 'amended', 'proposed', 'trail']) {
    if (b[forbidden] !== undefined) {
      bad(`${forbidden} is not a field a request may set. A net position is produced by `
        + 'confirmPosition/amendPosition over what is stored, with the actor and the instant '
        + 'this server knows');
    }
  }
  if (!Number.isInteger(b.version)) {
    bad('version is missing or is not a whole number, and without it this write could silently '
      + 'overwrite a synthesis nobody has seen');
  }
  const version = b.version as number;
  if (b.action === 'confirm') return { action: 'confirm', version };
  if (b.action === 'amend') {
    if (typeof b.text !== 'string' || !b.text.trim()) {
      bad('text is missing or empty, and an amended position needs text. A person amending a '
        + 'position is writing every word of it');
    }
    return { action: 'amend', text: b.text as string, version };
  }
  return bad(`action is ${JSON.stringify(b.action)}, which is not confirm or amend`);
}

function parseNote(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    bad('the body is not a record');
  }
  const b = body as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) {
    bad('text is missing or empty. A note with nothing in it is not a remark anybody can weigh');
  }
  return text;
}

/**
 * Runs a disposition write and puts BOTH its answer and its REFUSAL into the
 * wire shape.
 *
 * `setDisposition` speaks in rows — it is the store's own vocabulary and the
 * two other callers are server-side. A 409 from it carries the current
 * `DispositionRow`, and letting that reach the browser raw would ship a
 * second shape for the same fact: the success path would answer
 * `{ state, byUserId, version }` and the refusal `{ state, by_user_id,
 * version }`, and the code that reads "what replaced my write" would have to
 * know which one it was holding. Stage 4 renders that value; it must arrive
 * in one shape.
 */
async function asView(write: () => Promise<DispositionRow>): Promise<DispositionView> {
  try {
    return toDispositionView(await write());
  } catch (err) {
    if (err instanceof ConflictError && err.current !== undefined) {
      throw new ConflictError(toDispositionView(err.current as DispositionRow), err.message);
    }
    throw err;
  }
}

/**
 * The event `setDisposition` just wrote, insisted upon.
 *
 * `toDispositionView`/`toEventView` moved to `dispositions/service.ts` in
 * Stage 4, because the findings read answers with the same two shapes and
 * two mappers for one shape is this project's most repeated defect. What
 * stays here is the REFUSAL, which is about this route rather than about the
 * mapping: a write that produced no event is the one thing §14 calls a lie,
 * and it must fail here rather than reach a browser as an absent field.
 *
 * Unreachable: `setDisposition` writes the event in the same transaction as
 * the row, and this reads it back inside that transaction. Named rather than
 * non-null asserted, because the failure it would replace is
 * `undefined.from_state` two frames later.
 */
function eventWritten(row: DispositionEventRow | undefined): DispositionEventView {
  if (!row) {
    throw new Error(
      'A disposition was written with no event beside it. Both rows are written in one '
      + 'transaction by `setDisposition`; if this is reachable, that has stopped being true.');
  }
  return toEventView(row);
}
