import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "crypto";
import {
  ActivityEvent,
  AnalysisFinding,
  AIProvider,
  DataRegion,
  FindingComment,
  FindingReviewStatus,
  FindingStatusHistoryItem,
  Invite,
  NotificationItem,
  ReviewDocumentRef,
  ReviewSessionDetail,
  ReviewSessionSummary,
  Template,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../../types";

type CollabEvent = {
  id: string;
  workspaceId: string;
  type: "comment_added" | "status_changed" | "analysis_completed";
  entityId: string;
  createdAt: string;
  payload?: Record<string, any>;
};

type ReviewStatus = "complete" | "incomplete";

export type CreateReviewSessionInput = {
  title: string;
  templateSnapshot?: Partial<Template>;
  findings: Record<string, AnalysisFinding>;
  docOrder?: string[];
  provider?: AIProvider;
  model?: string;
  region?: DataRegion;
  policyVersion?: string;
  status?: ReviewStatus;
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

type Store = {
  workspaces: Workspace[];
  members: WorkspaceMember[];
  invites: Invite[];
  reviews: ReviewSessionSummary[];
  reviewDocuments: ReviewDocumentRef[];
  reviewFindingsById: Record<string, Record<string, AnalysisFinding>>;
  reviewTemplateSnapshots: Record<string, Partial<Template>>;
  reviewDocOrderById: Record<string, string[]>;
  comments: FindingComment[];
  statuses: FindingStatusHistoryItem[];
  latestStatusByFinding: Record<string, FindingReviewStatus>;
  activity: ActivityEvent[];
  events: CollabEvent[];
  notifications: NotificationItem[];
};

const g = globalThis as any;
if (!g.__LEXPROMPT_COLLAB_STORE__) {
  g.__LEXPROMPT_COLLAB_STORE__ = {
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
    latestStatusByFinding: {},
    activity: [],
    events: [],
    notifications: [],
  } as Store;
}
const mem = g.__LEXPROMPT_COLLAB_STORE__ as Store;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const nowIso = () => new Date().toISOString();
const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const token = () => randomBytes(32).toString("hex");
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const INVITE_EXPIRY_MS = 48 * 60 * 60 * 1000;
const usingSupabase = () => !!db;

const extractMentions = (text: string): string[] => {
  const matches = text.match(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi) || [];
  return Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())));
};

const normalizeRole = (role: string): WorkspaceRole => {
  if (role === "owner" || role === "admin" || role === "editor" || role === "reviewer") return role;
  return "reviewer";
};

const mapWorkspace = (row: any): Workspace => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
  retainSourceDocuments: Boolean(row.retain_source_documents),
});

const mapMember = (row: any): WorkspaceMember => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  email: row.email,
  role: normalizeRole(row.role),
  invitedBy: row.invited_by,
  joinedAt: row.joined_at,
});

const mapInvite = (row: any): Invite => ({
  id: row.id,
  workspaceId: row.workspace_id,
  email: row.email,
  role: normalizeRole(row.role),
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  acceptedAt: row.accepted_at,
});

const mapComment = (row: any): FindingComment => ({
  id: row.id,
  findingId: row.finding_id,
  workspaceId: row.workspace_id,
  authorId: row.author_id,
  authorEmail: row.author_email,
  text: row.text,
  mentions: row.mentions || [],
  createdAt: row.created_at,
  editedAt: row.edited_at,
});

const mapStatus = (row: any): FindingStatusHistoryItem => ({
  id: row.id,
  findingId: row.finding_id,
  workspaceId: row.workspace_id,
  from: row.from_status,
  to: row.to_status,
  changedBy: row.changed_by,
  changedByEmail: row.changed_by_email,
  changedAt: row.changed_at,
});

const mapActivity = (row: any): ActivityEvent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  actorId: row.actor_id,
  actorEmail: row.actor_email,
  type: row.type,
  entityId: row.entity_id,
  metadata: row.metadata || {},
  createdAt: row.created_at,
});

const mapEvent = (row: any): CollabEvent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  type: row.type,
  entityId: row.entity_id,
  createdAt: row.created_at,
  payload: row.payload || {},
});

