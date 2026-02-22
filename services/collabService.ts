import {
  ActivityEvent,
  AnalysisFinding,
  FindingComment,
  FindingReviewStatus,
  FindingStatusHistoryItem,
  NotificationItem,
  ReviewDocumentRef,
  ReviewSessionDetail,
  ReviewSessionSummary,
  Template,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../types";
import { getSupabaseClient } from "./authService";

type CollabEvent = {
  id: string;
  workspaceId: string;
  type: string;
  entityId: string;
  payload?: Record<string, any>;
  createdAt: string;
};

type LocalInvite = {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  token?: string;
  expiresAt: string;
  acceptedAt?: string | null;
};

type LocalStore = {
  workspaces: Workspace[];
  members: WorkspaceMember[];
  invites: LocalInvite[];
  reviews: ReviewSessionSummary[];
  reviewDocuments: ReviewDocumentRef[];
  reviewFindingsById: Record<string, Record<string, AnalysisFinding>>;
  reviewTemplateSnapshots: Record<string, Partial<Template>>;
  reviewDocOrderById: Record<string, string[]>;
  comments: FindingComment[];
  statuses: FindingStatusHistoryItem[];
  activity: ActivityEvent[];
  notifications: NotificationItem[];
  events: CollabEvent[];
};

const LOCAL_KEY = "lexprompt_collab_local_v1";
const nowIso = () => new Date().toISOString();
const id = (p: string) => {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return `${p}_${c.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  return `${p}_${Math.random().toString(36).slice(2, 10)}`;
};

const defaultStore = (): LocalStore => ({
  workspaces: [],
  members: [],
  invites: [],
  reviews: [],
  reviewDocuments: [],
  reviewFindingsById: {},
  reviewTemplateSnapshots: {},
  reviewDocOrderById: {},
  comments: [],
  statuses: [],
  activity: [],
  notifications: [],
  events: [],
});

const loadStore = (): LocalStore => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return defaultStore();
    return { ...defaultStore(), ...(JSON.parse(raw) as Partial<LocalStore>) };
  } catch {
    return defaultStore();
  }
};

const saveStore = (store: LocalStore) => localStorage.setItem(LOCAL_KEY, JSON.stringify(store));

const collabApiMode = (): "auto" | "true" | "false" => {
  const v = ((import.meta as any).env?.VITE_USE_COLLAB_API ?? "auto").toLowerCase();
  if (v === "true" || v === "false") return v;
  return "auto";
};

const shouldUseApi = (): boolean => {
  const mode = collabApiMode();
  if (mode === "true") return true;
  if (mode === "false") return false;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return false;
  }
  return true;
};

const getAuthHeaders = async (actorEmail: string, includeContentType = false): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["Content-Type"] = "application/json";

  const supabase = getSupabaseClient();
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      return headers;
    }
  }

  const env = (import.meta as any).env || {};
  const demoEnabled = String(env.VITE_ENABLE_DEMO_AUTH ?? "false").toLowerCase() === "true";
  // Local fallback for explicit demo-mode development only.
  if (!env.PROD && demoEnabled) {
    headers["x-user-email"] = actorEmail.toLowerCase();
    return headers;
  }

  throw new Error("Missing authenticated session. Please sign in again.");
};

const readJson = async (res: Response) => {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    throw new Error(
      `Collab API returned non-JSON (${res.status}). ${
        text.slice(0, 80) || "No response body"
      }`
    );
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
};

const extractMentions = (text: string): string[] => {
  const matches = text.match(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi) || [];
  return Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())));
};

const pushLocalActivity = (store: LocalStore, workspaceId: string, actorEmail: string, type: string, entityId: string, metadata?: Record<string, any>) => {
  store.activity.push({
    id: id("act"),
    workspaceId,
    actorId: actorEmail,
    actorEmail,
    type,
    entityId,
    metadata: metadata || {},
    createdAt: nowIso(),
  });
};

const pushLocalEvent = (store: LocalStore, workspaceId: string, type: string, entityId: string, payload?: Record<string, any>) => {
  store.events.push({
    id: id("evt"),
    workspaceId,
    type,
    entityId,
    payload: payload || {},
    createdAt: nowIso(),
  });
};

const listLocalMembers = (store: LocalStore, workspaceId: string) => store.members.filter((m) => m.workspaceId === workspaceId);

export type CreateReviewSessionPayload = {
  title: string;
  templateSnapshot?: Partial<Template>;
  findings: Record<string, AnalysisFinding>;
  docOrder?: string[];
  provider?: string;
  model?: string;
  region?: string;
  policyVersion?: string;
  status?: "complete" | "incomplete";
  documents: Array<{
    id?: string;
    name: string;
    mimeType: string;
    docType: "pdf" | "docx" | "txt";
    sizeBytes?: number;
    pageCount?: number;
    charCount?: number;
    storagePath?: string;
    sourceUrl?: string;
    sourceDataUrl?: string;
    contentText: string;
  }>;
};

const normalizeDocOrder = (raw: any, docs: ReviewDocumentRef[]): string[] => {
  const candidate = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  if (candidate.length > 0) return candidate;
  return docs.map((doc) => doc.id);
};

export const listWorkspaces = async (actorEmail: string): Promise<Workspace[]> => {
  if (shouldUseApi()) {
    const res = await fetch("/api/v1/workspaces", { headers: await getAuthHeaders(actorEmail) });
    const body = await readJson(res);
    return body.workspaces || [];
  }
  const store = loadStore();
  const memberWs = new Set(store.members.filter((m) => m.email.toLowerCase() === actorEmail.toLowerCase()).map((m) => m.workspaceId));
  return store.workspaces.filter((w) => memberWs.has(w.id));
};

export const createWorkspace = async (actorEmail: string, name: string): Promise<Workspace> => {
  if (shouldUseApi()) {
    const res = await fetch("/api/v1/workspaces", {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ name }),
    });
    const body = await readJson(res);
    return body.workspace;
  }
  const store = loadStore();
  const ws: Workspace = {
    id: id("ws"),
    name,
    ownerId: actorEmail,
    createdAt: nowIso(),
    archivedAt: null,
    retainSourceDocuments: false,
  };
  store.workspaces.push(ws);
  store.members.push({
    id: id("m"),
    workspaceId: ws.id,
    userId: actorEmail.toLowerCase(),
    email: actorEmail.toLowerCase(),
    role: "owner",
    invitedBy: actorEmail,
    joinedAt: nowIso(),
  });
  pushLocalActivity(store, ws.id, actorEmail, "workspace_created", ws.id, { name });
  saveStore(store);
  return ws;
};

export const getWorkspaceDetails = async (
  actorEmail: string,
  workspaceId: string
): Promise<{ workspace: Workspace; members: WorkspaceMember[] }> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}`, { headers: await getAuthHeaders(actorEmail) });
    return readJson(res);
  }
  const store = loadStore();
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  return { workspace, members: listLocalMembers(store, workspaceId) };
};

