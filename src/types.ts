export type RiskLevel = 'High' | 'Medium' | 'Low' | 'Info';

export type PositionOrigin = 'authored' | 'ai-drafted' | 'learned';

/** The comparison result between a clause and its `StandardPosition`. Produced
 *  ONLY by `normalisePositionOutcome` in `src/lib/positionOutcome.ts`. */
export type PositionOutcome = 'meets' | 'deviates' | 'unclear';

/** The firm's own answer to a clause — "we ask for a 6-month break notice,
 *  no conditions." Its presence is what turns a finding from a summary into
 *  a comparison; `Template.mode` used to decide that and has now been
 *  retired (R-D1). */
export interface StandardPosition {
  text: string;
  origin: PositionOrigin;
  /** True once a human has read and accepted it. An AI-drafted position
   *  nobody has read is not the firm's position — it is a suggestion, and
   *  the editor says so. */
  reviewedByHuman: boolean;
  /** Free text naming where it came from ("Commercial Lease — Tenant v4",
   *  "6 redlines across 4 documents"). Presentational; nothing resolves it. */
  provenance?: string;
}

export interface PlaybookClause {
  id: string;
  title: string;
  /** Was `Clause.prompt`. Renamed because a clause now carries more than one
   *  prompt-shaped field. */
  extractPrompt: string;
  riskCriteria?: string;
  standardPosition?: StandardPosition;
}

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

/** The content of a playbook at one published moment. Immutable: nothing
 *  overwrites a version once published, because a review that says "ran
 *  against v4" has to be able to prove what v4 was. */
export interface PlaybookVersion {
  id: string;
  playbookId: string;
  /** 1, 2, 3 … Monotonic per playbook. */
  version: number;
  name: string;
  contractType: string;
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  clauses: PlaybookClause[];
  /** One line saying what changed from the previous version. Required on
   *  every version after the first: a version history whose entries do not
   *  say what changed is a list of dates. */
  changeSummary: string;
  publishedAt: number;
  publishedByUserId: string;
  schemaVersion: number;
}

/** The mutable working copy: a version's content minus everything only a
 *  publish can assign. */
export type PlaybookDraft =
  Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId' | 'schemaVersion'>;

/** The in-session working copy of a document as loaded into memory for a
 *  run: a live `File` handle plus whatever rendering/parsing produced. Never
 *  persisted as-is — see `DocumentRecord` for the shape actually written to
 *  IndexedDB once a document belongs to a Matter. */
export interface DocumentFile {
  id: string;
  name: string;
  text: string;
  file: File;
  kind: 'pdf' | 'docx' | 'txt';
  /** Rendered page images, present only for scans that yielded no text layer. */
  pageImages?: { mime: string; data: string }[];
  /** Set when parsing failed; the file still appears in the list, marked. */
  parseError?: string;
  /** Set when the extracted text is not a faithful rendering of the file:
   *  a `.docx` carrying tracked changes (read with every change accepted)
   *  or margin comments (dropped), or one whose package could not be
   *  checked for either — see `lib/docxMarkup.ts`.
   *
   *  DELIBERATELY NOT a `parseError`. The document parsed, its text is
   *  usable, and the review must run: this is a caveat about the text's
   *  provenance, not a failure to read it, and a caller must be able to
   *  tell "unreadable" from "readable with a caveat". Everything that
   *  reads `parseError` refuses the document; nothing may refuse a
   *  document over this. */
  markupNotice?: string;
}

/** One piece of attributed evidence. Replaces v1's bare quote string: a
 *  quote alone cannot say which document it came from (a review can cover
 *  several) or where in that document to look. */
export interface Citation {
  /** Verbatim substring of the document text, as the model returned it.
   *  This is what `findQuoteRects` matches on — the matcher still takes
   *  plain strings and is not to be changed. */
  quote: string;
  documentId: string;
  /** Derived from the `[Page N]` markers in the document's extracted text
   *  where the quote can be located, absent where it cannot. Never guessed:
   *  a wrong page pin sends a reader to the wrong part of a contract with
   *  apparent authority, which is worse than no pin at all. */
  page?: number;
  /** e.g. "14.2", when the model supplies one. Presentational only —
   *  nothing navigates by it. */
  clauseRef?: string;
}

export type VerificationState = 'unchecked' | 'verified' | 'flagged' | 'rejected';

/** What a *human* concluded about a finding. Deliberately separate from
 *  `Finding.status`, which describes what the *run* produced. A finding can
 *  be `status: 'done'` and `state: 'rejected'` at the same time — the model
 *  answered, and a person disagreed. */
