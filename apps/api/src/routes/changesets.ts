import type { FastifyInstance } from 'fastify';
import {
  ModelError, isDecided, nextVersionContent,
  type ChangesetItem, type ChangesetLike, type PlaybookClause,
} from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { ConflictError } from '../errors.ts';
import { uid } from '../uid.ts';
import {
  fromChangesetRow, toChangesetRow, fromPlaybookVersionRow, toPlaybookVersionRow,
  type Changeset, type ChangesetRow, type PlaybookRow,
  type PlaybookVersion, type PlaybookVersionRow,
} from '../db/rows.ts';

/**
 * The `changesets` repository, server side — Task 9's seven properties, plus
 * the one thing this table's publish path must get right.
 *
 * ## The stale-base refusal travels as a CODE, never as wording
 *
 * `publishChangeset` refuses outright when the playbook has been published
 * again since the changeset was built. Publishing anyway would build the
 * next version from the OLD clause list and silently REVERT whatever the
 * newer version added — a lost update dressed as a normal publish, carrying
 * the same confidence as a version somebody actually approved.
 *
 * In the browser that refusal was an error CLASS, caught by identity. An
 * exception's identity does not survive a network: what arrives is a status
 * and a body. So the contract is `code: 'changeset_stale_base'` in
 * `MODEL_ERROR_CODES`, and `src/lib/db/changesets.ts` rebuilds
 * `ChangesetStaleBaseError` from it — every existing caller keeps catching
 * the class it already catches, and the MESSAGE is free to change.
 *
 * Matching on wording instead is Stage 1's ruling S1 verbatim: *"five copies
 * of one sentence across three workspaces, with a browser matching on the
 * gateway's exact wording and nothing making them agree. Reword any one and
 * the browser silently stops classifying: no error, no failing test, just a
 * firm-configuration fault shown to a lawyer as an ordinary one they might
 * fix."* The message here names BOTH version numbers, because "stale" with
 * no numbers tells a person nothing they can act on — but nothing depends on
 * those words.
 *
 * ## The publish is Task 13's transaction, reused rather than rebuilt
 *
 * Read the playbook, compare `current_version_id` with the changeset's
 * `fromVersionId`, refuse or publish — all inside one `db.tx`, with the
 * identity upsert taking the row lock exactly as `playbooks.ts` describes.
 * The content the version carries comes from `packages/core`'s
 * `nextVersionContent`, which the browser calls too: there is one
 * implementation of "what does this changeset make the playbook say", not
 * one per process.
 */