export const getWorkspaceSettings = async (
  actorEmail: string,
  workspaceId: string
): Promise<{ retainSourceDocuments: boolean }> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/settings`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.settings || { retainSourceDocuments: false };
  }
  const store = loadStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  return { retainSourceDocuments: Boolean(ws?.retainSourceDocuments) };
};

export const updateWorkspaceSettings = async (
  actorEmail: string,
  workspaceId: string,
  patch: { retainSourceDocuments?: boolean }
): Promise<{ retainSourceDocuments: boolean }> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/settings`, {
      method: "PATCH",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ retainSourceDocuments: Boolean(patch.retainSourceDocuments) }),
    });
    const body = await readJson(res);
    return body.settings || { retainSourceDocuments: false };
  }
  const store = loadStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("Workspace not found");
  ws.retainSourceDocuments = Boolean(patch.retainSourceDocuments);
  saveStore(store);
  return { retainSourceDocuments: Boolean(ws.retainSourceDocuments) };
};

export const createInvite = async (actorEmail: string, workspaceId: string, email: string, role: WorkspaceRole) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ email, role }),
    });
    return readJson(res);
  }
  const rawToken = id("tok");
  const store = loadStore();
  const invite: LocalInvite = {
    id: id("inv"),
    workspaceId,
    email: email.toLowerCase(),
    role,
    tokenHash: rawToken,
    token: rawToken,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    acceptedAt: null,
  };
  store.invites.push(invite);
  pushLocalActivity(store, workspaceId, actorEmail, "invite_created", invite.id, { email, role });
  saveStore(store);
  return { invite, inviteLink: `/accept-invite?workspace=${workspaceId}&token=${invite.token || invite.tokenHash}` };
};