export interface Verification {
  state: VerificationState;
  /** The local profile's id (ruling R1) — this app has one user. */
  byUserId?: string;
  at?: number;
  /** Required when `state` is 'rejected'. A rejection with no reason is a
   *  silent disagreement, useless to whoever reads the export. */
  reason?: string;
  /** Exists so the field survives into later sub-projects. Reaches nobody:
   *  there is no second user and nothing notifies (ruling R1). */
  assigneeId?: string;
}

export interface Note {
  id: string;
  /** `${documentId}::${clauseId}` — see `findingKey` in
   *  `src/lib/verification.ts`. Stored on the note so a note stays
   *  self-describing if notes are ever lifted into their own store. */
  findingId: string;
  text: string;
  byUserId: string;
  at: number;
}

export interface Finding {
  clauseId: string;
  /** 'cancelled' is distinct from 'error': the run was stopped by the user
   *  (or a queued cell never got a turn before that happened), not a failed
   *  request. It is a calm, non-retryable-looking state, never a raw
   *  DOMException string behind an error banner. */
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  summary?: string;
  /** Was `string[]` before sub-project B. Reviews persisted with the old
   *  shape are upgraded on read — see `src/lib/db/reviewMigration.ts`. */
  citations: Citation[];
  /** Always present. Every finding starts `unchecked`: there is no implicit
   *  verification, and a finding is never "probably fine". */
  verification: Verification;
  /** May be empty. */
  notes: Note[];
  riskLevel?: RiskLevel;
  riskAnalysis?: string;
  error?: string;
  edited?: boolean;
  /** Set when the request failed because OpenRouter rejected the API key
   *  (401/403). The container (App.tsx) watches for this and routes to
   *  Settings instead of leaving a wall of identical red cards — a rejected
   *  key is not a per-clause problem the user can fix with Retry. */
  authError?: boolean;
  /** Set when the document's usable text exceeded the model's context
   *  budget and was truncated before review, so a "silent on this point"
   *  finding can be told apart from one that actually saw the whole
   *  document. */
  truncated?: boolean;
  /** WHICH documents were cut short, by name, on a finding derived from more
   *  than one (a collection run). `truncated` alone can only say "something
   *  was cut", which on a four-document derivation tells a reviewer nothing
   *  they can act on: the spec's own words are that "the deed of variation
   *  was cut short" is actionable and "the text was truncated" is not,
   *  because the whole question is whether the document they grouped the
   *  collection to ask about is the one the model did not finish reading.
   *  Absent — not an empty array — on a single-document finding, where
   *  `truncated` already names the only document there is. */
  truncatedDocuments?: string[];
  /** Set when the model returned a schema-valid response with an empty (or
   *  whitespace-only) `summary`. A model with a genuine answer — including
   *  "this document is silent on this point" — always writes something; an
   *  empty string is a non-answer, not a finding, so this is surfaced as an
   *  `error` status rather than `done` (see `extractClause.ts`). Lets
   *  run-level UI count this pattern without string-matching `error`. */
  noContent?: boolean;
  /** Present only on a finding produced by a collection-aware run. A
   *  standalone finding has none and must NOT be given an empty one:
   *  absence means "this question did not arise", where an empty net
   *  position would read as "we tried and found nothing". */
  netPosition?: NetPosition;
  /** Present only when the clause carried a standard position. Absent means
   *  "no position to compare against" — never `unclear`, which means "there
   *  was a position and the model could not tell." The distinction is the
   *  whole point: "we have no house rule here" and "we have one and could
   *  not tell" are different facts. Produced only by
   *  `normalisePositionOutcome` (`src/lib/positionOutcome.ts`). */
  positionOutcome?: PositionOutcome;
  positionRationale?: string;
}

export interface ReviewRun {
  id: string;
  /** Frozen copy, so editing the template later does not rewrite what this run claims to have checked. */
  templateSnapshot: PlaybookVersion;
  documentIds: string[];
  /** Which documents this run covers and how its findings are keyed —
   *  by document for an ordinary review, by the collection for a
   *  collection review (see `findingsKeyFor`). Every run carries one, so
   *  no consumer has to guess which kind it is or fall back to a default. */
  target: ReviewTarget;
  /** docId -> clauseId -> Finding, OR collectionId -> clauseId -> Finding
   *  for a collection run — see `target` and `findingsKeyFor`. */
  findings: Record<string, Record<string, Finding>>;
  startedAt: number;
  completedAt?: number;
  /** Set when the run was stopped via AbortSignal rather than running to
   *  completion. Mutually exclusive with `completedAt` — read together they
   *  tell a finished run apart from a cancelled one, which nothing did
   *  before (`completedAt` was written and never read). */
  cancelledAt?: number;
  /** Mirrors `Review.playbookVersionId` (Task 4/D) onto the in-session run,
   *  so the results header can render the same "ran against vN" claim live
   *  that a saved `Review` carries at rest — `emptyRun` sets it from the
   *  live `PlaybookVersion` a fresh run reads, and reopening a saved review
   *  carries the stored id through unchanged, dangle and all (R-D15).
   *  Omitted, never `undefined`, on the defensive path where a run has no
   *  version to point at — `structuredClone` (how a snapshot is taken, and
   *  how IndexedDB writes every record) preserves an `undefined`-valued key,
   *  which this app's `'x' in obj` / `=== undefined` checks would read as
   *  "there is a version" rather than "there is none". */
  playbookVersionId?: string;
}

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

