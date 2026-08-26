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
  status: 'pending' | 'running' | 'done' | 'error';
  summary?: string;
  citations: string[];
  riskLevel?: RiskLevel;
  riskAnalysis?: string;
  error?: string;
  edited?: boolean;
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
}

export interface Settings {
  apiKey: string;
  modelId: string;
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  modelId: '',
  concurrency: 5,
};