export const listMembers = async (actorEmail: string, workspaceId: string): Promise<WorkspaceMember[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/members`, { headers: await getAuthHeaders(actorEmail) });
    const body = await readJson(res);
    return body.members || [];
  }
  const store = loadStore();
  return listLocalMembers(store, workspaceId);
};

export const updateMemberRole = async (actorEmail: string, workspaceId: string, userId: string, role: WorkspaceRole) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ role }),
    });
    return readJson(res);
  }
  const store = loadStore();
  const member = store.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
  if (!member) throw new Error("Member not found");
  const from = member.role;
  member.role = role;
  pushLocalActivity(store, workspaceId, actorEmail, "member_role_changed", member.id, { userId, from, to: role });
  saveStore(store);
  return { member };
};

export const addFindingComment = async (
  actorEmail: string,
  workspaceId: string,
  findingId: string,
  text: string
): Promise<FindingComment[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/findings/${encodeURIComponent(findingId)}/comments?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ text }),
    });
    const body = await readJson(res);
    return body.comments || [];
  }
  const store = loadStore();
  const mentions = extractMentions(text);
  const comment: FindingComment = {
    id: id("c"),
    findingId,
    workspaceId,
    authorId: actorEmail,
    authorEmail: actorEmail,
    text,
    mentions,
    createdAt: nowIso(),
    editedAt: null,
  };
  store.comments.push(comment);
  pushLocalActivity(store, workspaceId, actorEmail, "comment_added", comment.id, { findingId });
  pushLocalEvent(store, workspaceId, "comment_added", comment.id, { findingId });
  for (const mention of mentions) {
    store.notifications.push({
      id: id("n"),
      workspaceId,
      userEmail: mention,
      type: "mention",
      title: `${actorEmail} mentioned you in a finding`,
      read: false,
      createdAt: nowIso(),
      entityId: findingId,
    });
  }
  saveStore(store);
  return store.comments.filter((c) => c.workspaceId === workspaceId && c.findingId === findingId);
};

export const getFindingComments = async (actorEmail: string, workspaceId: string, findingId: string): Promise<FindingComment[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/findings/${encodeURIComponent(findingId)}/comments?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.comments || [];
  }
  const store = loadStore();
  return store.comments.filter((c) => c.workspaceId === workspaceId && c.findingId === findingId);
};

export const updateFindingStatus = async (
  actorEmail: string,
  workspaceId: string,
  findingId: string,
  status: FindingReviewStatus,
  expectedVersion?: number
) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/findings/${encodeURIComponent(findingId)}/status?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ status, expectedVersion }),
    });
    return readJson(res);
  }
  const store = loadStore();
  const history = store.statuses.filter((s) => s.workspaceId === workspaceId && s.findingId === findingId);
  const current = history[history.length - 1]?.to || "open";
  if (typeof expectedVersion === "number" && expectedVersion !== history.length) {
    throw new Error("Version conflict: finding status changed by another user.");
  }
  const item: FindingStatusHistoryItem = {
    id: id("s"),
    findingId,
    workspaceId,
    from: current,
    to: status,
    changedBy: actorEmail,
    changedByEmail: actorEmail,
    changedAt: nowIso(),
  };
  store.statuses.push(item);
  pushLocalActivity(store, workspaceId, actorEmail, "finding_status_changed", item.id, { findingId, from: current, to: status });
  pushLocalEvent(store, workspaceId, "status_changed", item.id, { findingId, to: status });
  saveStore(store);
  return { status, version: history.length + 1, historyItem: item };
};

export const getFindingStatus = async (actorEmail: string, workspaceId: string, findingId: string) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/findings/${encodeURIComponent(findingId)}/status?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: await getAuthHeaders(actorEmail),
    });
    return readJson(res);
  }
  const store = loadStore();
  const history = store.statuses.filter((s) => s.workspaceId === workspaceId && s.findingId === findingId);
  return { history, current: history[history.length - 1]?.to || "open", version: history.length };
};

export const getActivity = async (actorEmail: string, workspaceId: string): Promise<ActivityEvent[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/activity?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.activity || [];
  }
  const store = loadStore();
  return store.activity
    .filter((a) => a.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

export const getNotifications = async (actorEmail: string, workspaceId: string): Promise<NotificationItem[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/notifications?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.notifications || [];
  }
  const store = loadStore();
  return store.notifications
    .filter((n) => n.workspaceId === workspaceId && n.userEmail.toLowerCase() === actorEmail.toLowerCase())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

export const markNotificationRead = async (actorEmail: string, workspaceId: string, idValue: string) => {
  if (shouldUseApi()) {
    const res = await fetch("/api/v1/notifications", {
      method: "PATCH",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ workspaceId, id: idValue }),
    });
    return readJson(res);
  }
  const store = loadStore();
  const n = store.notifications.find(
    (x) =>
      x.id === idValue &&
      x.workspaceId === workspaceId &&
      x.userEmail.toLowerCase() === actorEmail.toLowerCase()
  );
  if (n) n.read = true;
  saveStore(store);
  return { notification: n };
};

export const createReviewUploadContract = async (
  actorEmail: string,
  workspaceId: string,
  reviewId: string,
  documents: Array<{ id?: string; name: string }>
) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/reviews/upload-url`, {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ reviewId, documents }),
    });
    return readJson(res);
  }
  return {
    uploads: documents.map((doc, idx) => ({
      docId: doc.id || id("rd"),
      storagePath: `workspaces/${workspaceId}/reviews/${reviewId}/${idx + 1}-${doc.name}`,
    })),
  };
};

