/**
 * The browser's own view of the domain types.
 *
 * The definitions below the re-export are the ones only this app has — a
 * router's view models, the IndexedDB records nothing server-side reads. The
 * SHARED ones moved to `packages/core/src/domain/types.ts` (§13 Stage 0, P20)
 * so the server can run the same extractors over the same shapes, and they
 * are re-exported from here so that not one importing file in `src/` had to
 * change when they moved. Import them from either place; there is only one
 * declaration.
 */
export type {
  RiskLevel, PositionOrigin, PositionOutcome, StandardPosition, PlaybookClause,
  PlaybookVersion, DocumentFile, Citation, VerificationState, Verification, Note,
  Finding, ReviewRun, DocumentRecord, Collection, NetPositionState, TrailStep,
  NetPosition, ReviewTarget,
} from '@lexprompt/core';

import type { PlaybookVersion, Finding, ReviewTarget, PositionOutcome } from '@lexprompt/core';

/** A playbook's IDENTITY. Its content lives in `PlaybookVersion` records,
 *  one per publish, so a review that says "ran against v4" can prove what
 *  v4 was. Nothing here carries clauses or prompts: the pre-D `Template`
 *  shape, which did, is gone along with its `mode` flag (R-D1).
 *
 *  `schemaVersion` is carried deliberately (R-D8) even though D's spec §4
 *  omits it — every repair-on-read path in this codebase exists to upgrade
 *  records that record which version wrote them. */
export interface Playbook {
  id: string;
  /** Mirrors the current version's name, so the library can list playbooks
   *  without a second read per row. */
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Absent until the first publish. */
  currentVersionId?: string;
  /** Present when there are unpublished edits. */
  draft?: PlaybookDraft;
  schemaVersion: number;
  /** The optimistic-concurrency token (§8) — see `Matter.version`, whose
   *  note applies here word for word. Optional, and its absence is the claim
   *  "I believe this is a create", which is what `newPlaybook` mints and
   *  what an imported identity carries.
   *
   *  NOT to be confused with `PlaybookVersion.version`, which is the version
   *  NUMBER a person reads in the history. Two different facts, and the one
   *  place they meet is this record: a playbook's `version` counts saves of
   *  its IDENTITY, and says nothing about how many versions it has
   *  published. `playbook_version` has no such column at all — it is
   *  immutable, insert-only, and there is nothing to concurrently overwrite. */
  version?: number;
}


/** The mutable working copy: a version's content minus everything only a
 *  publish can assign. */
export type PlaybookDraft =
  Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId' | 'schemaVersion'>;






/**
 * Task 18 (§6.6): every field that used to live here — `modelChoiceId`,
 * `modelChoiceLabel`, `modelChoiceModel`, `concurrency`,
 * `modelSupportsImages`, `modelSupportsStructuredOutput`,
 * `modelContextLength` — moved to `WorkspaceSettings`
 * (`@lexprompt/core`, `packages/core/src/api/records.ts`), fetched from
 * `GET /v1/workspace/settings` and written only by an admin's `PUT`. The
 * model choice became workspace configuration an admin sets from the
 * gateway's allowlist; `concurrency` became a value stored alongside it
 * (the server-side PER-RUN bound it becomes is Stage 3's — there is no run
 * on the server yet to bound).
 *
 * That was the WHOLE of this interface, so `Settings` is empty now. R6
 * survives for what it was actually about — genuine per-user UI preferences
 * read synchronously in a render path — and there are none left to hold
 * here. It stays, rather than being deleted, because `loadSettings` still
 * has one job: purging a leftover `apiKey` (Stage 1's DoD) or a stale
 * `modelChoiceId`/`concurrency`/etc. (this task's) from a blob a pre-Stage-2
 * browser wrote to `localStorage`. See `storage.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Settings {}

export const DEFAULT_SETTINGS: Settings = {};

/** 3 to 4: `Finding.citations` became `Citation[]`, and `Finding` gained
 *  `verification` and `notes` (sub-project B). Reviews written at 3 are
 *  upgraded on read — see `src/lib/db/reviewMigration.ts`.
 *  4 to 5: `Review` gained `target` (sub-project C, Task 5 migration fills it
 *  in from `documentIds` on read).
 *  5 to 6: `Playbook` split into an identity record plus immutable
 *  `PlaybookVersion` content records, and `Template.mode` retired
 *  (sub-project D — see `src/lib/db/playbookMigration.ts`).
 *  6 to 7: `Changeset` added (sub-project F, Task 8) — a new `changesets`
 *  store, additive only. Nothing existing changed shape. */
