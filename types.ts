
export type UserRole = 'admin' | 'user';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  joinedAt?: any;
}

export interface Clause {
  id: string;
  title: string;
  prompt: string;
  riskCriteria?: string;
}

export interface Template {
  id?: string;
  name: string;
  contractType: string;
  mode: 'extraction' | 'risk';
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  clauses: Clause[];
  scope?: 'private' | 'team';
  createdAt?: any;
  updatedAt?: any;
}

export interface DocumentFile {
  id: string;
  name: string;
  content: string; // Extracted text
  fileObj: File;
  type: 'pdf' | 'docx' | 'txt';
}

export interface AnalysisFinding {
  summary: string;
  citations: string[];
  risk_level?: 'High' | 'Medium' | 'Low' | 'Info';
  risk_analysis?: string;
}

export interface AnalysisResult {
  id: string;
  title: string;
  data: Record<string, AnalysisFinding>;
  docIndices: number[]; // Indices of documents in the session array
  timestamp: Date;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LogEntry {
  action: string;
  user: string;
  template: string;
  docs: string[];
  timestamp: any;
  analysisResult?: AnalysisResult;
}

// --- Tabular Review Types ---

export interface TabularColumn {
  id: string;
  title: string; // The header (e.g., "Governing Law")
  query: string; // The question (e.g., "What is the governing law?")
}

export interface TabularCell {
  value: string;
  quote: string;
  confidence: 'High' | 'Medium' | 'Low';
  status: 'loading' | 'done' | 'error';
  isEdited?: boolean;
}

// Map: DocID -> ColumnID -> Cell
export type TabularData = Record<string, Record<string, TabularCell>>;