export const createReviewSession = async (
  actorEmail: string,
  workspaceId: string,
  payload: CreateReviewSessionPayload
): Promise<ReviewSessionDetail> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/reviews`, {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    return body.review as ReviewSessionDetail;
  }

  const store = loadStore();
  const reviewId = id("rev");
  const createdAt = nowIso();
  const documents: ReviewDocumentRef[] = (payload.documents || []).map((doc, idx) => ({
    id: doc.id || id("rd"),
    workspaceId,
    reviewId,
    name: doc.name,
    mimeType: doc.mimeType,
    docType: doc.docType,
    sizeBytes: doc.sizeBytes,
    pageCount: doc.pageCount,
    charCount: doc.charCount,
    storagePath: doc.storagePath || `workspaces/${workspaceId}/reviews/${reviewId}/${idx + 1}-${doc.name}`,
    sourceUrl: doc.sourceUrl,
    sourceDataUrl: doc.sourceDataUrl,
    contentText: doc.contentText || "",
    createdAt,
  }));
  const docOrder = payload.docOrder?.length ? payload.docOrder : documents.map((doc) => doc.id);
  const summary: ReviewSessionSummary = {
    id: reviewId,
    workspaceId,
    title: payload.title || "Contract Analysis",
    createdBy: actorEmail,
    createdAt,
    model: payload.model,
    provider: payload.provider as any,
    region: payload.region as any,
    policyVersion: payload.policyVersion,
    docCount: documents.length,
    status: payload.status || "complete",
  };

  store.reviews.push(summary);
  store.reviewDocuments.push(...documents);
  store.reviewFindingsById[reviewId] = payload.findings || {};
  store.reviewTemplateSnapshots[reviewId] = payload.templateSnapshot || {};
  store.reviewDocOrderById[reviewId] = docOrder;
  pushLocalActivity(store, workspaceId, actorEmail, "review_session_created", reviewId, { docs: documents.length, model: payload.model });
  pushLocalEvent(store, workspaceId, "analysis_completed", reviewId, { reviewId, docs: documents.length });
  saveStore(store);

  return {
    ...summary,
    templateSnapshot: store.reviewTemplateSnapshots[reviewId] || {},
    findings: store.reviewFindingsById[reviewId] || {},
    documents,
    docOrder,
  };
};

export const listReviewSessions = async (actorEmail: string, workspaceId: string): Promise<ReviewSessionSummary[]> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/reviews`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.reviews || [];
  }
  const store = loadStore();
  return store.reviews
    .filter((review) => review.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

export const getReviewSession = async (
  actorEmail: string,
  workspaceId: string,
  reviewId: string
): Promise<ReviewSessionDetail> => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/reviews/${reviewId}`, {
      headers: await getAuthHeaders(actorEmail),
    });
    const body = await readJson(res);
    return body.review as ReviewSessionDetail;
  }
  const store = loadStore();
  const summary = store.reviews.find((review) => review.workspaceId === workspaceId && review.id === reviewId);
  if (!summary) throw new Error("Review session not found");
  const documents = store.reviewDocuments.filter((doc) => doc.workspaceId === workspaceId && doc.reviewId === reviewId);
  return {
    ...summary,
    templateSnapshot: store.reviewTemplateSnapshots[reviewId] || {},
    findings: store.reviewFindingsById[reviewId] || {},
    documents,
    docOrder: normalizeDocOrder(store.reviewDocOrderById[reviewId], documents),
  };
};

export const deleteReviewSession = async (actorEmail: string, workspaceId: string, reviewId: string) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/reviews/${reviewId}`, {
      method: "DELETE",
      headers: await getAuthHeaders(actorEmail, true),
    });
    return readJson(res);
  }
  const store = loadStore();
  store.reviews = store.reviews.filter((review) => !(review.workspaceId === workspaceId && review.id === reviewId));
  store.reviewDocuments = store.reviewDocuments.filter((doc) => !(doc.workspaceId === workspaceId && doc.reviewId === reviewId));
  delete store.reviewFindingsById[reviewId];
  delete store.reviewTemplateSnapshots[reviewId];
  delete store.reviewDocOrderById[reviewId];
  pushLocalActivity(store, workspaceId, actorEmail, "review_session_deleted", reviewId, { reviewId });
  saveStore(store);
  return { ok: true };
};

export const pollWorkspaceEvents = async (actorEmail: string, workspaceId: string, since?: string) => {
  if (shouldUseApi()) {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/events${query}`, { headers: await getAuthHeaders(actorEmail) });
    const body = await readJson(res);
    return body.events || [];
  }
  const store = loadStore();
  const sinceMs = since ? new Date(since).getTime() : 0;
  return store.events.filter((e) => e.workspaceId === workspaceId && new Date(e.createdAt).getTime() > sinceMs);
};

export const publishWorkspaceEvent = async (
  actorEmail: string,
  workspaceId: string,
  type: string,
  entityId: string,
  payload?: Record<string, any>
) => {
  if (shouldUseApi()) {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/events`, {
      method: "POST",
      headers: await getAuthHeaders(actorEmail, true),
      body: JSON.stringify({ type, entityId, payload }),
    });
    return readJson(res);
  }
  const store = loadStore();
  pushLocalEvent(store, workspaceId, type, entityId, payload);
  pushLocalActivity(store, workspaceId, actorEmail, type, entityId, payload);
  saveStore(store);
  return { ok: true };
};
