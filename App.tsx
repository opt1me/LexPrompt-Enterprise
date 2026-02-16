
import React, { useState, useEffect, useRef } from 'react';
import { ActivityEvent, NotificationItem, Template, DocumentFile, AnalysisResult, ProviderKeys, ResidencySettings, Workspace, WorkspaceMember, WorkspaceRole, FindingReviewStatus, ReviewDeepLinkState, ReviewSessionSummary, ReviewSessionDetail } from './types';
import { generateTemplate, analyzeContract, draftEmail, suggestRevision, chatWithDoc, AVAILABLE_MODELS, getProviderForModel } from './services/aiService';
import { parseFileContent } from './services/docService';
import { appendAuditEvent, createAuditEvent, getRegionLabel, isModelApprovedForRegion, loadResidencySettings, resolveActiveRegion, saveResidencySettings } from './services/residencyService';
import { ResultsView } from './components/ResultsView';
import { CreateTemplateModal, MegaPromptModal, ModifyTemplateModal, RevisionModal, ConfirmationModal, ProviderSettingsModal } from './components/Modals';
import { TemplateEditor } from './components/TemplateEditor';
import { TabularReview } from './components/TabularReview';
import { FileText, Plus, Upload, Play, Loader, LogOut, Layout, Check, AlertCircle, Coins, Zap, ShieldCheck, Settings2, Sliders, Share2, Users, Trash2, RefreshCw, Clock3, Link as LinkIcon, History } from 'lucide-react';
import { addFindingComment, createInvite, createReviewSession, createWorkspace, deleteReviewSession, getActivity, getFindingComments, getFindingStatus, getNotifications, getReviewSession, listMembers, listReviewSessions, listWorkspaces, markNotificationRead, pollWorkspaceEvents, publishWorkspaceEvent, updateFindingStatus, updateMemberRole } from './services/collabService';
import { MembersModal, NotificationsPanel, ShareProjectModal, WorkspaceSwitcher } from './components/CollabPanels';
import { getCurrentAuthUser, isDemoAuthEnabled, isSupabaseAuthEnabled, onAuthStateChanged, sendMagicLink, signOutAuth } from './services/authService';

const mockUser = { uid: 'demo-user', email: 'demo@lexprompt.ai', role: 'admin' };
const STORAGE_KEY = 'lexprompt_templates_v3';
const KEYS_STORAGE_KEY = 'lexprompt_api_keys';

const loadTemplates = (): Template[] => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) { console.error(e); }
    return [
        {
            id: 'demo-1',
            name: 'Enterprise SaaS MSA',
            contractType: 'SaaS',
            mode: 'risk',
            systemPrompt: 'Senior Legal Counsel with 20+ years experience reviewing enterprise contracts.',
            formatPrompt: 'Extract liability, indemnity, and data protection terms.',
            riskTolerance: 'Low - we avoid uncapped liability.',
            clauses: [
                { id: '1', title: 'Indemnity', prompt: 'Review third-party IP indemnity obligations.' },
                { id: '2', title: 'Liability Cap', prompt: 'Is there an aggregate liability cap? If so, what is the amount?' }
            ],
            createdAt: new Date().toISOString(),
            scope: 'private'
        }
    ];
};

const getModelCost = (model: string): number => {
    if (model.includes('gpt-5') && !model.includes('nano') && !model.includes('mini')) return 50;
    if (model.includes('pro') || model.includes('sonnet') || model.includes('gpt-5-mini')) return 30;
    return 15;
};

export const COSTS = {
    TEMPLATE_GEN: 25,
    CHAT: 1,
    REVISION: 5,
    EMAIL: 2
};

type KeyPolicyMode = "platform" | "byok" | "hybrid";

const getKeyPolicy = (): KeyPolicyMode => {
  const raw = String((import.meta as any).env?.VITE_KEY_POLICY ?? "hybrid").toLowerCase().trim();
  if (raw === "platform" || raw === "byok" || raw === "hybrid") return raw;
  return "hybrid";
};

const providerLabel = (provider: string): string => {
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google Gemini";
  if (provider === "anthropic") return "Anthropic";
  return provider;
};

type ClauseProgressItem = {
  status: 'queued' | 'running' | 'done' | 'error';
  detail?: string;
};

const formatFileSize = (sizeBytes?: number): string => {
  if (sizeBytes === undefined) return "-";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const parseDeepLinkState = (): ReviewDeepLinkState => {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const workspaceId = params.get("workspaceId") || undefined;
  const reviewId = params.get("reviewId") || undefined;
  const viewRaw = params.get("view") || undefined;
  const view = viewRaw && ["dashboard", "editor", "processor", "results", "tabular"].includes(viewRaw)
    ? (viewRaw as ReviewDeepLinkState["view"])
    : undefined;
  return { workspaceId, reviewId, view };
};

const updateDeepLinkState = (next: ReviewDeepLinkState) => {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (next.workspaceId) params.set("workspaceId", next.workspaceId);
  else params.delete("workspaceId");
  if (next.reviewId) params.set("reviewId", next.reviewId);
  else params.delete("reviewId");
  if (next.view) params.set("view", next.view);
  else params.delete("view");
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  window.history.replaceState({}, "", url);
};

const fileToDataUrl = async (file: File): Promise<string> =>
  await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to encode file"));
    reader.readAsDataURL(file);
  });

const dataUrlToFile = (dataUrl: string, fileName: string, fallbackMimeType: string): File => {
  const [meta, payload] = dataUrl.split(",");
  if (!meta || !payload) return new File([], fileName, { type: fallbackMimeType });
  const mimeMatch = meta.match(/^data:(.*?);base64$/i);
  const mimeType = mimeMatch?.[1] || fallbackMimeType;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mimeType });
};

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
  }
}

