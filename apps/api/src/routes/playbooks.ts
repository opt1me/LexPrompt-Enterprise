import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../audit/write.ts';
import { ModelError, uid } from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import {
  fromPlaybookRow, fromPlaybookVersionRow, toPlaybookRow, toPlaybookVersionRow,
  type Playbook, type PlaybookDraft, type PlaybookRow,
  type PlaybookVersion, type PlaybookVersionRow,
} from '../db/rows.ts';
import { parseBasis, recordPositionBasis, type BasisInput } from './positionBasis.ts';

/**
 * The `playbooks` and `playbookVersions` repositories, server side.
 *
 * Task 9's seven properties apply unchanged. What this module adds is the
 * one guarantee the whole task exists for:
 *
 * ## `publishAndPoint` is ONE Postgres transaction
 *
 * Publishing a version and pointing the playbook at it happen together or
 * not at all, in a single transaction spanning both tables. This is not
 * tidiness. `publishAndPoint`'s own docstring records what two transactions
 * cost: *"A failure in the window between them left an orphaned version and
 * a gap in the version numbering, and for an import an orphan with no
 * identity record at all: permanently unreachable, since the only thing in
 * the app that adopts orphans is the startup conversion, and that only looks
 * at playbooks that exist."* Postgres gives the same guarantee the IndexedDB
 * version fought for, with none of `idb`'s auto-commit hazards — but only if
 * it stays one `db.tx`.
 *
 * ## The identity UPSERT is the lock, and it comes first
 *
 * The reference sketch for this task read the playbook `for update` and
 * answered 404 when it was absent. That would have broken the two callers
 * `publishAndPoint` was rewritten to serve: `saveDraftAsV1` publishes a
 * playbook created in this session, and `importPlaybook` mints an identity
 * that is not in the store at all. Its own docstring is explicit — *"It
 * takes the identity as a value rather than an id so it serves both
 * callers"* — and the import case is the WORSE of the two orphans the
 * transaction exists to prevent, so refusing it would have removed the
 * feature this task is about while passing every test written for a
 * playbook that already exists.
 *
 * So the transaction begins by UPSERTING the identity, and that statement is
 * also the serialisation point: `insert … on conflict (id) do update` takes
 * a row lock on `playbook`, held to the end of the transaction, so two
 * concurrent publishes of the same playbook cannot both read the same
 * maximum version number. An explicit `select … for update` afterwards would
 * be a second lock on a row this transaction already holds. `unique
 * (playbook_id, version_number)` is the backstop underneath, so even a
 * mistake here fails loudly rather than producing two rows claiming to be v3.
 *
 * ## Immutability is how ids are allocated
 *
 * `uid()` on every publish, never reused, so nothing can land on an existing
 * version — and the app role holds INSERT but not UPDATE or DELETE on
 * `playbook_version` (002_records.sql), which makes that a property of the
 * database rather than of the code that happens not to write.
 */