const mapNotification = (row: any): NotificationItem => ({
  id: row.id,
  workspaceId: row.workspace_id,
  userEmail: row.user_email,
  type: row.type,
  title: row.title,
  read: row.read,
  createdAt: row.created_at,
  entityId: row.entity_id,
});

const mapReviewSessionSummary = (row: any, docCount?: number): ReviewSessionSummary => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  createdBy: row.created_by,
  createdAt: row.created_at,
  model: row.model || undefined,
  provider: row.provider || undefined,
  region: row.region || undefined,
  policyVersion: row.policy_version || undefined,
  docCount: docCount ?? Number(row.doc_count || 0),
  status: (row.status as ReviewStatus) || "complete",
});

const mapReviewDocumentRef = (row: any): ReviewDocumentRef => ({
  id: row.id,
  workspaceId: row.workspace_id,
  reviewId: row.review_id,
  name: row.name,
  mimeType: row.mime_type,
  docType: row.doc_type,
  sizeBytes: row.size_bytes ?? undefined,
  pageCount: row.page_count ?? undefined,
  charCount: row.char_count ?? undefined,
  storagePath: row.storage_path ?? undefined,
  sourceUrl: row.source_url ?? undefined,
  sourceDataUrl: row.source_base64 ?? undefined,
  contentText: row.content_text || "",
  createdAt: row.created_at,
});

export const createWorkspaceWithOwner = async (name: string, ownerEmail: string): Promise<Workspace> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspaces")
      .insert({ name, owner_id: ownerEmail, retain_source_documents: false })
      .select("*")
      .single();
    if (error) throw error;
    const ws = mapWorkspace(data);
    await db!.from("workspace_members").insert({
      workspace_id: ws.id,
      user_id: ownerEmail,
      email: ownerEmail,
      role: "owner",
      invited_by: ownerEmail,
    });
    await pushActivity(ws.id, ownerEmail, "workspace_created", ws.id, { name });
    return ws;
  }

  const ws: Workspace = {
    id: id("ws"),
    name,
    ownerId: ownerEmail,
    createdAt: nowIso(),
    archivedAt: null,
    retainSourceDocuments: false,
  };
  mem.workspaces.push(ws);
  mem.members.push({
    id: id("m"),
    workspaceId: ws.id,
    userId: ownerEmail,
    email: ownerEmail,
    role: "owner",
    invitedBy: ownerEmail,
    joinedAt: nowIso(),
  });
  await pushActivity(ws.id, ownerEmail, "workspace_created", ws.id, { name });
  return ws;
};

export const listWorkspacesForUser = async (userEmail: string): Promise<Workspace[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspace_members")
      .select("workspace_id, workspaces(*)")
      .eq("email", userEmail.toLowerCase());
    if (error) throw error;
    return (data || []).map((r: any) => mapWorkspace(r.workspaces));
  }
  const ids = new Set(mem.members.filter((m) => m.email.toLowerCase() === userEmail.toLowerCase()).map((m) => m.workspaceId));
  return mem.workspaces.filter((w) => ids.has(w.id));
};

export const getWorkspace = async (workspaceId: string): Promise<Workspace | undefined> => {
  if (usingSupabase()) {
    const { data, error } = await db!.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    return data ? mapWorkspace(data) : undefined;
  }
  return mem.workspaces.find((w) => w.id === workspaceId);
};

export const getWorkspaceSettings = async (workspaceId: string): Promise<{ retainSourceDocuments: boolean }> => {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  return { retainSourceDocuments: Boolean(workspace.retainSourceDocuments) };
};

export const updateWorkspaceSettings = async (
  workspaceId: string,
  actorEmail: string,
  patch: { retainSourceDocuments?: boolean }
): Promise<{ retainSourceDocuments: boolean }> => {
  const retainSourceDocuments = Boolean(patch.retainSourceDocuments);
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspaces")
      .update({ retain_source_documents: retainSourceDocuments })
      .eq("id", workspaceId)
      .select("*")
      .single();
    if (error) throw error;
    await pushActivity(workspaceId, actorEmail, "workspace_settings_updated", workspaceId, {
      retainSourceDocuments,
    });
    return { retainSourceDocuments: Boolean(data?.retain_source_documents) };
  }

  const workspace = mem.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  workspace.retainSourceDocuments = retainSourceDocuments;
  await pushActivity(workspaceId, actorEmail, "workspace_settings_updated", workspaceId, {
    retainSourceDocuments,
  });
  return { retainSourceDocuments };
};

