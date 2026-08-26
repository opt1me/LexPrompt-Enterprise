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

export interface Finding {
  clauseId: string;
  /** 'cancelled' is distinct from 'error': the run was stopped by the user
   *  (or a queued cell never got a turn before that happened), not a failed
   *  request. It is a calm, non-retryable-looking state, never a raw
   *  DOMException string behind an error banner. */
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  summary?: string;
  citations: string[];
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

/** Bumped from TEMPLATE_SCHEMA_VERSION (2) — see src/lib/db/migrate.ts. */
export const SCHEMA_VERSION = 3;

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