/** The persisted record for a document once it belongs to a Matter: durable
 *  metadata plus extracted text, deliberately with neither a live `File`
 *  handle nor rendered page images — both are session-only, see
 *  `DocumentFile`. */
export interface DocumentRecord {
  id: string;
  matterId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'txt';
  text: string;
  parseError?: string;
  /** The provenance caveat recorded at ingest — see `DocumentFile`. Absent,
   *  never `undefined`, on a document that has nothing to disclose and on
   *  every document added before this check existed (those were not
   *  checked; the README's known limitations say so, and re-adding one
   *  checks it). */
  markupNotice?: string;
  byteSize: number;
  addedAt: number;
  addedByUserId: string;
  /** 'standalone' unless the document belongs to a collection. */
  role: 'base' | 'varies' | 'standalone';
  collectionId?: string;
  /** When the document takes effect, where it was read from the document or
   *  entered by the user. Absent rather than guessed — displayed, never used
   *  to order amendments (ruling R-C3). */
  documentDate?: number;
}

/** An ordered set of documents read together as one source: one base
 *  document plus the documents that amend it. A lease and its deed of
 *  variation answer a clause together; asked separately they give two
 *  confident answers and neither is the answer. */
export interface Collection {
  id: string;
  matterId: string;
  name: string;
  baseDocumentId: string;
  /** The amending documents, in the order they take effect. Ordered
   *  EXPLICITLY rather than derived from `documentDate` (ruling R-C3): a
   *  date can be missing, wrong or ambiguous, and the order in which
   *  amendments bite is a legal judgement, not a sort. */
  variesDocumentIds: string[];
  createdAt: number;
  createdByUserId: string;
  /**
   * The optimistic-concurrency token (§8) — see `Matter.version` for the full
   * note, which applies here word for word.
   *
   * THE SAME FIELD R3'S SEAM COULD NOT ABSORB, recorded a second time rather
   * than quietly copied. `saveCollection(c): Promise<Collection>` is
   * unchanged and no caller moved; what changed is the record, because
   * refusing a stale write needs the client to say what it was looking at.
   *
   * Optional, and its absence is the claim "I believe this is a create" —
   * which is exactly what `newCollection` mints and must keep minting.
   */
  version?: number;
}

export type NetPositionState = 'unconfirmed' | 'confirmed';

/** One document's contribution to a clause's derivation. */
export interface TrailStep {
  documentId: string;
  kind: 'original' | 'varies';
  /** What this document does to this clause, in the model's words. */
  effect: string;
  citations: Citation[];
}

/**
 * What the documents, read in order, say now — synthesised text that no
 * single document contains. It is therefore the most dangerous output this
 * app produces, and starts `unconfirmed` for the same reason a finding
 * starts `unchecked`.
 */
export interface NetPosition {
  proposed: string;
  /** Present when a human rewrote it. Shown and exported in preference to
   *  `proposed`, which is kept so the trail can show what changed. An
   *  amended position is a STRONGER claim than a confirmed one, not a
   *  weaker one — a person wrote it. */
  amended?: string;
  state: NetPositionState;
  byUserId?: string;
  at?: number;
  /** The argument for the conclusion, one step per contributing document,
   *  in effect order. A net position without it is an assertion. */
  trail: TrailStep[];
}

export type ReviewTarget =
  | { kind: 'documents'; documentIds: string[] }
  | { kind: 'collection'; collectionId: string; documentIds: string[] };

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
   * On THIS record it is the one that matters most. A run's debounced saver
   * writes the whole review every two seconds from its own copy, and knows
   * nothing about a verification somebody recorded in another tab in the
   * meantime. `carryHumanState` re-applies human state within ONE tab;
   * nothing can do that across two, because the other tab's write was never
   * in this one's snapshot to carry. Without this field the second write
   * silently wins and a human's judgement is gone with no trace.
   *
   * `saveReview` stamps it from the version this browser last SAW for the
   * review — see its docstring — because `reviewFromRun` builds a `Review`
   * from a run and has nowhere to carry one.
   */
  version?: number;
}