export default function App() {
  const keyPolicy = getKeyPolicy();
  const [authEnabled] = useState<boolean>(isSupabaseAuthEnabled());
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authChecking, setAuthChecking] = useState(true);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authMagicLinkSent, setAuthMagicLinkSent] = useState(false);
  const [credits, setCredits] = useState(500);
  const [view, setView] = useState<'dashboard' | 'editor' | 'processor' | 'results' | 'tabular'>('dashboard');
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS.GPT_5_MINI);
  
  const [templates, setTemplates] = useState<Template[]>(loadTemplates());
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [reviewHistory, setReviewHistory] = useState<ReviewSessionSummary[]>([]);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [pendingDeepLink, setPendingDeepLink] = useState<ReviewDeepLinkState>(() => parseDeepLinkState());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisClauseProgress, setAnalysisClauseProgress] = useState<Record<string, ClauseProgressItem>>({});
  const [replaceTargetDocId, setReplaceTargetDocId] = useState<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  
  const [apiKeys, setApiKeys] = useState<ProviderKeys>(() => {
      const saved = localStorage.getItem(KEYS_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
  });
  const [residencySettings, setResidencySettings] = useState<ResidencySettings>(loadResidencySettings());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findingComments, setFindingComments] = useState<Record<string, any[]>>({});
  const [findingStatuses, setFindingStatuses] = useState<Record<string, { status: FindingReviewStatus; version: number }>>({});
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [modifyModalOpen, setModifyModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revisionData, setRevisionData] = useState<{title: string, original: string, revised: string} | null>(null);

  useEffect(() => {
    const checkKey = async () => {
      try {
        const selected = await window.aistudio?.hasSelectedApiKey();
        setHasKey(!!selected || !!apiKeys.google || !!apiKeys.openai || !!apiKeys.anthropic);
      } catch {
        setHasKey(false);
      }
    };
    checkKey();
  }, [apiKeys]);

  useEffect(() => {
    const onPopState = () => setPendingDeepLink(parseDeepLinkState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let unsub = () => {};
    const bootstrapAuth = async () => {
      try {
        if (authEnabled) {
          const current = await getCurrentAuthUser();
          setUser(current);
          unsub = onAuthStateChanged((next) => {
            setUser(next);
            if (next) setAuthMagicLinkSent(false);
          });
        } else if (isDemoAuthEnabled()) {
          const u = sessionStorage.getItem("lexprompt_user");
          if (u) setUser(JSON.parse(u));
        }
      } finally {
        setAuthChecking(false);
      }
    };
    bootstrapAuth();
    return () => {
      unsub();
    };
  }, [authEnabled]);

  useEffect(() => {
    if (!user?.email) return;
    const loadWorkspaceContext = async () => {
      try {
        let ws = await listWorkspaces(user.email);
        if (ws.length === 0) {
          const created = await createWorkspace(user.email, "Default Workspace");
          ws = [created];
        }
        setWorkspaces(ws);
        const hasWorkspace = (id: string | null | undefined) => !!id && ws.some((w) => w.id === id);
        const deepLinkedWorkspace = hasWorkspace(pendingDeepLink.workspaceId) ? pendingDeepLink.workspaceId : null;
        const active = hasWorkspace(activeWorkspaceId) ? activeWorkspaceId : deepLinkedWorkspace || ws[0]?.id || null;
        setActiveWorkspaceId(active);
        if (active) {
          const [m, a, n, reviews] = await Promise.all([
            listMembers(user.email, active),
            getActivity(user.email, active),
            getNotifications(user.email, active),
            listReviewSessions(user.email, active),
          ]);
          setMembers(m);
          setActivity(a);
          setNotifications(n);
          setReviewHistory(reviews);
        }
      } catch (e: any) {
        showNotify(e.message || "Failed to load workspaces", "error");
      }
    };
    loadWorkspaceContext();
  }, [user?.email, activeWorkspaceId, pendingDeepLink.workspaceId]);

  useEffect(() => {
    if (!user?.email || !activeWorkspaceId) return;
    const t = setInterval(async () => {
      try {
        const events = await pollWorkspaceEvents(user.email, activeWorkspaceId, eventsCursor || undefined);
        if (events.length > 0) {
          const latest = events[events.length - 1]?.createdAt;
          if (latest) setEventsCursor(latest);
          const [a, n] = await Promise.all([getActivity(user.email, activeWorkspaceId), getNotifications(user.email, activeWorkspaceId)]);
          setActivity(a);
          setNotifications(n);
        }
      } catch {
        // Ignore polling errors to keep UI responsive.
      }
    }, 1200);
    return () => clearInterval(t);
  }, [user?.email, activeWorkspaceId, eventsCursor]);

  const saveKeys = (newKeys: ProviderKeys) => {
      setApiKeys(newKeys);
      localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(newKeys));
      showNotify("Keys updated successfully");
  };

  const saveResidency = (next: ResidencySettings) => {
      setResidencySettings(next);
      saveResidencySettings(next);
      showNotify(`Residency updated: ${getRegionLabel(resolveActiveRegion(next))}`);
  };

  const showNotify = (msg: string, type: 'success' | 'error' = 'success') => {
      setNotification({ msg, type });
      setTimeout(() => setNotification(null), 3000);
  };

  const handleCreateTemplate = async (params: any) => {
    if (params.type === 'ai' && credits < COSTS.TEMPLATE_GEN) return showNotify("Insufficient credits", 'error');
    setLoading(true);
    try {
      let newT: Partial<Template>;
      if (params.type === 'manual') {
          newT = { name: params.templateName, contractType: 'Custom', mode: 'extraction', systemPrompt: "Expert counsel.", formatPrompt: "Extract accurately.", clauses: [], scope: 'private' };
      } else {
          newT = await generateTemplate(
            params.contractType,
            params.templateDetail,
            params.outputDetail,
            params.context,
            {
              region: resolveActiveRegion(residencySettings),
              residencyMode: residencySettings.residencyMode,
              noTraining: residencySettings.noTraining,
              minRetention: residencySettings.minRetention,
              policyVersion: residencySettings.policyVersion
            },
            selectedModel
          );
          setCredits(prev => prev - COSTS.TEMPLATE_GEN);
      }
      const finalT: Template = { ...newT as Template, id: Math.random().toString(36).substr(2, 9), name: params.templateName || params.contractType, createdAt: new Date().toISOString() };
      const updated = [...templates, finalT];
      setTemplates(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setActiveTemplate(finalT);
      setCreateModalOpen(false);
      setView('editor');
    } catch (e: any) { showNotify(e.message || "Failed to create template", 'error'); }
    setLoading(false);
  };

  const handleAnalysis = async () => {
    if (!activeTemplate || documents.length === 0) return;
    const activeRegion = resolveActiveRegion(residencySettings);
    if (!isModelApprovedForRegion(selectedModel, activeRegion)) {
      return showNotify(`Model is not approved for ${getRegionLabel(activeRegion)}`, 'error');
    }
    const selectedProvider = getProviderForModel(selectedModel);
    if (keyPolicy === "byok") {
      const userKey = String((apiKeys as any)?.[selectedProvider] || "").trim();
      if (!userKey) {
        setSettingsOpen(true);
        return showNotify(
          `BYOK mode is enabled. Add your ${providerLabel(selectedProvider)} API key in Engine Settings.`,
          "error"
        );
      }
    }

    const perDocCost = getModelCost(selectedModel);
    const cost = documents.length * perDocCost;
    
    if (credits < cost) return showNotify("Insufficient credits", 'error');
    const initialProgress = activeTemplate.clauses.reduce<Record<string, ClauseProgressItem>>((acc, clause) => {
      acc[clause.title] = { status: 'queued', detail: 'Queued' };
      return acc;
    }, {});
    setAnalysisClauseProgress(initialProgress);
    setAnalysisRunning(true);
    setLoading(true);
    const provider = getProviderForModel(selectedModel);
    const startedAudit = createAuditEvent('analysis_started', {
      provider,
      model: selectedModel,
      region: activeRegion,
      policyVersion: residencySettings.policyVersion,
      residencyMode: residencySettings.residencyMode,
      metadata: {
        docs: documents.length,
        mode: activeTemplate.mode
      }
    });
    appendAuditEvent(startedAudit);
    try {
      const { data, meta } = await analyzeContract(activeTemplate, documents, selectedModel, {
        region: activeRegion,
        residencyMode: residencySettings.residencyMode,
        noTraining: residencySettings.noTraining,
        minRetention: residencySettings.minRetention,
        policyVersion: residencySettings.policyVersion
      }, false, (clauseTitle, status, detail) => {
        setAnalysisClauseProgress(prev => ({
          ...prev,
          [clauseTitle]: { status, detail }
        }));
      });
      setCredits(prev => prev - cost);

      let persistedReviewId: string | null = null;
      if (activeWorkspaceId && user?.email) {
        try {
          const reviewDocs = await Promise.all(
            documents.map(async (doc) => ({
              id: doc.id,
              name: doc.name,
              mimeType: doc.fileObj.type || (doc.type === "pdf" ? "application/pdf" : doc.type === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"),
              docType: doc.type,
              sizeBytes: doc.sizeBytes || doc.fileObj.size,
              pageCount: doc.pageCount,
              charCount: doc.charCount || doc.content.length,
              storagePath: doc.storagePath,
              sourceUrl: doc.sourceUrl,
              sourceDataUrl: await fileToDataUrl(doc.fileObj),
              contentText: doc.content,
            }))
          );

          const persisted = await createReviewSession(user.email, activeWorkspaceId, {
            title: `${activeTemplate.name} Review`,
            templateSnapshot: activeTemplate,
            findings: data,
            docOrder: reviewDocs.map((d) => d.id || ""),
            provider: meta.provider,
            model: meta.model,
            region: meta.region,
            policyVersion: meta.policyVersion,
            status: "complete",
            documents: reviewDocs,
          });
          persistedReviewId = persisted.id;
          setReviewHistory(await listReviewSessions(user.email, activeWorkspaceId));
        } catch (persistErr: any) {
          showNotify(`Review saved locally only: ${persistErr.message || "persistence failed"}`, "error");
        }
      }
      setActiveReviewId(persistedReviewId);

      const newResult: AnalysisResult = {
        id: persistedReviewId || Math.random().toString(),
        title: "Contract Analysis",
        data,
        docIndices: documents.map((_, i) => i),
        timestamp: new Date(),
        modelUsed: meta.model,
        providerUsed: meta.provider,
        regionUsed: meta.region,
        policyVersion: meta.policyVersion,
        auditId: startedAudit.id,
        workspaceId: activeWorkspaceId || undefined
      };
      setResults([newResult]);
      if (activeWorkspaceId && user?.email) {
        await publishWorkspaceEvent(user.email, activeWorkspaceId, "analysis_completed", newResult.id, {
          findings: Object.keys(data).length,
          model: selectedModel
        });
      }
      appendAuditEvent(createAuditEvent('analysis_completed', {
        provider: meta.provider,
        model: meta.model,
        region: meta.region,
        policyVersion: meta.policyVersion,
        residencyMode: residencySettings.residencyMode,
        metadata: {
          findings: Object.keys(data).length
        }
      }));
      setView('results');
      if (activeWorkspaceId) {
        updateDeepLinkState({
          workspaceId: activeWorkspaceId,
          reviewId: persistedReviewId || undefined,
          view: "results",
        });
      }
      showNotify(`Analysis Complete: ${meta.model} (${getRegionLabel(meta.region)})`);
    } catch (e: any) {
      appendAuditEvent(createAuditEvent('analysis_failed', {
        provider,
        model: selectedModel,
        region: activeRegion,
        policyVersion: residencySettings.policyVersion,
        residencyMode: residencySettings.residencyMode,
        metadata: {
          error: e.message || "analysis_failed"
        }
      }));
      showNotify(e.message || "Analysis failed", 'error');
    }
    setAnalysisRunning(false);
    setLoading(false);
  };

  const parseUploadedFiles = async (files: FileList | File[]): Promise<DocumentFile[]> => {
    const parsed: DocumentFile[] = [];
    for (const file of Array.from(files)) {
      parsed.push(await parseFileContent(file as File));
    }
    return parsed;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    if (analysisRunning) {
      showNotify("Cannot edit uploads while analysis is running", "error");
      return;
    }

    setLoading(true);
    try {
      const files = await parseUploadedFiles(e.target.files);
      setDocuments(prev => [...prev, ...files]);
      showNotify(`${files.length} document(s) uploaded`);
    } catch (e: any) {
      showNotify(e.message || "Failed to upload documents", "error");
    } finally {
      e.target.value = "";
      setLoading(false);
    }
  };

  const handleRemoveDocument = (docId: string) => {
    if (analysisRunning) return;
    setDocuments(prev => prev.filter((doc) => doc.id !== docId));
  };

  const handleClearDocuments = () => {
    if (analysisRunning) return;
    setDocuments([]);
  };

  const handleRequestReplace = (docId: string) => {
    if (analysisRunning) return;
    setReplaceTargetDocId(docId);
    replaceInputRef.current?.click();
  };

  const handleReplaceDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !replaceTargetDocId) return;

    setLoading(true);
    try {
      const parsed = await parseFileContent(file);
      setDocuments((prev) => {
        const idx = prev.findIndex((doc) => doc.id === replaceTargetDocId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...parsed, id: prev[idx].id };
        return next;
      });
      showNotify(`Replaced with ${file.name}`);
    } catch (err: any) {
      showNotify(err.message || "Failed to replace document", "error");
    } finally {
      setReplaceTargetDocId(null);
      e.target.value = "";
      setLoading(false);
    }
  };

  const handleInvite = async (email: string, role: WorkspaceRole) => {
    if (!activeWorkspaceId || !user?.email) return;
    const data = await createInvite(user.email, activeWorkspaceId, email, role);
    showNotify(`Invite created for ${email}`);
    setShareOpen(false);
    await Promise.all([
      listMembers(user.email, activeWorkspaceId).then(setMembers),
      getActivity(user.email, activeWorkspaceId).then(setActivity),
      getNotifications(user.email, activeWorkspaceId).then(setNotifications)
    ]);
    if (data.inviteLink) {
      navigator.clipboard.writeText(data.inviteLink);
      showNotify(`Invite link copied for ${email}`);
    }
  };

  const handleMemberRoleUpdate = async (memberUserId: string, role: WorkspaceRole) => {
    if (!activeWorkspaceId || !user?.email) return;
    await updateMemberRole(user.email, activeWorkspaceId, memberUserId, role);
    setMembers(await listMembers(user.email, activeWorkspaceId));
    setActivity(await getActivity(user.email, activeWorkspaceId));
  };

  const withFindingId = (resultId: string, clauseKey: string) => `${resultId}:${clauseKey}`;

  const handleAddFindingComment = async (resultId: string, clauseKey: string, text: string) => {
    if (!activeWorkspaceId || !user?.email) return [];
    const findingId = withFindingId(resultId, clauseKey);
    const comments = await addFindingComment(user.email, activeWorkspaceId, findingId, text);
    setFindingComments(prev => ({ ...prev, [findingId]: comments }));
    return comments;
  };

  const handleGetFindingComments = async (resultId: string, clauseKey: string) => {
    if (!activeWorkspaceId || !user?.email) return [];
    const findingId = withFindingId(resultId, clauseKey);
    const comments = await getFindingComments(user.email, activeWorkspaceId, findingId);
    setFindingComments(prev => ({ ...prev, [findingId]: comments }));
    return comments;
  };

  const handleUpdateFindingStatus = async (resultId: string, clauseKey: string, status: FindingReviewStatus) => {
    if (!activeWorkspaceId || !user?.email) return;
    const findingId = withFindingId(resultId, clauseKey);
    const existing = findingStatuses[findingId];
    const updated = await updateFindingStatus(user.email, activeWorkspaceId, findingId, status, existing?.version);
    setFindingStatuses(prev => ({ ...prev, [findingId]: { status: updated.status, version: updated.version } }));
  };

  const handleHydrateFindingStatus = async (resultId: string, clauseKey: string) => {
    if (!activeWorkspaceId || !user?.email) return;
    const findingId = withFindingId(resultId, clauseKey);
    const data = await getFindingStatus(user.email, activeWorkspaceId, findingId);
    setFindingStatuses(prev => ({ ...prev, [findingId]: { status: data.current || "open", version: data.version || 0 } }));
  };

  const getReviewPermalink = (workspaceId: string, reviewId: string): string => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams();
    params.set("workspaceId", workspaceId);
    params.set("reviewId", reviewId);
    params.set("view", "results");
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  };

  const toDocumentFileFromReviewRef = async (
    doc: ReviewSessionDetail["documents"][number]
  ): Promise<{ document: DocumentFile; sourceMissing: boolean }> => {
    const mimeType =
      doc.mimeType ||
      (doc.docType === "pdf"
        ? "application/pdf"
        : doc.docType === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/plain");
    let fileObj: File;
    let resolvedType: DocumentFile["type"] = doc.docType;
    let sourceMissing = false;
    if (doc.sourceDataUrl) {
      fileObj = dataUrlToFile(doc.sourceDataUrl, doc.name, mimeType);
    } else if (doc.sourceUrl) {
      try {
        const response = await fetch(doc.sourceUrl);
        if (!response.ok) throw new Error(`Unable to fetch source file for ${doc.name}`);
        const blob = await response.blob();
        fileObj = new File([blob], doc.name, { type: blob.type || mimeType });
      } catch {
        sourceMissing = true;
        resolvedType = "txt";
        fileObj = new File([doc.contentText || ""], doc.name, { type: "text/plain" });
      }
    } else {
      sourceMissing = true;
      resolvedType = "txt";
      fileObj = new File([doc.contentText || ""], doc.name, { type: "text/plain" });
    }

    return {
      sourceMissing,
      document: {
      id: doc.id,
      name: doc.name,
      content: doc.contentText || "",
      fileObj,
      type: resolvedType,
      sizeBytes: doc.sizeBytes,
      pageCount: doc.pageCount,
      charCount: doc.charCount || (doc.contentText || "").length,
      storagePath: doc.storagePath,
      sourceUrl: doc.sourceUrl,
      sourceDataUrl: doc.sourceDataUrl,
      },
    };
  };

  const openReviewSession = async (workspaceId: string, reviewId: string) => {
    if (!user?.email) return;
    setReviewLoading(true);
    setActiveReviewId(reviewId);
    try {
      const review = await getReviewSession(user.email, workspaceId, reviewId);
      const order = review.docOrder?.length ? review.docOrder : review.documents.map((d) => d.id);
      const orderedDocs = order
        .map((docId) => review.documents.find((doc) => doc.id === docId))
        .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));
      const fallbackDocs = orderedDocs.length > 0 ? orderedDocs : review.documents;
      const reconstructedPairs = await Promise.all(fallbackDocs.map((doc) => toDocumentFileFromReviewRef(doc)));
      const reconstructed = reconstructedPairs.map((pair) => pair.document);
      const missingSourceCount = reconstructedPairs.filter((pair) => pair.sourceMissing).length;
      if (missingSourceCount > 0) {
        showNotify(`${missingSourceCount} source document(s) unavailable; loaded findings with text fallback`, "error");
      }

      const loadedResult: AnalysisResult = {
        id: review.id,
        title: review.title || "Contract Analysis",
        data: review.findings || {},
        docIndices: reconstructed.map((_, idx) => idx),
        timestamp: new Date(review.createdAt),
        modelUsed: review.model,
        providerUsed: review.provider,
        regionUsed: review.region,
        policyVersion: review.policyVersion,
        workspaceId: review.workspaceId,
      };

      setActiveWorkspaceId(workspaceId);
      setDocuments(reconstructed);
      setResults([loadedResult]);
      setActiveReviewId(review.id);
      if (review.templateSnapshot?.name && review.templateSnapshot?.clauses) {
        setActiveTemplate(review.templateSnapshot as Template);
      }
      setView("results");
      updateDeepLinkState({ workspaceId, reviewId: review.id, view: "results" });
    } catch (e: any) {
      setActiveReviewId(null);
      showNotify(e.message || "Review not found or access denied", "error");
    } finally {
      setReviewLoading(false);
    }
  };

  const handleCopyReviewLink = async () => {
    if (!activeWorkspaceId || !activeReviewId) {
      showNotify("No persisted review link available yet", "error");
      return;
    }
    const url = getReviewPermalink(activeWorkspaceId, activeReviewId);
    try {
      await navigator.clipboard.writeText(url);
      showNotify("Review link copied");
    } catch {
      showNotify("Unable to copy link to clipboard", "error");
    }
  };

  const handleDeleteReview = async (reviewId: string) => {
    if (!activeWorkspaceId || !user?.email) return;
    try {
      await deleteReviewSession(user.email, activeWorkspaceId, reviewId);
      const next = await listReviewSessions(user.email, activeWorkspaceId);
      setReviewHistory(next);
      if (activeReviewId === reviewId) {
        setActiveReviewId(null);
        setResults([]);
        setDocuments([]);
        setView("dashboard");
        updateDeepLinkState({ workspaceId: activeWorkspaceId, reviewId: undefined, view: "dashboard" });
      }
      showNotify("Review deleted");
    } catch (e: any) {
      showNotify(e.message || "Failed to delete review", "error");
    }
  };

  const handleMagicLinkSignIn = async () => {
    const email = authEmail.trim().toLowerCase();
    if (!email) {
      showNotify("Enter your work email", "error");
      return;
    }
    setAuthSubmitting(true);
    try {
      await sendMagicLink(email);
      setAuthMagicLinkSent(true);
      showNotify(`Magic link sent to ${email}`);
    } catch (e: any) {
      showNotify(e.message || "Failed to send magic link", "error");
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleDemoLogin = () => {
    sessionStorage.setItem('lexprompt_user', JSON.stringify(mockUser));
    setUser(mockUser);
  };

  const handleSignOut = async () => {
    try {
      if (authEnabled) {
        await signOutAuth();
      }
    } finally {
      sessionStorage.removeItem("lexprompt_user");
      setUser(null);
      setResults([]);
      setDocuments([]);
      setActiveReviewId(null);
      setView("dashboard");
      setAuthMagicLinkSent(false);
    }
  };

  useEffect(() => {
    if (!user?.email) return;
    const workspaceId = pendingDeepLink.workspaceId;
    const reviewId = pendingDeepLink.reviewId;
    if (!workspaceId || !reviewId) return;
    if (reviewLoading) return;
    openReviewSession(workspaceId, reviewId).finally(() => {
      setPendingDeepLink({});
    });
  }, [user?.email, pendingDeepLink.workspaceId, pendingDeepLink.reviewId, reviewLoading]);

  useEffect(() => {
    updateDeepLinkState({
      workspaceId: activeWorkspaceId || undefined,
      reviewId: view === "results" ? activeReviewId || undefined : undefined,
      view,
    });
  }, [activeWorkspaceId, activeReviewId, view]);

  const analysisCost = documents.length * getModelCost(selectedModel);
  const currentMemberRole = members.find((m) => m.email.toLowerCase() === (user?.email || "").toLowerCase())?.role;
  const canDeleteReviews = currentMemberRole === "owner" || currentMemberRole === "admin";
  const clauseProgressEntries = activeTemplate
    ? activeTemplate.clauses.map((clause) => ({
        title: clause.title,
        progress: analysisClauseProgress[clause.title] || { status: "queued" as const, detail: "Queued" },
      }))
    : [];
  const clauseTotal = clauseProgressEntries.length;
  const clauseDone = clauseProgressEntries.filter((entry) => entry.progress.status === "done" || entry.progress.status === "error").length;
  const clauseProgressPct = clauseTotal > 0 ? Math.round((clauseDone / clauseTotal) * 100) : 0;

  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="w-full max-w-md p-10 bg-[#111] rounded-[32px] border border-white/10 shadow-2xl text-center">
          <Loader className="w-6 h-6 text-violet-400 animate-spin mx-auto mb-4" />
          <p className="text-sm font-bold text-gray-300">Loading workspace session...</p>
        </div>
      </div>
    );
  }

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-black px-4">
      <div className="w-full max-w-lg p-10 bg-[#111] rounded-[32px] border border-white/10 shadow-2xl space-y-6">
        <h1 className="text-3xl font-black text-white flex items-center gap-3"><Layout className="text-violet-500 w-8 h-8"/> LexPrompt</h1>
        {authEnabled ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-widest font-black text-gray-500 mb-2">Work Email</label>
              <input
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleMagicLinkSignIn()}
                placeholder="name@company.com"
                className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-violet-500"
              />
            </div>
            <button
              onClick={handleMagicLinkSignIn}
              disabled={authSubmitting}
              className="w-full p-3 bg-violet-600 hover:bg-violet-500 rounded-xl text-white font-black transition-all disabled:opacity-50"
            >
              {authSubmitting ? "Sending..." : "Send Magic Link"}
            </button>
            {authMagicLinkSent && (
              <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                Link sent. Open your email and follow the sign-in link.
              </div>
            )}
            {isDemoAuthEnabled() && (
              <button onClick={handleDemoLogin} className="w-full p-3 bg-white/5 hover:bg-white/10 rounded-xl text-gray-200 font-bold transition-all">
                Use Local Demo Login
              </button>
            )}
          </div>
        ) : isDemoAuthEnabled() ? (
          <button onClick={handleDemoLogin} className="w-full p-4 bg-violet-600 hover:bg-violet-500 rounded-2xl text-white font-bold transition-all">Enterprise Login</button>
        ) : (
          <div className="text-sm text-red-200 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            Authentication is not configured. Set Supabase auth env vars or enable demo auth for local development.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      {notification && (
        <div className={`fixed bottom-8 right-8 px-6 py-3 rounded-2xl shadow-2xl z-[100] flex items-center gap-3 border ${notification.type === 'error' ? 'bg-red-900 border-red-500 text-red-100' : 'bg-violet-900 border-violet-500 text-violet-100'} backdrop-blur-xl animate-in fade-in slide-in-from-bottom-5`}>
            {notification.type === 'error' ? <AlertCircle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
            <span className="font-bold text-sm">{notification.msg}</span>
        </div>
      )}

      <header className="h-16 border-b border-white/10 bg-[#111]/80 backdrop-blur-md flex items-center justify-between px-6 shrink-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('dashboard')}>
          <div className="w-9 h-9 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-xl flex items-center justify-center text-white"><FileText className="w-5 h-5" /></div>
          <span className="font-black text-xl text-white tracking-tight">LexPrompt</span>
        </div>
        
        <div className="flex items-center gap-6">
          {user?.email && (
            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={(id) => {
                setActiveWorkspaceId(id);
                setActiveReviewId(null);
                if (view === "results") {
                  setResults([]);
                  setDocuments([]);
                  setView("dashboard");
                }
              }}
              onCreate={async (name) => {
                const ws = await createWorkspace(user.email, name);
                const all = [...workspaces, ws];
                setWorkspaces(all);
                setActiveWorkspaceId(ws.id);
              }}
            />
          )}
          <div className="hidden md:flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/5">
             <Settings2 className="w-4 h-4 text-gray-500" />
             <select 
                value={selectedModel} 
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-transparent text-[10px] font-black uppercase tracking-widest text-gray-300 outline-none cursor-pointer"
             >
                <optgroup label="Google Gemini" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.GEMINI_2_5_FLASH_LITE}>Gemini 2.5 Flash-Lite</option>
                    <option value={AVAILABLE_MODELS.GEMINI_2_5_FLASH}>Gemini 2.5 Flash</option>
                    <option value={AVAILABLE_MODELS.GEMINI_2_5_PRO}>Gemini 2.5 Pro</option>
                </optgroup>
                <optgroup label="Anthropic Claude" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.CLAUDE_HAIKU_4_5}>Claude Haiku 4.5</option>
                    <option value={AVAILABLE_MODELS.CLAUDE_SONNET_4_5}>Claude Sonnet 4.5</option>
                </optgroup>
                <optgroup label="OpenAI GPT" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.GPT_5_NANO}>GPT-5 Nano</option>
                    <option value={AVAILABLE_MODELS.GPT_5_MINI}>GPT-5 Mini</option>
                    <option value={AVAILABLE_MODELS.GPT_5}>GPT-5</option>
                </optgroup>
             </select>
          </div>
          <button onClick={() => setSettingsOpen(true)} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 text-gray-400 transition-colors" title="Engine Setup"><Sliders className="w-5 h-5"/></button>
          <button onClick={() => setShareOpen(true)} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 text-gray-400 transition-colors" title="Share Project"><Share2 className="w-5 h-5"/></button>
          <button onClick={() => setMembersOpen(true)} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 text-gray-400 transition-colors" title="Members"><Users className="w-5 h-5"/></button>
          <NotificationsPanel notifications={notifications} onMarkRead={async (id) => {
            if (!user?.email || !activeWorkspaceId) return;
            await markNotificationRead(user.email, id);
            setNotifications(await getNotifications(user.email, activeWorkspaceId));
          }} />
          <div className="hidden md:flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/5">
             <ShieldCheck className="w-4 h-4 text-emerald-500" />
             <span className="text-[10px] font-black uppercase tracking-wider text-emerald-300">{getRegionLabel(resolveActiveRegion(residencySettings))}</span>
          </div>
          <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/5">
             <Coins className="w-4 h-4 text-yellow-500" />
             <span className="text-sm font-bold text-white">{credits}</span>
          </div>
          <button onClick={handleSignOut} className="text-gray-400 hover:text-white"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      {keyPolicy !== "hybrid" && (
        <div
          className={`px-6 py-2 border-b text-xs font-bold flex items-center justify-between gap-3 ${
            keyPolicy === "platform"
              ? "bg-emerald-950/60 border-emerald-500/20 text-emerald-200"
              : "bg-amber-950/60 border-amber-500/20 text-amber-200"
          }`}
        >
          <span>
            {keyPolicy === "platform"
              ? "Platform-managed AI mode: users do not need to add personal API keys."
              : "BYOK mode: users must add their own API key in Engine Settings before analysis."}
          </span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 text-[11px] uppercase tracking-wider"
          >
            Open Settings
          </button>
        </div>
      )}

      <main className="flex-1 overflow-hidden">
        {view === 'dashboard' && (
          <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto">
            <div className="flex justify-between items-end mb-10">
              <h2 className="text-4xl font-black text-white">Playbooks</h2>
              <button onClick={() => setCreateModalOpen(true)} className="px-6 py-3 bg-violet-600 text-white rounded-2xl flex items-center gap-2 text-sm font-bold"><Plus className="w-5 h-5" /> New Playbook</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {templates.map(t => (
                <div key={t.id} className="bg-[#111] border border-white/10 p-6 rounded-[24px] flex flex-col h-64 hover:border-violet-500/50 transition-all">
                   <h3 className="text-lg font-bold text-white mb-2">{t.name}</h3>
                   <p className="text-xs text-gray-500 mb-6 line-clamp-2">{t.systemPrompt}</p>
                   <div className="mt-auto flex gap-2">
                      <button onClick={() => { setActiveTemplate(t); setView('editor'); }} className="flex-1 py-2 bg-white/5 text-gray-400 rounded-xl text-xs font-bold">Edit</button>
                      <button onClick={() => { setActiveTemplate(t); setView('processor'); }} className="flex-1 py-2 bg-violet-600 text-white rounded-xl text-xs font-bold"><Play className="w-3 h-3 inline mr-1"/> Run</button>
                   </div>
                </div>
              ))}
            </div>

            <div className="mt-10 bg-[#111] border border-white/10 rounded-[24px] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-violet-300" />
                  <h3 className="text-sm font-black text-white uppercase tracking-wider">Review History</h3>
                </div>
                {activeWorkspaceId && (
                  <span className="text-[10px] text-gray-500 uppercase tracking-widest font-black">
                    {reviewHistory.length} saved review(s)
                  </span>
                )}
              </div>
              <div className="p-4">
                {!activeWorkspaceId ? (
                  <div className="text-sm text-gray-500">Select a workspace to view saved reviews.</div>
                ) : reviewHistory.length === 0 ? (
                  <div className="text-sm text-gray-500">No saved review sessions yet. Run an analysis to create one.</div>
                ) : (
                  <div className="space-y-2">
                    {reviewHistory.map((review) => (
                      <div key={review.id} className="bg-black/30 border border-white/10 rounded-xl p-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-white font-bold truncate">{review.title || "Contract Analysis"}</div>
                          <div className="text-[11px] text-gray-400 truncate">
                            {new Date(review.createdAt).toLocaleString()} · {review.model || "model n/a"} · {review.docCount} doc(s) · {review.createdBy}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => openReviewSession(review.workspaceId, review.id)}
                            disabled={reviewLoading}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-violet-600 text-white disabled:opacity-50"
                          >
                            {reviewLoading && activeReviewId === review.id ? "Opening..." : "Open"}
                          </button>
                          <button
                            onClick={async () => {
                              const url = getReviewPermalink(review.workspaceId, review.id);
                              try {
                                await navigator.clipboard.writeText(url);
                                showNotify("Review link copied");
                              } catch {
                                showNotify("Unable to copy link to clipboard", "error");
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-white/5 text-gray-200 border border-white/10"
                          >
                            <LinkIcon className="w-3 h-3 inline mr-1" />
                            Copy Link
                          </button>
                          {canDeleteReviews && (
                            <button
                              onClick={() => setDeleteId(review.id)}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-red-500/10 text-red-300 border border-red-500/30"
                            >
                              <Trash2 className="w-3 h-3 inline mr-1" />
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {view === 'processor' && activeTemplate && (
          <div className="p-8 max-w-5xl mx-auto h-full overflow-y-auto">
             <div className="w-full bg-[#111] border border-white/10 rounded-[40px] p-10 shadow-2xl space-y-6">
                <div className="text-center"><h2 className="text-3xl font-black text-white">Analyze with {activeTemplate.name}</h2></div>

                <div className={`border-2 border-dashed border-white/10 rounded-[32px] p-14 text-center relative ${analysisRunning ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5 cursor-pointer'}`}>
                    <input type="file" multiple onChange={handleFileUpload} disabled={analysisRunning} className="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed" />
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-4" />
                    <p className="text-sm text-gray-400 font-bold">Select contracts for automated review</p>
                </div>
                <input ref={replaceInputRef} type="file" className="hidden" onChange={handleReplaceDocument} disabled={analysisRunning} />

                <div className="bg-black/30 border border-white/10 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-wider text-gray-400 font-black">Uploaded Documents</div>
                    <button
                      onClick={handleClearDocuments}
                      disabled={analysisRunning || documents.length === 0}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-white/5 text-gray-300 disabled:opacity-40 hover:bg-white/10"
                    >
                      Clear All
                    </button>
                  </div>
                  {documents.length === 0 ? (
                    <div className="text-sm text-gray-500">No documents uploaded yet.</div>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {documents.map((doc) => (
                        <div key={doc.id} className="bg-[#151518] border border-white/10 rounded-xl p-3 flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm text-white font-semibold truncate">{doc.name}</div>
                            <div className="text-[11px] text-gray-400 uppercase tracking-wider">
                              {doc.type} · {formatFileSize(doc.sizeBytes)} · {doc.charCount || doc.content.length} chars{doc.pageCount ? ` · ${doc.pageCount} pages` : ""}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => handleRequestReplace(doc.id)}
                              disabled={analysisRunning}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-violet-600/20 text-violet-200 border border-violet-500/30 disabled:opacity-40"
                            >
                              <RefreshCw className="w-3 h-3 inline mr-1" />
                              Replace
                            </button>
                            <button
                              onClick={() => handleRemoveDocument(doc.id)}
                              disabled={analysisRunning}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-red-500/10 text-red-300 border border-red-500/30 disabled:opacity-40"
                            >
                              <Trash2 className="w-3 h-3 inline mr-1" />
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {(analysisRunning || clauseProgressEntries.some((entry) => entry.progress.status !== 'queued')) && (
                  <div className="bg-black/30 border border-white/10 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs uppercase tracking-wider text-gray-400 font-black">Clause Progress</div>
                      <div className="text-[11px] font-black text-gray-300">{clauseDone}/{clauseTotal} complete</div>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full bg-violet-500 transition-all duration-300" style={{ width: `${clauseProgressPct}%` }} />
                    </div>
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {clauseProgressEntries.map(({ title, progress }) => (
                        <div key={title} className="flex items-center justify-between rounded-lg border border-white/10 bg-[#151518] px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-black text-white uppercase tracking-wider truncate">{title}</div>
                            {progress.status === 'running' && <div className="text-[10px] text-violet-300 font-semibold">{selectedModel}</div>}
                            {progress.status === 'error' && progress.detail && <div className="text-[10px] text-red-300 truncate">{progress.detail}</div>}
                          </div>
                          <div className="shrink-0">
                            {progress.status === 'queued' && <Clock3 className="w-4 h-4 text-gray-500" />}
                            {progress.status === 'running' && <Loader className="w-4 h-4 text-violet-300 animate-spin" />}
                            {progress.status === 'done' && <Check className="w-4 h-4 text-emerald-400" />}
                            {progress.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-4">
                   <button onClick={handleAnalysis} disabled={analysisRunning || loading || !documents.length} className="flex-1 py-4 bg-violet-600 text-white rounded-2xl font-black flex items-center justify-center gap-2 disabled:opacity-50">
                      {analysisRunning ? <><Loader className="w-5 h-5 animate-spin" /> Analyzing via {selectedModel}...</> : <><Zap className="w-5 h-5"/> Start Analysis ({analysisCost}c)</>}
                   </button>
                   <span className="text-xs font-black text-gray-300 bg-black/40 border border-white/10 rounded-xl px-3 py-2">{documents.length} document(s) ready</span>
                </div>
             </div>
          </div>
        )}

        {view === 'editor' && activeTemplate && (
          <TemplateEditor template={activeTemplate} setTemplate={setActiveTemplate} onSave={() => showNotify("Saved")} onExport={() => {}} onShowMegaPrompt={() => setMegaPromptOpen(true)} onModifyWithAI={() => setModifyModalOpen(true)} onClose={() => setView('dashboard')} />
        )}

        {view === 'results' && results.length > 0 && (
          <ResultsView
            results={results}
            documents={documents}
            onDraftEmail={async (d) => alert(await draftEmail(d))}
            onSuggestRevision={async (c, o, i) => { const r = await suggestRevision(c, o, i); setRevisionData({ title: c, original: o, revised: r }); }}
            onChat={(q) => chatWithDoc("", q, documents.map(d => d.content).join("\n"))}
            loadingAi={loading}
            userCredits={credits}
            onConsumeCredits={(c) => { if(credits >= c) { setCredits(prev => prev - c); return true; } return false; }}
            workspaceId={activeWorkspaceId || undefined}
            activity={activity}
            findingComments={findingComments}
            findingStatuses={findingStatuses}
            onAddFindingComment={handleAddFindingComment}
            onGetFindingComments={handleGetFindingComments}
            onUpdateFindingStatus={handleUpdateFindingStatus}
            onHydrateFindingStatus={handleHydrateFindingStatus}
            onCopyReviewLink={activeWorkspaceId && activeReviewId ? handleCopyReviewLink : undefined}
          />
        )}
      </main>

      <CreateTemplateModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} onCreate={handleCreateTemplate} loading={loading} />
      <ProviderSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        keys={apiKeys}
        onSave={saveKeys}
        residency={residencySettings}
        onSaveResidency={saveResidency}
        keyPolicy={keyPolicy}
      />
      <MegaPromptModal isOpen={megaPromptOpen} onClose={() => setMegaPromptOpen(false)} template={activeTemplate || undefined} />
      <ModifyTemplateModal isOpen={modifyModalOpen} onClose={() => setModifyModalOpen(false)} onModify={() => {}} loading={loading} />
      <RevisionModal isOpen={!!revisionData} onClose={() => setRevisionData(null)} data={revisionData} />
      <ShareProjectModal
        isOpen={shareOpen}
        onClose={() => setShareOpen(false)}
        onInvite={handleInvite}
        onCopyReviewLink={activeWorkspaceId && activeReviewId ? handleCopyReviewLink : undefined}
      />
      <MembersModal isOpen={membersOpen} onClose={() => setMembersOpen(false)} members={members} onUpdateRole={handleMemberRoleUpdate} />
      <ConfirmationModal
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (!deleteId) return;
          const targetId = deleteId;
          setDeleteId(null);
          void handleDeleteReview(targetId);
        }}
        title="Delete Review Session"
        message="This removes the saved review and attached persisted findings from workspace history."
      />
    </div>
  );
}
