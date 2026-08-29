import { ModelError } from '@lexprompt/core';
import { apiDelete, apiGet, apiGetOrNull, apiSend } from '../api/client';
import { migrateDraft, migratePlaybookRecord, migrateVersionRecord } from './playbookMigration';
import {
  SCHEMA_VERSION,
  type Playbook, type PlaybookDraft, type PlaybookVersion, type RedlineEdit,
} from '../../types';
import { uid } from '../uid';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_FORMAT_PROMPT } from '../playbookDefaults';

/**
 * The playbooks repository — an HTTP client over `apps/api` since Stage 2.
 *
 * Same file, same exports, same signatures (R3). What moved OUT is the
 * `_seq` tiebreak, the sort, the `STORAGE_FULL_MESSAGE` wrapping (a browser
 * quota is not a thing a server write can hit), and — the one that matters —
 * the two-store transaction behind `publishAndPoint`, which is now ONE
 * Postgres transaction in `apps/api/src/routes/playbooks.ts` spanning
 * `playbook` and `playbook_version`. The guarantee is identical and the
 * reasoning is unchanged; read that route's docstring before touching this.
 *
 * The pure helpers below — `newPlaybook`, `newPlaybookDraft`,
 * `draftFromVersion`, `exportPlaybook` — are unchanged in body as well as in
 * signature. They mint or transform values the browser already holds, and
 * their needing no edit is the evidence R3's seam held for them.
 *
 * Repair-on-read is KEPT (`migratePlaybookRecord`, `migrateVersionRecord`).
 * The server stores records this app wrote, so nothing it returns should
 * need repairing — but "should" is the word that makes a guard worth its one
 * function call, and these are pure and cheap. What is gone is
 * `carriesUnconvertedContent`'s check in `getPlaybookContent`: it looked for
 * PRE-D content keys on a raw IndexedDB record, and `rows.ts` has nowhere to
 * put them, so over HTTP it could only ever be false. The fact it guarded —
 * "never published" must not be confused with "unreadable" — is now the
 * route's job, and the route answers a distinct 404 for it.
 */

/** A new playbook's IDENTITY. Its content is a separate `PlaybookDraft`
 *  (see `newPlaybookDraft`) that becomes v1 on the first publish — the two
 *  are minted separately because a playbook can exist with no published
 *  content at all, and `Playbook` has nowhere to put clauses. */