export function registerChangesets(app: FastifyInstance, db: Db): void {
  app.get('/v1/playbooks/:id/changesets', async (req): Promise<Changeset[]> => {
    const { id } = req.params as { id: string };
    // Most recently created first, as `listChangesets` sorted for itself.
    const rows = await db.query<ChangesetRow>(
      `select * from changeset where playbook_id = $1 and workspace_id = $2
       order by created_at desc, seq desc`,
      [id, req.actor!.workspaceId]);
    return rows.map(fromChangesetRow);
  });

  app.get('/v1/changesets/:id', async (req): Promise<Changeset> => {
    const { id } = req.params as { id: string };
    const rows = await db.query<ChangesetRow>(
      'select * from changeset where id = $1 and workspace_id = $2',
      [id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('There is no such changeset.', 'not_found', 404);
    return fromChangesetRow(rows[0]);
  });

  // NOT `app.put<{ Params: … }>(…)` — see `matters.ts`'s note.
  app.put('/v1/changesets/:id', async (req): Promise<Changeset> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    const input = parseChangeset(id, req.body);
    const row = toChangesetRow({ ...input, createdByUserId: req.actor!.id }, ws);
    // `published_version_id` is NOT in the DO UPDATE list. Only the publish
    // route sets it, inside the transaction that produced the version it
    // names — a save that could stamp it would let a changeset claim to have
    // been published without a version existing.
    const rows = await db.query<ChangesetRow>(
      `insert into changeset (id, workspace_id, playbook_id, from_version_id, source_summary,
                              items, created_at, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $9)
       on conflict (id) do update set
         source_summary = excluded.source_summary, items = excluded.items,
         version = changeset.version + 1
       where changeset.workspace_id = $2 and changeset.version = $8
       returning *`,
      [row.id, ws, row.playbook_id, row.from_version_id, row.source_summary, row.items,
        row.created_at, input.version ?? null, row.created_by_user_id]);
    if (!rows[0]) {
      const current = await db.query<ChangesetRow>(
        'select * from changeset where id = $1 and workspace_id = $2', [row.id, ws]);
      throw new ConflictError(current[0] ? fromChangesetRow(current[0]) : undefined);
    }
    return fromChangesetRow(rows[0]);
  });

  /**
   * Publishes the changeset's ACCEPTED and REWORDED items as the playbook's
   * next version. `partner`, exactly as publishing from the editor is: two
   * routes to the same act must not sit at two different bars, which is the
   * door-around-the-gate shape ruling R-E8 deleted rather than left standing.
   */
  app.post('/v1/changesets/:id/publish', async (req): Promise<PlaybookVersion> => {
    const ws = req.actor!.workspaceId;
    const { id } = req.params as { id: string };
    return db.tx(async t => {
      const rows = await t.query<ChangesetRow>(
        'select * from changeset where id = $1 and workspace_id = $2', [id, ws]);
      if (!rows[0]) throw new ModelError('There is no such changeset.', 'not_found', 404);
      const changeset = fromChangesetRow(rows[0]);

      // "Not yet decided" and "decided no" are different claims. Publishing
      // with an open item would either drop a proposal nobody rejected or —
      // if open items were silently skipped — let a triager believe skipping
      // review is the same as declining.
      if ((changeset.items as ChangesetItem[]).some(item => !isDecided(item))) {
        throw new ModelError(
          'This changeset still has undecided items — every item must be accepted, reworded or '
          + 'declined before it can be published.',
          'conflict', 400);
      }

      // FOR UPDATE, and here it is an explicit lock rather than the upsert
      // `playbooks.ts` relies on: this route never creates a playbook (a
      // changeset is always built against one that exists), so there is no
      // insert to take the lock as a side effect. Without it, two publishes
      // could both read the same `current_version_id` and both pass the
      // staleness check below.
      const playbooks = await t.query<PlaybookRow>(
        'select * from playbook where id = $1 and workspace_id = $2 for update',
        [changeset.playbookId, ws]);
      if (!playbooks[0]) {
        throw new ModelError(
          'The playbook this changeset belongs to no longer exists.', 'not_found', 404);
      }

      const base = await t.query<PlaybookVersionRow>(
        'select * from playbook_version where id = $1 and workspace_id = $2',
        [changeset.fromVersionId, ws]);
      if (!base[0]) {
        throw new ModelError(
          'The version this changeset was built against no longer exists.', 'not_found', 404);
      }

      if (playbooks[0].current_version_id !== changeset.fromVersionId) {
        const current = playbooks[0].current_version_id
          ? await t.query<PlaybookVersionRow>(
            'select * from playbook_version where id = $1 and workspace_id = $2',
            [playbooks[0].current_version_id, ws])
          : [];
        throw staleBase(base[0].version_number, current[0]?.version_number);
      }

      const baseVersion = fromPlaybookVersionRow(base[0]);
      // ONE implementation of what a changeset makes a playbook say, shared
      // with the browser through `packages/core`.
      const { clauses, changeSummary } = nextVersionContent(
        changeset as unknown as ChangesetLike,
        baseVersion.clauses as PlaybookClause[],
        uid,
      );

      const versionNumber = Number((await t.query<{ n: string | number }>(
        `select coalesce(max(version_number), 0) + 1 as n from playbook_version
         where playbook_id = $1 and workspace_id = $2`,
        [changeset.playbookId, ws]))[0].n);

      const version: PlaybookVersion = {
        name: baseVersion.name,
        contractType: baseVersion.contractType,
        systemPrompt: baseVersion.systemPrompt,
        formatPrompt: baseVersion.formatPrompt,
        ...(baseVersion.riskTolerance === undefined
          ? {} : { riskTolerance: baseVersion.riskTolerance }),
        clauses,
        changeSummary,
        id: uid(),
        playbookId: changeset.playbookId,
        version: versionNumber,
        publishedAt: Date.now(),
        // THE ATTRIBUTION COMES FROM THE TOKEN (property 3).
        publishedByUserId: req.actor!.id,
        schemaVersion: baseVersion.schemaVersion,
      };
      const row = toPlaybookVersionRow(version, ws);
      const inserted = await t.query<PlaybookVersionRow>(
        `insert into playbook_version (id, workspace_id, playbook_id, version_number, content,
                                       summary, published_at, published_by_user_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning *`,
        [row.id, ws, row.playbook_id, row.version_number, row.content, row.summary,
          row.published_at, row.published_by_user_id]);

      await t.query(
        `update playbook set current_version_id = $3, draft = null,
           updated_at = now(), version = version + 1
         where id = $1 and workspace_id = $2`,
        [changeset.playbookId, ws, inserted[0].id]);

      // The changeset is stamped INSIDE the same transaction. In the browser
      // this was a second write after the publish returned, and a failure
      // between them left a version published with no changeset pointing at
      // it. Here they commit together or not at all.
      await t.query(
        `update changeset set published_version_id = $3, version = version + 1
         where id = $1 and workspace_id = $2`,
        [changeset.id, ws, inserted[0].id]);

      return fromPlaybookVersionRow(inserted[0]);
    });
  });
}

/**
 * The refusal, with BOTH version numbers in it.
 *
 * The numbers are in the message because "this changeset is stale" tells a
 * person nothing they can act on; the CODE is what any caller classifies on,
 * and no test may match this wording (`changesets.pg.test.ts` demonstrates
 * that by rewording it and staying green).
 */
export function staleBase(builtAgainst: number, current: number | undefined): ModelError {
  const now = current === undefined ? 'a newer one' : `v${current}`;
  return new ModelError(
    `This changeset was built against v${builtAgainst}, and the playbook is now on ${now}. `
    + 'Publishing it would quietly undo what that newer version changed, so it was refused. The '
    + 'decisions recorded on this changeset are safe and have not been lost; it needs to be '
    + 'rebuilt against the current version before it can be published.',
    'changeset_stale_base', 409);
}

function bad(detail: string): never {
  throw new ModelError(`LexPrompt could not read this changeset (${detail}).`, 'unknown', 400);
}

const DECISIONS = ['open', 'accepted', 'reworded', 'declined'];

export function parseChangeset(id: string, body: unknown): Changeset & { version?: number } {
  if (typeof body !== 'object' || body === null) bad('the body is not a record');
  const b = body as Record<string, unknown>;
  if (b.id !== undefined && b.id !== id) {
    bad(`the body's id ${JSON.stringify(b.id)} is not the one in the URL`);
  }
  const playbookId = typeof b.playbookId === 'string' ? b.playbookId.trim() : '';
  if (!playbookId) bad('playbookId is missing or empty');
  const fromVersionId = typeof b.fromVersionId === 'string' ? b.fromVersionId.trim() : '';
  // NOT NULL in the schema and non-optional on the wire type: a changeset is
  // always computed against a specific, already published version.
  if (!fromVersionId) bad('fromVersionId is missing or empty');
  if (typeof b.sourceSummary !== 'string') bad('sourceSummary is missing');
  if (!Array.isArray(b.items)) bad('items is missing or is not an array');
  for (const item of b.items as Record<string, unknown>[]) {
    if (typeof item !== 'object' || item === null) bad('an item is not a record');
    if (typeof item.id !== 'string' || !item.id) bad('an item has no id');
    if (!DECISIONS.includes(item.decision as string)) {
      bad(`an item's decision is ${JSON.stringify(item.decision)}, which is not one of `
        + DECISIONS.join(', '));
    }
  }
  const createdAt = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt)
    ? b.createdAt : undefined;
  if (createdAt === undefined) bad('createdAt is missing or is not a timestamp');
  if (b.version !== undefined && !Number.isInteger(b.version)) {
    bad('version is present but is not a whole number');
  }
  return {
    id,
    playbookId,
    fromVersionId,
    sourceSummary: b.sourceSummary,
    items: b.items as unknown[],
    createdAt,
    // Read off the body and DISCARDED — the handler replaces it with the
    // authenticated actor. Present here only because `Changeset` requires it.
    createdByUserId: '',
    // `publishedVersionId` is deliberately NOT read: only a publish sets it,
    // inside the transaction that wrote the version it names.
    ...(typeof b.version === 'number' ? { version: b.version } : {}),
  };
}
