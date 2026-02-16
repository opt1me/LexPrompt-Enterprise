
export type UserRole = 'admin' | 'user';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  joinedAt?: any;
}

export type AIProvider = 'google' | 'openai' | 'anthropic';

export interface ProviderKeys {
  google?: string;
  openai?: string;
  anthropic?: string;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  timestamp: string;
  role?: 'analyst' | 'reviewer';
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
  content: string;
  fileObj: File;
  type: 'pdf' | 'docx' | 'txt';
}

export interface AnalysisFinding {
  summary: string;
  citations: string[];
  risk_level?: 'High' | 'Medium' | 'Low' | 'Info';
  risk_analysis?: string;
  comments?: Comment[]; 
  reviewedBy?: string;
}

export interface AnalysisResult {
  id: string;
  title: string;
  data: Record<string, AnalysisFinding>;
  docIndices: number[];
  timestamp: Date;
  modelUsed?: string;
  providerUsed?: AIProvider;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

export interface TabularColumn {
  id: string;
  title: string;
  query: string;
}

export interface TabularCell {
  value: string;
  quote: string;
  confidence: 'High' | 'Medium' | 'Low';
  status: 'loading' | 'done' | 'error';
  isEdited?: boolean;
}

export type TabularData = Record<string, Record<string, TabularCell>>;
