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
