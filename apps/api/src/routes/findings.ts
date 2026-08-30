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
import type { FindingKey } from '../findings/rows.ts';
import {
  readDispositionEvents, setDisposition,
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
        return { disposition, event: toEventView(events[0]) };
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
        return {
          id,
          // `findingId` is `${findingsKey}::${clauseId}`, derived rather than
          // stored — see `findings/read.ts`, which reconstructs it the same
          // way through the same function.
          findingId: `${key.findingsKey}::${key.clauseId}`,
          text,
          byUserId: req.actor!.id,
          at: at.getTime(),
        } satisfies Note;
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
   * **NOTHING RENDERS THIS IN STAGE 3 (P28), and that is deliberate rather
   * than an oversight.** It lands here because it is one query over a table
   * this stage created, and because Stage 4's history panel should inherit a
   * tested endpoint rather than write one against a table it is meeting for
   * the first time. If you came looking for the caller: there is none yet.
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

/** ABSENT, never `byUserId: undefined` — a finding nobody has touched names
 *  nobody (§6.3), and `structuredClone` preserves an undefined-valued key. */
function toDispositionView(row: DispositionRow): DispositionView {
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

function toEventView(row: DispositionEventRow | undefined): DispositionEventView {
  if (!row) {
    // Unreachable: `setDisposition` writes the event in the same transaction
    // as the row, and this reads it back inside that transaction. Named
    // rather than non-null asserted, because the failure it would replace is
    // `undefined.from_state` two frames later — and because "the disposition
    // moved and no event says so" is the exact thing §14 calls a lie.
    throw new Error(
      'A disposition was written with no event beside it. Both rows are written in one '
      + 'transaction by `setDisposition`; if this is reachable, that has stopped being true.');
  }
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