export function registerPlaybooks(app: FastifyInstance, db: Db): void {
  app.get('/v1/playbooks', async (req): Promise<Playbook[]> => {
    // `updated_at desc, seq desc` — the `_seq` tiebreak, moved to where the
    // database can do it. A same-millisecond pair ordered by `updated_at`
    // alone is ordered arbitrarily, and losing that here loses it SILENTLY.
    const rows = await db.query<PlaybookRow>(
      'select * from playbook where workspace_id = $1 order by updated_at desc, seq desc',
      [req.actor!.workspaceId],
    );
    return rows.map(fromPlaybookRow);
  });

  app.get('/v1/playbooks/:id', async (req): Promise<Playbook> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<PlaybookRow>(
      'select * from playbook where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such playbook.', 'not_found', 404);
    return fromPlaybookRow(rows[0]);
  });

  /**
   * The playbook's CURRENT published content.
   *
   * Three different answers, and collapsing any two of them is a defect:
   *
   *  - **404 `not_found`** — there is no such playbook.
   *  - **404 `no_content`** — the playbook exists and has never been
   *    published (or its pointer names a version that is gone). The browser
   *    turns this into `null`, and the editor answers it with a blank draft.
   *  - **200** — the version.
   *
   * The middle one must stay distinguishable from an EMPTY version: a caller
   * about to run a review has to be able to tell "this playbook has no
   * published content" from "its content is a playbook with no clauses".
   */
  app.get('/v1/playbooks/:id/content', async (req): Promise<PlaybookVersion> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const rows = await db.query<PlaybookRow>(
      'select * from playbook where id = $1 and workspace_id = $2', [id, ws]);
    if (!rows[0]) throw new ModelError('There is no such playbook.', 'not_found', 404);
    if (!rows[0].current_version_id) throw noContent();
    const version = await db.query<PlaybookVersionRow>(
      'select * from playbook_version where id = $1 and workspace_id = $2',
      [rows[0].current_version_id, ws]);
    if (!version[0]) throw noContent();
    return fromPlaybookVersionRow(version[0]);
  });

  app.get('/v1/playbooks/:id/versions', async (req): Promise<PlaybookVersion[]> => {
    const { id } = req.params as { id: string };
    const ws = req.actor!.workspaceId;
    // The PARENT first (Part 2A m9). Without this, a playbook that does not
    // exist — or belongs to another workspace — answered `[]`, which a
    // version-history pane renders as "nothing published yet": the one list
    // route where "no such playbook" and "no versions yet" arrived
    // identically, and the empty-versus-broken rule says they must not.
    // 404 rather than 403 for a foreign id, exactly as every other read of a
    // specific record here: a 403 would confirm the id exists somewhere.
    const parent = await db.query<{ id: string }>(
      'select id from playbook where id = $1 and workspace_id = $2', [id, ws]);
    if (!parent[0]) throw new ModelError('There is no such playbook.', 'not_found', 404);
    // Newest first, as `listVersions` sorted for itself.
    const rows = await db.query<PlaybookVersionRow>(
      `select * from playbook_version where playbook_id = $1 and workspace_id = $2
       order by version_number desc`,
      [id, ws]);
    return rows.map(fromPlaybookVersionRow);
  });

  app.get('/v1/versions/:id', async (req): Promise<PlaybookVersion> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<PlaybookVersionRow>(
      'select * from playbook_version where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such playbook version.', 'not_found', 404);
    return fromPlaybookVersionRow(rows[0]);
  });

  // NOT `app.put<{ Params: … }>(…)` — see `matters.ts`'s note.
  app.put('/v1/playbooks/:id', async (req): Promise<Playbook> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const input = parsePlaybook(id, req.body);
    const row = toPlaybookRow(input, ws);
    // `current_version_id` is NOT in the DO UPDATE list. Nothing here can
    // change what a playbook's published content is — only a publish can,
    // and only inside the transaction below. A save that could move the
    // pointer would be a second, untransacted route to the thing
    // `publishAndPoint` exists to make atomic.
    const rows = await db.query<PlaybookRow>(
      `insert into playbook (id, workspace_id, name, created_at, updated_at, draft, schema_version)
       values ($1, $2, $3, $4, now(), $5::jsonb, $6)
       on conflict (id) do update set
         name = excluded.name, draft = excluded.draft, schema_version = excluded.schema_version,
         updated_at = now(), version = playbook.version + 1
       where playbook.workspace_id = $2 and playbook.version = $7
       returning *`,
      [row.id, ws, row.name, row.created_at, row.draft, row.schema_version,
        input.version ?? null]);
    if (!rows[0]) {
      const current = await db.query<PlaybookRow>(
        'select * from playbook where id = $1 and workspace_id = $2', [row.id, ws]);
      throw new ConflictError(current[0] ? fromPlaybookRow(current[0]) : undefined);
    }
    return fromPlaybookRow(rows[0]);
  });

  /**
   * Clears a playbook's stored draft.
   *
   * Its own route rather than `PUT /v1/playbooks/:id` with the draft left
   * off, and the reason is in `discardDraft`'s shipped docstring: it takes
   * an ID, not a record, and it used to be a `db.get` followed by a separate
   * write until a `publishAndPoint` landing between the two silently
   * reverted `currentVersionId` and orphaned the version just published.
   * Making the browser read the playbook and PUT it back would rebuild that
   * exact read-then-write across a network, where the window is far wider.
   * One statement naming one column cannot have it.
   *
   * RESOLVES when there is no such playbook or no draft on it: this runs as
   * the user LEAVES the editor and there is nothing they could do about the
   * news. `draft = null` is the ABSENT key on the wire (`absentUnless`), so
   * `'draft' in playbook` — which is how "has unpublished changes" is asked
   * — reads false afterwards.
   */
  app.delete('/v1/playbooks/:id/draft', async (req, reply): Promise<void> => {
    const { id } = req.params as { id: string };
    // ONE string literal, not two concatenated. `workspaceScope.test.ts`
    // reads string literals out of this directory and checks each for a
    // workspace predicate, so a statement split across `+` hides its own
    // `where` from the guard — which is how a query comes to show another
    // firm's records with nothing on screen looking wrong.
    await db.query(
      `update playbook set draft = null, updated_at = now(), version = version + 1
       where id = $1 and workspace_id = $2 and draft is not null`,
      [id, req.actor!.workspaceId]);
    await reply.code(204).send();
  });

  /**
   * Publish `draft` as this playbook's next version and point the playbook
   * at it — ONE transaction over both tables. See the module docstring.
   *
   * `partner`, not `reviewer` (§7 and `ROUTE_POLICY`): publishing a playbook
   * version is one of the two things a reviewer cannot do.
   */
  app.post('/v1/playbooks/:id/versions', async (req): Promise<{
    playbook: Playbook; version: PlaybookVersion;
  }> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const { playbook, draft, basis } = parsePublish(id, req.body);
    return db.tx(async t => {
      const published = await publishInto(t, ws, req.actor!.id, playbook, draft, basis);
      // In `publishAndPoint`'s own transaction (S11). A publish is the act
      // this system is least able to undo — `publishVersion` mints a fresh
      // uid and never reuses one — so the record of who published what has
      // to commit with it or not at all.
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'playbook.published',
        subjectType: 'playbook_version', subjectId: published.version.id,
        detail: {
          playbookId: published.playbook.id,
          versionNumber: published.version.version,
        },
      });
      return published;
    });
  });

  /**
   * Import: a brand new playbook with a fresh identity and a published v1,
   * in the SAME one transaction as any other publish.
   *
   * This is the worse of the two orphans `publishAndPoint` was written for —
   * a version with no identity record at all, unreachable forever, since
   * nothing but the startup conversion adopts orphans and that only looks at
   * playbooks that still exist. It runs through `publishInto` rather than
   * beside it so there is exactly one implementation of "both or neither".
   */
  app.post('/v1/playbooks/import', async (req): Promise<{
    playbook: Playbook; version: PlaybookVersion;
  }> => {
    const ws = req.actor!.workspaceId;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as
      Record<string, unknown>;
    const playbook = parsePlaybookValue(body.playbook);
    const draft = parseDraft(body.draft);
    return db.tx(async t => {
      const imported = await publishInto(t, ws, req.actor!.id, playbook, draft);
      await appendAudit(t, {
        workspaceId: ws, actorUserId: req.actor!.id, action: 'playbook.imported',
        subjectType: 'playbook', subjectId: imported.playbook.id,
        detail: { name: imported.playbook.name, versionId: imported.version.id },
      });
      return imported;
    });
  });

  /**
   * Deletes the playbook AND every version of it.
   *
   * `playbook_version.playbook_id` cascades (002_records.sql), so the
   * versions go with the row. What does NOT cascade is
   * `review.playbook_version_id`, and a review that ran against one of these
   * versions would make the delete fail on a foreign key — a 500 on an
   * action the user is entitled to take. It is cleared to NULL first, in the
   * same transaction, which is exactly what `Review.playbookVersionId` being
   * optional is for: R-D4, *"a review whose playbook was deleted before D
   * has no version to point at"*. The review itself is untouched and still
   * opens on its own `playbookSnapshot`, which is what makes deleting a
   * playbook safe at all.
   */
  app.delete('/v1/playbooks/:id', async (req, reply): Promise<void> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const deleted = await db.tx(async t => {
      await t.query(
        `update review set playbook_version_id = null
         where workspace_id = $2 and playbook_version_id in (
           select id from playbook_version where playbook_id = $1 and workspace_id = $2)`,
        [id, ws]);
      // The changesets go with the playbook by cascade, and their own FKs to
      // `playbook_version` are satisfied by their deletion happening in the
      // same statement's cascade.
      return t.query<{ id: string }>(
        'delete from playbook where id = $1 and workspace_id = $2 returning id', [id, ws]);
    });
    if (!deleted[0]) throw new ModelError('There is no such playbook.', 'not_found', 404);
    await reply.code(204).send();
  });
}