export function newPlaybook(name: string): Playbook {
  const now = Date.now();
  return {
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
}

/** The starting content for a new playbook. */
export function newPlaybookDraft(name: string): PlaybookDraft {
  return {
    name,
    contractType: 'Custom',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    formatPrompt: DEFAULT_FORMAT_PROMPT,
    clauses: [],
    changeSummary: '',
  };
}

/** The editable copy of a published version.
 *
 *  `changeSummary` is deliberately NOT carried over: it describes what the
 *  version being copied changed, and reusing it would label the next
 *  version with the previous one's reason. */
export function draftFromVersion(version: PlaybookVersion): PlaybookDraft {
  const draft: PlaybookDraft = {
    name: version.name,
    contractType: version.contractType,
    systemPrompt: version.systemPrompt,
    formatPrompt: version.formatPrompt,
    clauses: structuredClone(version.clauses),
    changeSummary: '',
  };
  if (version.riskTolerance !== undefined) draft.riskTolerance = version.riskTolerance;
  return draft;
}

/**
 * PURE READ (R-D7). Repairs each record on the way out and writes nothing.
 * Two components calling this on the same tick must be incapable of
 * publishing two identical v1s between them — which over HTTP is stronger
 * still, since there is no write here to make at all.
 *
 * Rejects (rather than resolving to `[]`) on any failure: a caller must be
 * able to tell "no playbooks yet" from "the server failed", and an empty
 * library indistinguishable from a fresh install is a defect this project
 * has already shipped once.
 */
export async function listPlaybooks(): Promise<Playbook[]> {
  const raw = await apiGet<Playbook[]>('/v1/playbooks');
  return raw.map(r => migratePlaybookRecord(r).playbook);
}

/** PURE READ — see `listPlaybooks`. `null` for "there is no such playbook",
 *  and ONLY for that. */
export async function getPlaybook(id: string): Promise<Playbook | null> {
  const raw = await apiGetOrNull<Playbook>(`/v1/playbooks/${encodeURIComponent(id)}`);
  return raw ? migratePlaybookRecord(raw).playbook : null;
}

/**
 * The playbook's current published content, or `null` when it has never
 * been published (or its pointer names a version that is no longer there).
 *
 * `null` is deliberately distinguishable from an empty version: a caller
 * about to run a review has to be able to tell "this playbook has no
 * published content" from "its content is a playbook with no clauses". The
 * route answers 404 for both "no such playbook" and "nothing published yet",
 * with different messages; both reach here as `null`, exactly as the
 * IndexedDB version answered `null` for both.
 *
 * A 500 REJECTS. `null` here sends the editor to a blank draft whose next
 * Save would publish empty content over a real playbook, so answering it
 * over a broken server is the same defect M3 fixed one storage layer ago.
 */
export async function getPlaybookContent(playbookId: string): Promise<PlaybookVersion | null> {
  const version = await apiGetOrNull<PlaybookVersion>(
    `/v1/playbooks/${encodeURIComponent(playbookId)}/content`);
  return version ? migrateVersionRecord(version) : null;
}

/** Saves the identity record — its name and its draft. Content goes through
 *  `publishAndPoint`; NOTHING here can change what a playbook's published
 *  version is, and the route leaves `current_version_id` out of its update
 *  list to make that true of the statement rather than of the caller.
 *
 *  Returns the SAVED record, carrying the `version` the next save must
 *  state, so a save made against a playbook somebody else has since changed
 *  is refused rather than applied over their work. */
export async function savePlaybook(playbook: Playbook): Promise<Playbook> {
  return apiSend<Playbook>('PUT', `/v1/playbooks/${encodeURIComponent(playbook.id)}`, playbook);
}

/**
 * Publishes `draft` as the playbook's next version AND points the identity
 * record at it, in ONE transaction spanning both tables.
 *
 * The guarantee is unchanged and so is the reason for it. `publishVersion`
 * then `savePlaybook` — two transactions — is what this replaced: a failure
 * in the window between them left an orphaned version and a gap in the
 * version numbering, and for an import an orphan with no identity record at
 * all, permanently unreachable, since the only thing in the app that adopts
 * orphans is the startup conversion and that only looks at playbooks that
 * exist. What changed is that the transaction is now Postgres's rather than
 * IndexedDB's, so it has none of `idb`'s auto-commit hazards — and that the
 * whole of it happens in one request, so the browser cannot fail part way
 * through it at all.
 *
 * It still takes the IDENTITY as a value rather than an id, and that is
 * load-bearing rather than convenient: the editor's Save has the record in
 * hand, and an import (and `saveDraftAsV1`) mints one that is not stored
 * anywhere yet. The route upserts it inside the same transaction for exactly
 * that reason.
 *
 * PUBLISHING CONSUMES THE DRAFT — the route sets `draft` to NULL, which
 * `rows.ts` returns as an ABSENT key, so `'draft' in playbook` (how "has
 * unpublished changes" is asked) reads false afterwards.
 *
 * `byUserId` is accepted and ignored on the wire. Attribution comes from the
 * authenticated actor, never from a caller's claim about who did something —
 * property 3 of the route pattern, and what makes
 * `published_by_user_id`'s foreign key satisfiable while the browser still
 * carries a local profile id. The parameter stays so no caller changed.
 */
/**
 * One `position_basis` row's worth of what a publish records (server §6.5).
 *
 * There is deliberately no `strength`, `supporting` or `total` on this shape
 * and no column for one: `strength.ts` computes strength from a basis every
 * time it is read, and `inferPositions.ts` discards any the model volunteers.
 * A stored copy would be a second, frozen answer to the one number this
 * feature's credibility rests on — and it would be the copy a panel read six
 * months later.
 */
export interface PositionBasisInput {
  clauseId: string;
  /** What the standard position SAID at the moment it was published. */
  adoptedText: string;
  precedentSetId: string;
  documentId: string;
  edits: RedlineEdit[];
  diffDerivedOnly: boolean;
}

export async function publishAndPoint(
  playbook: Playbook,
  draft: PlaybookDraft,
  byUserId: string,
  /** The redline evidence behind this version's learned positions, written in
   *  the SAME transaction as the version itself. Omitted for every publish
   *  that adopts nothing new — an ordinary republish has no new evidence, and
   *  sending an empty array is the same thing as omitting it. */
  basis: PositionBasisInput[] = [],
): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  void byUserId;
  const saved = await apiSend<{ playbook: Playbook; version: PlaybookVersion }>(
    'POST', `/v1/playbooks/${encodeURIComponent(playbook.id)}/versions`,
    { playbook, draft, ...(basis.length > 0 ? { basis } : {}) });
  return {
    playbook: migratePlaybookRecord(saved.playbook).playbook,
    version: migrateVersionRecord(saved.version),
  };
}