export const SCHEMA_VERSION = 7;

/** A firm's redline against one clause during a changeset build — a single
 *  insertion, deletion, moved passage, or margin comment, tagged with the
 *  document it came from and how it was found. Spec §5 (sub-project F). This
 *  is the PERSISTED counterpart of `docxRedlines.ts`'s in-session
 *  `ParsedEdit`: a `ChangesetItem`'s `basis` is a durable copy of the edits
 *  that produced it, taken at build time.
 *
 *  WHY THE COPY IS STILL TAKEN, now that the reason has changed. It was
 *  taken because the source documents were read and never stored (F's spec
 *  §4.1), so the copy was the only surviving witness. The server design's
 *  §11.1 supersedes that: precedent documents ARE stored now, in the firm's
 *  own tenant, as `kind = 'precedent'` documents belonging to a precedent
 *  set. So the copy becomes a CORROBORATION rather than the only witness —
 *  §11.1's own word — and it still has to exist, because a precedent set can
 *  be disposed of under a retention schedule while the playbook it taught
 *  lives on for years.
 *
 *  `kind` reuses `docxRedlines.ts`'s `RedlineEditKind` rather than
 *  re-declaring the same four-way union a second time (spec §5 itself lists
 *  only `'insertion' | 'deletion' | 'comment'`, written before R-F3 added
 *  `'moved'` to keep a relocated clause from being misreported as an
 *  unrelated delete-then-insert; excluding it here would reopen exactly that
 *  defect for anything a changeset carries as evidence). */
export interface RedlineEdit {
  documentId: string;
  kind: import('./lib/docxRedlines').RedlineEditKind;
  text: string;
  context: string;
  clauseRef?: string;
  source: 'tracked' | 'diff';
  author?: string;
  at?: number;
}

/**
 * A batch of precedent documents brought in for one "learn from redlines"
 * session, stored server-side (server spec §6.5, §11.1).
 *
 * Sub-project F held these in the browser for one session and stored
 * nothing. §11.1 supersedes that: a house position adopted from a redline is
 * only *evidenced* for as long as the evidence exists, and session-only
 * storage made that claim true for about ninety seconds.
 *
 * `playbookId` is absent until a playbook is actually saved from the set.
 */
export interface PrecedentSet {
  id: string;
  name: string;
  playbookId?: string;
  createdAt: number;
  createdByUserId: string;
  /** The optimistic-concurrency token — see `Matter.version`. */
  version?: number;
}

/**
 * A stored precedent document.
 *
 * **Not a `DocumentRecord`, and `storedAs` is not `kind`.** `kind` here is
 * the FILE type, exactly as it is on `DocumentRecord`; the server column
 * that says matter-or-precedent is surfaced as `storedAs`, because two
 * different facts wearing one word is a defect nobody could see (the
 * `document` table refused the same conflation in its own schema). There is
 * no `matterId` at all — absent, never `undefined` — because a precedent
 * belongs to no matter, and S23 is that this distinction must survive
 * somebody writing a new query.
 */
export interface PrecedentDocumentRecord {
  id: string;
  precedentSetId: string;
  name: string;
  /** The FILE type. */
  kind: 'pdf' | 'docx' | 'txt';
  text: string;
  parseError?: string;
  markupNotice?: string;
  byteSize: number;
  addedAt: number;
  addedByUserId: string;
  storedAs: 'precedent';
}

/** How a changeset item's proposal relates to the playbook's live version:
 *  `'confirm'` — the deal says the same thing the standing position already
 *  does; `'drift'` — the deal proposes something different for a clause the
 *  version already covers; `'new_clause'` — the deal raises something the
 *  version never covered at all. */
export type ChangeKind = 'confirm' | 'drift' | 'new_clause';

/** One proposed change, produced by `buildChangeset` and accepted, reworded
 *  or declined one at a time — never adopted wholesale (spec §2, §9). */