/**
 * The publish, as one function so the editor's Save and an import cannot
 * drift into two different ideas of what "both or neither" means.
 *
 * Every statement inside runs on the SAME `Tx`. Splitting this into two
 * `db.tx` calls is the mutation `playbooks.pg.test.ts`'s "does both, or
 * neither" exists to catch.
 */
async function publishInto(
  t: Tx, ws: string, actorId: string, playbook: Playbook, draft: PlaybookDraft,
  basis: BasisInput[] = [],
): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  const identity = toPlaybookRow(playbook, ws);
  // FIRST, and it is the lock: `on conflict (id) do update` takes a row lock
  // held for the rest of the transaction, so two concurrent publishes of one
  // playbook cannot both read the same maximum version number. See the
  // module docstring for why this is an UPSERT and not a `for update` read.
  //
  // A row belonging to ANOTHER workspace matches `on conflict (id)` and then
  // fails the `where`, so no row comes back and the publish is refused — the
  // same P6 id-collision answer every other route gives.
  const claimed = await t.query<{ id: string }>(
    `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
     values ($1, $2, $3, $4, now(), $5)
     on conflict (id) do update set updated_at = now()
     where playbook.workspace_id = $2
     returning id`,
    [identity.id, ws, identity.name, identity.created_at, identity.schema_version]);
  if (!claimed[0]) {
    throw new ConflictError(
      undefined,
      'Something else already uses that playbook identifier, and it is not yours to publish '
      + 'over. Nothing was saved.',
    );
  }

  const next = await t.query<{ n: string | number }>(
    `select coalesce(max(version_number), 0) + 1 as n from playbook_version
     where playbook_id = $1 and workspace_id = $2`,
    [playbook.id, ws]);
  const versionNumber = Number(next[0].n);

  // A version history whose entries do not say what changed is a list of
  // dates (§4). v1 is exempt — there is no previous version for it to have
  // changed from. Refused HERE as well as in the dialog, because a hidden
  // dialog field is not a control.
  const summary = (draft.changeSummary ?? '').trim();
  if (versionNumber > 1 && summary === '') {
    throw new ModelError(
      'A new version needs a short note saying what changed. Every version after the first '
      + 'carries one, so a reader of the history can see what moved.',
      'conflict', 400);
  }

  // A FRESH id on every call, never reused, so a publish can never land on
  // an existing version: immutability is a property of how ids are
  // allocated, not a check that could be forgotten.
  const version: PlaybookVersion = {
    ...draft,
    changeSummary: summary,
    id: uid(),
    playbookId: playbook.id,
    version: versionNumber,
    publishedAt: Date.now(),
    // THE ATTRIBUTION COMES FROM THE TOKEN (property 3). Whatever the body
    // claimed is discarded by `parsePublish`, and it is also what makes the
    // column's foreign key satisfiable while the browser still carries a
    // local profile id.
    publishedByUserId: actorId,
    schemaVersion: playbook.schemaVersion,
  };
  const versionRow = toPlaybookVersionRow(version, ws);
  const inserted = await t.query<PlaybookVersionRow>(
    `insert into playbook_version (id, workspace_id, playbook_id, version_number, content,
                                   summary, published_at, published_by_user_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning *`,
    [versionRow.id, ws, versionRow.playbook_id, versionRow.version_number, versionRow.content,
      versionRow.summary, versionRow.published_at, versionRow.published_by_user_id]);

  // PUBLISHING CONSUMES THE DRAFT. The edits are now IN the version, so a
  // surviving draft would make the library read "unpublished changes"
  // forever and make the editor prefer the stale draft over the version just
  // published. `draft = null` is the ABSENT key on the wire, which is how
  // `'draft' in playbook` comes to read false.
  //
  // The identity also MIRRORS the version's name, so the library can list
  // playbooks without reading a version per row.
  const pointed = await t.query<PlaybookRow>(
    `update playbook set current_version_id = $3, draft = null, name = $4,
       schema_version = $5, updated_at = now(), version = version + 1
     where id = $1 and workspace_id = $2 returning *`,
    [playbook.id, ws, inserted[0].id, version.name, playbook.schemaVersion]);

  // The basis, IN THIS TRANSACTION (§6.5, Task 20). A position that was never
  // saved has no house rule to be the basis of, so the evidence is recorded
  // at the one moment the rule becomes real — and a basis written outside
  // this transaction could survive a publish that failed, which is evidence
  // for a version nobody ever published.
  //
  // Keyed on `(playbook_id, clause_id)` and carrying `adopted_in_version_id`
  // plus the position's text AS ADOPTED: keying on the version would delete a
  // firm's evidence on every publish (P13, and `positionBasis.ts`'s
  // docstring). Nothing here records a strength, a supporting count or a
  // total — `strength.ts` computes those from the basis, every time.
  if (basis.length > 0) {
    await recordPositionBasis(t, ws, playbook.id, inserted[0].id, actorId, basis);
  }

  return {
    playbook: fromPlaybookRow(pointed[0]),
    version: fromPlaybookVersionRow(inserted[0]),
  };
}