export const getMembers = async (workspaceId: string): Promise<WorkspaceMember[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!.from("workspace_members").select("*").eq("workspace_id", workspaceId);
    if (error) throw error;
    return (data || []).map(mapMember);
  }
  return mem.members.filter((m) => m.workspaceId === workspaceId);
};

export const getMembership = async (workspaceId: string, userEmail: string): Promise<WorkspaceMember | undefined> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspace_members")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("email", userEmail.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data ? mapMember(data) : undefined;
  }
  return mem.members.find((m) => m.workspaceId === workspaceId && m.email.toLowerCase() === userEmail.toLowerCase());
};

export const hasRole = async (workspaceId: string, userEmail: string, allowed: WorkspaceRole[]): Promise<boolean> => {
  const member = await getMembership(workspaceId, userEmail);
  return !!member && allowed.includes(member.role);
};

const normalizeDocOrder = (raw: any, docs: ReviewDocumentRef[]): string[] => {
  const candidate = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  if (candidate.length > 0) return candidate;
  return docs.map((d) => d.id);
};

export const createReviewSession = async (
  workspaceId: string,
  actorEmail: string,
  input: CreateReviewSessionInput
): Promise<ReviewSessionDetail> => {
  const reviewId = id("rev");
  const status: ReviewStatus = input.status || "complete";
  const settings = await getWorkspaceSettings(workspaceId);
  const retainSourceDocuments = settings.retainSourceDocuments;

  if (usingSupabase()) {
    const sessionPayload = {
      id: reviewId,
      workspace_id: workspaceId,
      title: input.title || "Contract Analysis",
      template_snapshot: input.templateSnapshot || {},
      findings: input.findings || {},
      doc_order: input.docOrder || input.documents.map((d) => d.id || id("rd")),
      provider: input.provider || null,
      model: input.model || null,
      region: input.region || null,
      policy_version: input.policyVersion || null,
      status,
      created_by: actorEmail,
    };
    const { data: sessionRow, error: sessionError } = await db!.from("review_sessions").insert(sessionPayload).select("*").single();
    if (sessionError) throw sessionError;

    const documentsToInsert = (input.documents || []).map((doc, idx) => ({
      id: doc.id || id("rd"),
      review_id: sessionRow.id,
      workspace_id: workspaceId,
      name: doc.name,
      mime_type: doc.mimeType,
      doc_type: doc.docType,
      size_bytes: doc.sizeBytes ?? null,
      page_count: doc.pageCount ?? null,
      char_count: doc.charCount ?? null,
      storage_path: doc.storagePath || `workspaces/${workspaceId}/reviews/${sessionRow.id}/${idx + 1}-${doc.name}`,
      source_url: doc.sourceUrl || null,
      source_base64: retainSourceDocuments ? doc.sourceDataUrl || null : null,
      content_text: retainSourceDocuments ? doc.contentText || "" : "",
    }));

    if (documentsToInsert.length > 0) {
      const { error: docsError } = await db!.from("review_documents").insert(documentsToInsert);
      if (docsError) throw docsError;
    }

    await pushActivity(workspaceId, actorEmail, "review_session_created", sessionRow.id, {
      reviewId: sessionRow.id,
      docs: documentsToInsert.length,
      model: input.model || undefined,
      retainSourceDocuments,
    });
    await publishEvent(workspaceId, "analysis_completed", sessionRow.id, {
      reviewId: sessionRow.id,
      docs: documentsToInsert.length,
      retainSourceDocuments,
    });

    return getReviewSessionDetail(workspaceId, sessionRow.id);
  }

  const documents: ReviewDocumentRef[] = (input.documents || []).map((doc, idx) => ({
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
    sourceDataUrl: retainSourceDocuments ? doc.sourceDataUrl : undefined,
    contentText: retainSourceDocuments ? doc.contentText || "" : "",
    createdAt: nowIso(),
  }));

  const docOrder = input.docOrder?.length ? input.docOrder : documents.map((d) => d.id);
  const summary: ReviewSessionSummary = {
    id: reviewId,
    workspaceId,
    title: input.title || "Contract Analysis",
    createdBy: actorEmail,
    createdAt: nowIso(),
    model: input.model,
    provider: input.provider,
    region: input.region,
    policyVersion: input.policyVersion,
    docCount: documents.length,
    status,
  };

  mem.reviews.push(summary);
  mem.reviewDocuments.push(...documents);
  mem.reviewFindingsById[reviewId] = input.findings || {};
  mem.reviewTemplateSnapshots[reviewId] = input.templateSnapshot || {};
  mem.reviewDocOrderById[reviewId] = docOrder;

  await pushActivity(workspaceId, actorEmail, "review_session_created", reviewId, {
    reviewId,
    docs: documents.length,
    model: input.model || undefined,
    retainSourceDocuments,
  });
  await publishEvent(workspaceId, "analysis_completed", reviewId, {
    reviewId,
    docs: documents.length,
    retainSourceDocuments,
  });

  return {
    ...summary,
    templateSnapshot: mem.reviewTemplateSnapshots[reviewId] || {},
    findings: mem.reviewFindingsById[reviewId] || {},
    documents,
    docOrder,
  };
};