/**
 * Stores unpublished edits against the playbook's identity record.
 *
 * Takes the identity as a VALUE rather than an id, exactly as
 * `publishAndPoint` does and for the same reason: a playbook created in this
 * session has no stored record yet, so Save draft is its FIRST write. The
 * route's PUT is an upsert, so that case lands rather than being refused as
 * "that playbook no longer exists".
 *
 * Written only on explicit intent, never per keystroke (R-D16).
 */
export async function saveDraft(playbook: Playbook, draft: PlaybookDraft): Promise<Playbook> {
  return savePlaybook({ ...playbook, draft });
}

/**
 * Clears a playbook's stored draft.
 *
 * ONE statement naming ONE column, on its own route, and that is the shape
 * this function's history demands. It is fired unawaited (`void`) from a
 * synchronous `window.confirm` guard, so it genuinely overlaps other work —
 * and when it was a read followed by a separate write, a `publishAndPoint`
 * landing between the two silently reverted `currentVersionId` and turned
 * the version just published into an orphan nothing enumerates. Making the
 * browser read the record and PUT it back would rebuild that race across a
 * network, where the window is far wider than it ever was in IndexedDB.
 *
 * Without this, "discard" could only forget the edits IN MEMORY: the
 * rejected draft would stay durable and the editor prefers a stored draft
 * over the published version, so the next open would resurrect exactly the
 * edits the user had just rejected.
 *
 * RESOLVES rather than throwing when there is no such playbook, or no draft
 * on it: this runs as the user LEAVES the editor and there is nothing they
 * could do about the news. A genuine failure still rejects.
 */
export async function discardDraft(playbookId: string): Promise<void> {
  try {
    await apiDelete(`/v1/playbooks/${encodeURIComponent(playbookId)}/draft`);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}

/**
 * Deletes the playbook AND every version of it.
 *
 * `playbook_version.playbook_id` cascades in the schema, so the versions go
 * with the row rather than being left unreachable and uncollected. It does
 * not lose a review's history: a `Review` carries its own
 * `playbookSnapshot`, which is why `Review.playbookVersionId` is optional
 * (R-D4) and why the route clears that pointer to NULL in the same
 * transaction rather than letting a foreign key refuse the delete.
 *
 * A 404 RESOLVES; every other failure rejects.
 */
export async function deletePlaybook(id: string): Promise<void> {
  try {
    await apiDelete(`/v1/playbooks/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}

/** Exports a playbook's CONTENT — the clauses and prompts are the part worth
 *  carrying to another browser. Identity (`createdAt`, the version pointer,
 *  the id) is local bookkeeping and is minted fresh on import.
 *
 *  UNCHANGED, and deliberately not a round trip: it is pure, it builds a
 *  Blob from content the browser already has, and sending that content to a
 *  server to have it sent straight back would be a network call for nothing. */
export function exportPlaybook(content: PlaybookDraft): Blob {
  return new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
}

/**
 * Imports exported content — or a pre-D exported `Template` — as a brand new
 * playbook with its own fresh identity and a published v1.
 *
 * The JSON is parsed and shaped HERE, in the browser, because that is where
 * the file is and because `migrateDraft` is the same repair-on-read this
 * module already applies to everything else. What crosses the wire is a
 * playbook and a draft, published by the same one transaction as any other
 * publish — this is the orphan-with-no-identity-record case, the worse of
 * the two `publishAndPoint` was written for.
 *
 * `byUserId` keeps its `''` default and is not sent. A playbook imported
 * from a file was written by whoever wrote the file, so nothing claims
 * authorship of its CONTENT — `playbook.created_by_user_id` is left NULL
 * (P16), which is also what `rows.ts` does for every playbook. The version's
 * `published_by_user_id` is the authenticated actor, because publishing this
 * content into this workspace is something they did do.
 */
export async function importPlaybook(json: string, byUserId = ''): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  void byUserId;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { clauses?: unknown }).clauses)) {
    throw new Error('That file is not a template — it has no clauses.');
  }
  const draft = migrateDraft(parsed, 'Untitled playbook');
  // Fresh id so importing a playbook you already have does not overwrite it.
  const playbook = { ...newPlaybook(draft.name), id: uid() };
  const saved = await apiSend<{ playbook: Playbook; version: PlaybookVersion }>(
    'POST', '/v1/playbooks/import', { playbook, draft });
  return {
    playbook: migratePlaybookRecord(saved.playbook).playbook,
    version: migrateVersionRecord(saved.version),
  };
}