function noContent(): ModelError {
  // A DISTINCT 404 from "there is no such playbook". The browser maps both
  // to `null` today, but the two are different facts and a message that
  // conflated them would tell a reader their playbook is missing when it is
  // merely unpublished.
  return new ModelError(
    'This playbook has no published content yet.', 'not_found', 404);
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this playbook (${detail}).`, 'unknown', 400);
}

export function parsePlaybook(id: string, body: unknown): Playbook & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== id) {
    bad(`the body's id ${JSON.stringify(b.id)} is not the one in the URL`);
  }
  return { ...parsePlaybookValue({ ...b, id }) };
}

/** A `Playbook` identity checked rather than cast. `currentVersionId` is
 *  READ AND DISCARDED — only a publish moves that pointer, inside the one
 *  transaction that also writes the version it names. */
export function parsePlaybookValue(body: unknown): Playbook & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the playbook is not a record');
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id) bad('id is missing or empty');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) bad('name is missing or empty');
  const createdAt = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt)
    ? b.createdAt : undefined;
  if (createdAt === undefined) bad('createdAt is missing or is not a timestamp');
  if (typeof b.schemaVersion !== 'number' || !Number.isInteger(b.schemaVersion)) {
    bad('schemaVersion is missing or is not a whole number');
  }
  if (b.version !== undefined && !Number.isInteger(b.version)) {
    bad('version is present but is not a whole number');
  }
  if (b.draft !== undefined && (typeof b.draft !== 'object' || b.draft === null || Array.isArray(b.draft))) {
    bad('draft is present but is not an object');
  }
  return {
    id,
    name,
    createdAt,
    // The server sets `updated_at` itself, as `savePlaybook` always did.
    updatedAt: createdAt,
    // ABSENT, never `draft: undefined` — `'draft' in playbook` is how "has
    // unpublished changes" is asked, and an undefined-valued key answers it
    // wrongly through `structuredClone` while JSON drops it entirely.
    ...(b.draft === undefined ? {} : { draft: b.draft }),
    schemaVersion: b.schemaVersion,
    ...(typeof b.version === 'number' ? { version: b.version } : {}),
  };
}

