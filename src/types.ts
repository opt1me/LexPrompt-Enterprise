export const TEMPLATE_SCHEMA_VERSION = 2;

export type RiskLevel = 'High' | 'Medium' | 'Low' | 'Info';

export interface Clause {
  id: string;
  title: string;
  prompt: string;
  riskCriteria?: string;
}

export interface Template {
  id: string;
  name: string;
  contractType: string;
  mode: 'extraction' | 'risk';
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  clauses: Clause[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

/** The redesign's name for a Template. Structurally identical in sub-project A;
 *  versioning and standard positions arrive in sub-project D. */
export type Playbook = Template;

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
  /** Set when the model returned a schema-valid response with an empty (or
   *  whitespace-only) `summary`. A model with a genuine answer — including
   *  "this document is silent on this point" — always writes something; an
   *  empty string is a non-answer, not a finding, so this is surfaced as an
   *  `error` status rather than `done` (see `extractClause.ts`). Lets
   *  run-level UI count this pattern without string-matching `error`. */
  noContent?: boolean;
}

export interface ReviewRun {
  id: string;
  /** Frozen copy, so editing the template later does not rewrite what this run claims to have checked. */
  templateSnapshot: Template;
  documentIds: string[];
  /** docId -> clauseId -> Finding */
  findings: Record<string, Record<string, Finding>>;
  startedAt: number;
  completedAt?: number;
  /** Set when the run was stopped via AbortSignal rather than running to
   *  completion. Mutually exclusive with `completedAt` — read together they
   *  tell a finished run apart from a cancelled one, which nothing did
   *  before (`completedAt` was written and never read). */
  cancelledAt?: number;
}

export interface Settings {
  apiKey: string;
  modelId: string;
  concurrency: number;
  /** Capabilities of the currently selected model, filled in from the
   *  cached OpenRouter model list whenever it's available. `undefined`
   *  means "unknown" (list not loaded yet, fetch failed, or a manually
   *  entered model id with no matching list entry) and is always treated
   *  conservatively — the same posture `chatContext.ts` already takes for
   *  an unresolved model. */
  modelSupportsImages?: boolean;
  modelSupportsStructuredOutput?: boolean;
  modelContextLength?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  modelId: '',
  concurrency: 5,
};

/** 3 to 4: `Finding.citations` became `Citation[]`, and `Finding` gained
 *  `verification` and `notes` (sub-project B). Reviews written at 3 are
 *  upgraded on read — see `src/lib/db/reviewMigration.ts`. */
export const SCHEMA_VERSION = 4;

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
  byteSize: number;
  addedAt: number;
  addedByUserId: string;
}

export interface Review {
  id: string;
  matterId: string;
  playbookSnapshot: Playbook;
  documentIds: string[];
  findings: Record<string, Record<string, Finding>>;
  modelId: string;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  createdByUserId: string;
}
