/**
 * The domain shapes the review engine works in — shared by the browser that
 * runs a review today and the worker that will run one in Stage 3's §9.
 *
 * ## Why they moved here
 *
 * §5: `packages/core` is "every piece of domain logic that is neither React
 * nor IO", and §13 Stage 0 asks the review closure to move whole. An
 * extractor that takes a `Finding` cannot live here while `Finding` lives in
 * `src/types.ts`, and `packages/core` genuinely could not import that file:
 * `RedlineEdit.kind` was typed `import('./lib/docxRedlines').RedlineEditKind`,
 * an inline type import that drags a browser module — and `DOMParser`,
 * `Element`, `Document` — into any program that reads it.
 * `apps/api/src/db/rows.ts` hit exactly that and recorded it at length, and
 * `playbook/applyChangeset.ts` worked around it by DECLARING its own
 * structurally-identical `StandardPosition` and `PlaybookClause`.
 *
 * That workaround is gone. These are the single declarations now:
 * `applyChangeset.ts` imports them from here, and `src/types.ts` re-exports
 * them, so not one importing file in `src/` changed when they moved. Two
 * declarations of one type that structurally match is exactly the drift S14
 * exists to prevent, and TypeScript will never complain about it.
 *
 * ## What stayed behind
 *
 * Types only the browser has — `Playbook`, `PlaybookDraft`, `Matter`,
 * `Review`, `Changeset`, `PrecedentSet`, `Settings`, the schema version —
 * stay declared in `src/types.ts`. This file is the review closure's shapes
 * and nothing else; a type moves here when something on the server needs it,
 * not because it happened to be nearby.
 *
 * ## `DocumentFile.file`
 *
 * `File` is a global that resolves differently per program: the DOM's in the
 * web app's tsconfig, `@types/node`'s (i.e. `node:buffer`'s) in this
 * package's and in `apps/api`'s. That is survivable ONLY because nothing
 * outside `src/` ever reads or constructs that field — the extractors take a
 * `DocumentFile` for its `text`, its `pageImages` and its `parseError`, and
 * never touch the handle. Do not add server-side code that does.
 */


export type RiskLevel = 'High' | 'Medium' | 'Low' | 'Info';

export type PositionOrigin = 'authored' | 'ai-drafted' | 'learned';

/** The comparison result between a clause and its `StandardPosition`. Produced
 *  ONLY by `normalisePositionOutcome` in `positionOutcome.ts`, beside this file. */
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
   *  "6 redlines across 4 documents"). Presentational; this string itself
   *  resolves to nothing.
   *
   *  SOMETHING DOES RESOLVE IT NOW, and it is not this field. `position_basis`
   *  (server spec §6.5) records the precedent documents and the specific
   *  edits a learned position was adopted from, keyed by `(playbookId,
   *  clauseId)` so the evidence survives every later publish — read by
   *  `getPositionBasis` and rendered by `TheWorkings`. This stays the
   *  human-readable SUMMARY rather than becoming the link: a sentence a
   *  reader can take in at a glance, beside a panel that can show the four
   *  leases and the four strikes. */
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
   *  `verification.ts`, beside this file. Stored on the note so a note stays
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
   *  `normalisePositionOutcome` (`positionOutcome.ts`, beside this file). */
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
  /**
   * WHETHER THE TEXT ABOVE IS THE DOCUMENT'S TEXT YET (§9, §11's third load
   * state).
   *
   * The server stores a document's BYTES and returns; a parse worker reads
   * them and is the only writer of this field. So `text` is `''` and this is
   * `'pending'` for the moment between the two, and a reader that cannot
   * tell that apart from a document that genuinely says nothing is looking
   * at this project's founding defect with a different cause.
   *
   * OPTIONAL, because an in-memory `DocumentRecord` built in the browser
   * (`toDocumentRecord`) has not been anywhere that could answer it. Absent
   * means "not from a server"; it never means "parsed".
   *
   *   'pending' — being read. Refused as a review target, by the API.
   *   'parsed'  — the text is the document's.
   *   'failed'  — it could not be read, and `parseError` says why. Also
   *               refused: a review of no text reports every clause absent.
   */
  parseState?: 'pending' | 'parsed' | 'failed';
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