export interface ChangesetItem {
  id: string;
  kind: ChangeKind;
  /** The clause title this item is about — the matched clause's own title
   *  for `confirm`/`drift`, or the model's proposed title for `new_clause`.
   *  Set by `buildChangeset.ts`'s `resolveItem`. Optional only because a
   *  changeset saved before this field existed has none: `changesets.ts`'s
   *  `newClauseTitle` and `ChangesetReview.tsx`'s `itemTitle` both fall back
   *  to `basis[0]?.clauseRef` for such a record. Every item built going
   *  forward carries it, making explicit what was previously an implicit
   *  contract between those two files and `buildChangeset.ts` (an item is
   *  never kept with an empty `basis`, so the fallback was always safe, but
   *  nothing said so at the type level). */
  title?: string;
  /** Absent for `new_clause` — there is no existing clause to point at, and
   *  a stray `clauseId: undefined` would persist (via `structuredClone`) as
   *  a claim that this item refers to some clause. */
  clauseId?: string;
  /** What the live version currently says. Absent for `new_clause`, and for
   *  a matched clause that has no standing position yet. */
  currentText?: string;
  proposedText: string;
  /** Why, citing the deals it came from. A proposal without a reason is not
   *  reviewable — every item MUST carry one. */
  rationale: string;
  basis: RedlineEdit[];
  /** Starts `'open'` on every item, for the same reason a `Finding`'s
   *  `Verification` starts `unchecked()` and a net position starts
   *  unconfirmed: a decision is a person's act, and defaulting one would let
   *  a changeset record agreement nobody gave. */
  decision: 'open' | 'accepted' | 'reworded' | 'declined';
  /** Present when reworded. */
  rewordedText?: string;
}

/** The one durable artifact this sub-project produces (spec §5) — everything
 *  upstream of it (precedent documents, parsed edits, inferred positions) is
 *  session-scoped and dies with the tab. */
export interface Changeset {
  id: string;
  playbookId: string;
  fromVersionId: string;
  /** "Brookvale Retail Park — our markup + executed, Jul 2026". */
  sourceSummary: string;
  items: ChangesetItem[];
  createdAt: number;
  createdByUserId: string;
  /** Set on publish. */
  publishedVersionId?: string;
  /** The optimistic-concurrency token (§8) — see `Matter.version`, whose
   *  note applies word for word. Optional: a changeset `buildChangeset` has
   *  just minted has none, and that absence is the claim "this is a create". */
  version?: number;
}

export interface UserProfile {
  id: string;
  name: string;
  initials: string;
}

export interface Matter {
  id: string;
  name: string;
  client?: string;
  reference?: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The optimistic-concurrency token (§8), set by the server and echoed back
   * on the next write.
   *
   * THE ONE FIELD R3'S SEAM COULD NOT ABSORB, and therefore written down
   * rather than slipped in. The nine repositories were made Promise-returning
   * so a storage swap would not touch a caller; that held for every signature
   * — `saveMatter(m): Promise<Matter>` is unchanged — but not for the record
   * itself, because refusing a stale write needs the client to say what it
   * was looking at, and nothing in an IndexedDB-shaped `Matter` could say it.
   *
   * OPTIONAL, and its absence is a claim rather than an omission: "I have not
   * read this from the server, so I believe this is a create." That is what
   * keeps `newMatter` unchanged and what lets a record from the uploader
   * (which has no version) be accepted. A save carrying no version against a
   * row that already exists is refused with 409, not applied.
   */
  version?: number;
}





export interface Review {
  id: string;
  matterId: string;
  playbookSnapshot: PlaybookVersion;
  /** The playbook version this review ran against. Optional (R-D4): a review
   *  whose playbook was deleted before D has no version to point at, and a
   *  required field would force the migration to invent one.
   *  `playbookSnapshot` remains what makes such a review readable at all;
   *  this id is what lets the app show "ran against v4" and link to it. */
  playbookVersionId?: string;
  documentIds: string[];
  target: ReviewTarget;
  findings: Record<string, Record<string, Finding>>;
  modelId: string;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  createdByUserId: string;
  /**
   * The optimistic-concurrency token (§8) — see `Matter.version` for the
   * full note.
   *
   * On THIS record it is the one that matters most. It was earned by a
   * run's debounced saver, which wrote the whole review every two seconds
   * from its own copy and knew nothing about a verification somebody
   * recorded in another tab in the meantime. Both that saver and the
   * in-tab merge that partly covered it are gone (Stage 3, Tasks 18 and
   * 21) - a judgement is its own row now - but the field is not: any
   * whole-record write from a browser holding a stale copy still has to be
   * refused, and without this the second write silently wins.
   *
   * `saveReview` stamps it from the version this browser last SAW for the
   * review — see its docstring — because `reviewFromRun` builds a `Review`
   * from a run and has nowhere to carry one.
   */
  version?: number;
}
