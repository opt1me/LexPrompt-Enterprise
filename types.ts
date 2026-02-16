
export type UserRole = 'admin' | 'user';
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'reviewer';

export interface UserProfile {
  uid: string;
  email: string;
  role: UserRole;
  joinedAt?: any;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  archivedAt?: string | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  joinedAt: string;
}

export interface Invite {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  expiresAt: string;
  acceptedAt?: string | null;
}

export interface FindingComment {
  id: string;
  findingId: string;
  workspaceId: string;
  authorId: string;
  authorEmail: string;
  text: string;
  mentions: string[];
  createdAt: string;
  editedAt?: string | null;
}

export type FindingReviewStatus = 'open' | 'needs-review' | 'approved';

export interface FindingStatusHistoryItem {
  id: string;
  findingId: string;
  workspaceId: string;
  from: FindingReviewStatus;
  to: FindingReviewStatus;
  changedBy: string;
  changedByEmail: string;
  changedAt: string;
}

export interface ActivityEvent {
  id: string;
  workspaceId: string;
  actorId: string;
  actorEmail: string;
  type: string;
  entityId: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  workspaceId: string;
  userEmail: string;
  type: 'mention' | 'assignment' | 'job_completed';
  title: string;
  read: boolean;
  createdAt: string;
  entityId?: string;
}

export type AIProvider = 'google' | 'openai' | 'anthropic';
export type ResidencyMode = 'uk_preferred_eu_fallback' | 'strict_uk_only' | 'eu_only';
export type DataRegion = 'uk-london' | 'eu-frankfurt' | 'eu-ireland';

export interface ProviderKeys {
  google?: string;
  openai?: string;
  anthropic?: string;
}

export interface ResidencySettings {
  primaryRegion: DataRegion;
  fallbackRegion: Exclude<DataRegion, 'uk-london'>;
  residencyMode: ResidencyMode;
  noTraining: boolean;
  minRetention: boolean;
  policyVersion: string;
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
  sizeBytes?: number;
  charCount?: number;
  pageCount?: number;
  storagePath?: string;
  sourceUrl?: string;
  sha256?: string;
  sourceDataUrl?: string;
}

export interface AnalysisFinding {
  summary: string;
  citations: string[];
  risk_level?: 'High' | 'Medium' | 'Low' | 'Info';
  risk_analysis?: string;
  comments?: Comment[];
  reviewedBy?: string;
  collaborationStatus?: FindingReviewStatus;
}

export interface AnalysisResult {
  id: string;
  title: string;
  data: Record<string, AnalysisFinding>;
  docIndices: number[];
  timestamp: Date;
  modelUsed?: string;
  providerUsed?: AIProvider;
  regionUsed?: DataRegion;
  policyVersion?: string;
  auditId?: string;
  workspaceId?: string;
}

export interface ReviewDocumentRef {
  id: string;
  workspaceId: string;
  reviewId: string;
  name: string;
  mimeType: string;
  docType: 'pdf' | 'docx' | 'txt';
  sizeBytes?: number;
  pageCount?: number;
  charCount?: number;
  storagePath?: string;
  sourceUrl?: string;
  sourceDataUrl?: string;
  contentText: string;
  createdAt: string;
}

export interface ReviewSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  model?: string;
  provider?: AIProvider;
  region?: DataRegion;
  policyVersion?: string;
  docCount: number;
  status?: 'complete' | 'incomplete';
}

export interface ReviewSessionDetail extends ReviewSessionSummary {
  templateSnapshot?: Partial<Template>;
  findings: Record<string, AnalysisFinding>;
  documents: ReviewDocumentRef[];
  docOrder: string[];
}

export interface ReviewDeepLinkState {
  workspaceId?: string;
  reviewId?: string;
  view?: 'dashboard' | 'editor' | 'processor' | 'results' | 'tabular';
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

export interface AnalysisAuditEvent {
  id: string;
  eventType: 'analysis_started' | 'analysis_completed' | 'analysis_failed';
  createdAt: string;
  provider: AIProvider;
  model: string;
  region: DataRegion;
  policyVersion: string;
  residencyMode: ResidencyMode;
  workspaceId?: string;
  metadata?: Record<string, string | number | boolean>;
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