export function parseDraft(body: unknown): PlaybookDraft {
  if (typeof body !== 'object' || body === null) bad('the draft is not a record');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) bad('the draft has no name');
  if (typeof b.contractType !== 'string') bad('contractType is missing');
  if (typeof b.systemPrompt !== 'string') bad('systemPrompt is missing');
  if (typeof b.formatPrompt !== 'string') bad('formatPrompt is missing');
  if (!Array.isArray(b.clauses)) bad('clauses is missing or is not an array');
  return {
    name,
    contractType: b.contractType,
    systemPrompt: b.systemPrompt,
    formatPrompt: b.formatPrompt,
    // ABSENT, never `riskTolerance: undefined`. `riskBlock.ts` gates the risk
    // block on PRESENCE (`clause.riskCriteria || version.riskTolerance`), so a
    // key present with an undefined value is a different fact from no key.
    ...(typeof b.riskTolerance === 'string' ? { riskTolerance: b.riskTolerance } : {}),
    clauses: b.clauses,
    changeSummary: typeof b.changeSummary === 'string' ? b.changeSummary : '',
  };
}

export function parsePublish(id: string, body: unknown): {
  playbook: Playbook; draft: PlaybookDraft; basis: BasisInput[];
} {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  const playbook = parsePlaybook(id, b.playbook);
  // `basis` is OPTIONAL and absent for every publish that is not a redlines
  // save-as-v1: an ordinary republish has no new evidence to record, and an
  // empty array is the correct answer for it rather than a missing field
  // being an error. `parseBasis` reads no `strength`, `supporting` or
  // `total` — see `positionBasis.ts`.
  return { playbook, draft: parseDraft(b.draft), basis: parseBasis(b.basis) };
}