export const listReviewSessions = async (workspaceId: string): Promise<ReviewSessionSummary[]> => {
  if (usingSupabase()) {
    const { data: sessions, error } = await db!
      .from("review_sessions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = sessions || [];
    if (rows.length === 0) return [];

    const reviewIds = rows.map((row: any) => row.id);
    const { data: docs, error: docsError } = await db!
      .from("review_documents")
      .select("review_id")
      .in("review_id", reviewIds);
    if (docsError) throw docsError;

    const docCountByReview: Record<string, number> = {};
    (docs || []).forEach((d: any) => {
      docCountByReview[d.review_id] = (docCountByReview[d.review_id] || 0) + 1;
    });

    return rows.map((row: any) => mapReviewSessionSummary(row, docCountByReview[row.id] || 0));
  }

  return mem.reviews
    .filter((review) => review.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

export const getReviewSessionDetail = async (workspaceId: string, reviewId: string): Promise<ReviewSessionDetail> => {
  if (usingSupabase()) {
    const { data: sessionRow, error: sessionError } = await db!
      .from("review_sessions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", reviewId)
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!sessionRow) throw new Error("Review session not found");

    const { data: docsRows, error: docsError } = await db!
      .from("review_documents")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("review_id", reviewId)
      .order("created_at", { ascending: true });
    if (docsError) throw docsError;

    const documents = (docsRows || []).map(mapReviewDocumentRef);
    const summary = mapReviewSessionSummary(sessionRow, documents.length);
    return {
      ...summary,
      templateSnapshot: (sessionRow.template_snapshot || {}) as Partial<Template>,
      findings: (sessionRow.findings || {}) as Record<string, AnalysisFinding>,
      documents,
      docOrder: normalizeDocOrder(sessionRow.doc_order, documents),
    };
  }

  const summary = mem.reviews.find((review) => review.workspaceId === workspaceId && review.id === reviewId);
  if (!summary) throw new Error("Review session not found");
  const documents = mem.reviewDocuments.filter((doc) => doc.workspaceId === workspaceId && doc.reviewId === reviewId);
  return {
    ...summary,
    templateSnapshot: mem.reviewTemplateSnapshots[reviewId] || {},
    findings: mem.reviewFindingsById[reviewId] || {},
    documents,
    docOrder: normalizeDocOrder(mem.reviewDocOrderById[reviewId], documents),
  };
};

export const deleteReviewSession = async (workspaceId: string, reviewId: string, actorEmail: string): Promise<void> => {
  if (usingSupabase()) {
    const { error } = await db!
      .from("review_sessions")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", reviewId);
    if (error) throw error;
    await pushActivity(workspaceId, actorEmail, "review_session_deleted", reviewId, { reviewId });
    return;
  }

  mem.reviews = mem.reviews.filter((review) => !(review.workspaceId === workspaceId && review.id === reviewId));
  mem.reviewDocuments = mem.reviewDocuments.filter((doc) => !(doc.workspaceId === workspaceId && doc.reviewId === reviewId));
  delete mem.reviewFindingsById[reviewId];
  delete mem.reviewTemplateSnapshots[reviewId];
  delete mem.reviewDocOrderById[reviewId];
  await pushActivity(workspaceId, actorEmail, "review_session_deleted", reviewId, { reviewId });
};

export const createReviewUploadContract = async (
  workspaceId: string,
  reviewId: string,
  docs: Array<{ id?: string; name: string }>
): Promise<{ uploads: Array<{ docId: string; storagePath: string }> }> => {
  const uploads = docs.map((doc, idx) => {
    const docId = doc.id || id("rd");
    return {
      docId,
      storagePath: `workspaces/${workspaceId}/reviews/${reviewId}/${idx + 1}-${doc.name}`,
    };
  });
  return { uploads };
};

export const createInvite = async (workspaceId: string, inviterEmail: string, email: string, role: WorkspaceRole): Promise<Invite> => {
  const rawToken = token();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString();

  if (usingSupabase()) {
    const payload = {
      workspace_id: workspaceId,
      email: email.toLowerCase(),
      role,
      token_hash: tokenHash,
      expires_at: expiresAt,
    };
    const { data, error } = await db!.from("workspace_invites").insert(payload).select("*").single();
    if (error) throw error;
    await pushActivity(workspaceId, inviterEmail, "invite_created", data.id, { email, role });
    return { ...mapInvite(data), token: rawToken };
  }

  const inv: Invite = {
    id: id("inv"),
    workspaceId,
    email: email.toLowerCase(),
    role,
    tokenHash,
    token: rawToken,
    expiresAt,
    acceptedAt: null,
  };
  mem.invites.push(inv);
  await pushActivity(workspaceId, inviterEmail, "invite_created", inv.id, { email, role });
  return inv;
};

export const acceptInvite = async (workspaceId: string, token: string, actorEmail: string): Promise<WorkspaceMember> => {
  const tokenHash = hashToken(String(token || ""));
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspace_invites")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Invalid invite token");
    const invite = mapInvite(data);
    if (invite.acceptedAt) throw new Error("Invite already accepted");
    if (new Date(invite.expiresAt).getTime() < Date.now()) throw new Error("Invite expired");
    if (invite.email.toLowerCase() !== actorEmail.toLowerCase()) throw new Error("Invite email mismatch");

    const existing = await getMembership(workspaceId, actorEmail);
    if (existing) return existing;

    await db!.from("workspace_invites").update({ accepted_at: nowIso() }).eq("id", invite.id);
    const { data: memberData, error: memberError } = await db!
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: actorEmail,
        email: actorEmail.toLowerCase(),
        role: invite.role,
        invited_by: "invite_flow",
      })
      .select("*")
      .single();
    if (memberError) throw memberError;
    await pushActivity(workspaceId, actorEmail, "invite_accepted", invite.id, { role: invite.role });
    return mapMember(memberData);
  }

  const inv = mem.invites.find((i) => i.workspaceId === workspaceId && i.tokenHash === tokenHash);
  if (!inv) throw new Error("Invalid invite token");
  if (inv.acceptedAt) throw new Error("Invite already accepted");
  if (new Date(inv.expiresAt).getTime() < Date.now()) throw new Error("Invite expired");
  if (inv.email.toLowerCase() !== actorEmail.toLowerCase()) throw new Error("Invite email mismatch");
  const existing = mem.members.find((m) => m.workspaceId === workspaceId && m.email.toLowerCase() === actorEmail.toLowerCase());
  if (existing) return existing;
  inv.acceptedAt = nowIso();
  const member: WorkspaceMember = {
    id: id("m"),
    workspaceId,
    userId: actorEmail,
    email: actorEmail.toLowerCase(),
    role: inv.role,
    invitedBy: "invite_flow",
    joinedAt: nowIso(),
  };
  mem.members.push(member);
  await pushActivity(workspaceId, actorEmail, "invite_accepted", inv.id, { role: inv.role });
  return member;
};

export const addMemberDirect = async (
  workspaceId: string,
  actorEmail: string,
  email: string,
  role: WorkspaceRole
): Promise<WorkspaceMember> => {
  const existing = await getMembership(workspaceId, email);
  if (existing) return existing;

  if (usingSupabase()) {
    const { data, error } = await db!
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: email.toLowerCase(),
        email: email.toLowerCase(),
        role,
        invited_by: actorEmail,
      })
      .select("*")
      .single();
    if (error) throw error;
    await pushActivity(workspaceId, actorEmail, "member_added", data.id, { email, role });
    return mapMember(data);
  }

  const member: WorkspaceMember = {
    id: id("m"),
    workspaceId,
    userId: email.toLowerCase(),
    email: email.toLowerCase(),
    role,
    invitedBy: actorEmail,
    joinedAt: nowIso(),
  };
  mem.members.push(member);
  await pushActivity(workspaceId, actorEmail, "member_added", member.id, { email, role });
  return member;
};

export const updateMemberRole = async (
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  actorEmail: string
): Promise<WorkspaceMember> => {
  if (usingSupabase()) {
    const existing = await getMembership(workspaceId, userId);
    if (!existing) throw new Error("Member not found");
    const { data, error } = await db!
      .from("workspace_members")
      .update({ role })
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId.toLowerCase())
      .select("*")
      .single();
    if (error) throw error;
    await pushActivity(workspaceId, actorEmail, "member_role_changed", data.id, { userId, from: existing.role, to: role });
    return mapMember(data);
  }

  const member = mem.members.find((m) => m.workspaceId === workspaceId && m.userId === userId.toLowerCase());
  if (!member) throw new Error("Member not found");
  const from = member.role;
  member.role = role;
  await pushActivity(workspaceId, actorEmail, "member_role_changed", member.id, { userId, from, to: role });
  return member;
};

export const addFindingComment = async (
  workspaceId: string,
  findingId: string,
  actorEmail: string,
  text: string
): Promise<FindingComment> => {
  const mentions = extractMentions(text);
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("finding_comments")
      .insert({
        workspace_id: workspaceId,
        finding_id: findingId,
        author_id: actorEmail,
        author_email: actorEmail,
        text,
        mentions,
      })
      .select("*")
      .single();
    if (error) throw error;
    const comment = mapComment(data);
    await pushActivity(workspaceId, actorEmail, "comment_added", comment.id, { findingId, mentionCount: mentions.length });
    await publishEvent(workspaceId, "comment_added", comment.id, { findingId });
    for (const email of mentions) {
      await pushNotification({
        workspaceId,
        userEmail: email,
        type: "mention",
        title: `${actorEmail} mentioned you in a finding`,
        entityId: findingId,
      });
    }
    return comment;
  }

  const c: FindingComment = {
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
  mem.comments.push(c);
  await pushActivity(workspaceId, actorEmail, "comment_added", c.id, { findingId, mentionCount: mentions.length });
  await publishEvent(workspaceId, "comment_added", c.id, { findingId });
  for (const email of mentions) {
    await pushNotification({
      workspaceId,
      userEmail: email,
      type: "mention",
      title: `${actorEmail} mentioned you in a finding`,
      entityId: findingId,
    });
  }
  return c;
};

export const listFindingComments = async (workspaceId: string, findingId: string): Promise<FindingComment[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("finding_comments")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("finding_id", findingId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(mapComment);
  }
  return mem.comments.filter((c) => c.workspaceId === workspaceId && c.findingId === findingId);
};

export const updateFindingStatus = async (
  workspaceId: string,
  findingId: string,
  next: FindingReviewStatus,
  actorEmail: string,
  expectedVersion?: number
): Promise<{ status: FindingReviewStatus; version: number; historyItem: FindingStatusHistoryItem }> => {
  const history = (await listStatusesForWorkspace(workspaceId)).filter((s) => s.findingId === findingId);
  const current = history[history.length - 1]?.to || "open";
  if (typeof expectedVersion === "number" && expectedVersion !== history.length) {
    throw new Error("Version conflict: finding status changed by another user.");
  }

  if (usingSupabase()) {
    const { data, error } = await db!
      .from("finding_status_history")
      .insert({
        workspace_id: workspaceId,
        finding_id: findingId,
        from_status: current,
        to_status: next,
        changed_by: actorEmail,
        changed_by_email: actorEmail,
      })
      .select("*")
      .single();
    if (error) throw error;
    const item = mapStatus(data);
    await pushActivity(workspaceId, actorEmail, "finding_status_changed", item.id, { findingId, from: current, to: next });
    await publishEvent(workspaceId, "status_changed", item.id, { findingId, to: next });
    return { status: next, version: history.length + 1, historyItem: item };
  }

  const item: FindingStatusHistoryItem = {
    id: id("s"),
    findingId,
    workspaceId,
    from: current,
    to: next,
    changedBy: actorEmail,
    changedByEmail: actorEmail,
    changedAt: nowIso(),
  };
  mem.statuses.push(item);
  mem.latestStatusByFinding[findingId] = next;
  await pushActivity(workspaceId, actorEmail, "finding_status_changed", item.id, { findingId, from: current, to: next });
  await publishEvent(workspaceId, "status_changed", item.id, { findingId, to: next });
  return { status: next, version: history.length + 1, historyItem: item };
};

export const listStatusesForWorkspace = async (workspaceId: string): Promise<FindingStatusHistoryItem[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("finding_status_history")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("changed_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(mapStatus);
  }
  return mem.statuses.filter((s) => s.workspaceId === workspaceId);
};

export const listActivity = async (workspaceId: string): Promise<ActivityEvent[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("activity_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapActivity);
  }
  return mem.activity.filter((a) => a.workspaceId === workspaceId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

export const listEvents = async (workspaceId: string, since?: string): Promise<CollabEvent[]> => {
  if (usingSupabase()) {
    let query = db!.from("collaboration_events").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true });
    if (since) query = query.gt("created_at", since);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(mapEvent);
  }
  const sinceMs = since ? new Date(since).getTime() : 0;
  return mem.events.filter((e) => e.workspaceId === workspaceId && new Date(e.createdAt).getTime() > sinceMs);
};

export const publishEvent = async (
  workspaceId: string,
  type: CollabEvent["type"],
  entityId: string,
  payload?: Record<string, any>
): Promise<void> => {
  if (usingSupabase()) {
    const { error } = await db!.from("collaboration_events").insert({
      workspace_id: workspaceId,
      type,
      entity_id: entityId,
      payload: payload || {},
    });
    if (error) throw error;
    return;
  }
  mem.events.push({ id: id("evt"), workspaceId, type, entityId, createdAt: nowIso(), payload });
  if (mem.events.length > 2000) mem.events.splice(0, mem.events.length - 2000);
};

export const pushActivity = async (
  workspaceId: string,
  actorEmail: string,
  type: string,
  entityId: string,
  metadata?: Record<string, any>
): Promise<ActivityEvent> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("activity_events")
      .insert({
        workspace_id: workspaceId,
        actor_id: actorEmail,
        actor_email: actorEmail,
        type,
        entity_id: entityId,
        metadata: metadata || {},
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapActivity(data);
  }

  const ev: ActivityEvent = {
    id: id("act"),
    workspaceId,
    actorId: actorEmail,
    actorEmail,
    type,
    entityId,
    metadata,
    createdAt: nowIso(),
  };
  mem.activity.push(ev);
  return ev;
};

export const pushNotification = async (input: Omit<NotificationItem, "id" | "createdAt" | "read">): Promise<NotificationItem> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("notifications")
      .insert({
        workspace_id: input.workspaceId,
        user_email: input.userEmail.toLowerCase(),
        type: input.type,
        title: input.title,
        entity_id: input.entityId || null,
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapNotification(data);
  }

  const n: NotificationItem = { id: id("n"), createdAt: nowIso(), read: false, ...input };
  mem.notifications.push(n);
  return n;
};

export const listNotifications = async (workspaceId: string, userEmail: string): Promise<NotificationItem[]> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("notifications")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("user_email", userEmail.toLowerCase())
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapNotification);
  }
  return mem.notifications.filter((n) => n.workspaceId === workspaceId && n.userEmail.toLowerCase() === userEmail.toLowerCase());
};

export const markNotificationRead = async (
  workspaceId: string,
  notificationId: string,
  userEmail: string
): Promise<NotificationItem | undefined> => {
  if (usingSupabase()) {
    const { data, error } = await db!
      .from("notifications")
      .update({ read: true })
      .eq("id", notificationId)
      .eq("workspace_id", workspaceId)
      .eq("user_email", userEmail.toLowerCase())
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapNotification(data) : undefined;
  }
  const n = mem.notifications.find(
    (x) =>
      x.id === notificationId &&
      x.workspaceId === workspaceId &&
      x.userEmail.toLowerCase() === userEmail.toLowerCase()
  );
  if (n) n.read = true;
  return n;
};
