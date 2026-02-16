import { AIProvider, AnalysisAuditEvent, DataRegion, ResidencyMode, ResidencySettings } from "../types";

const RESIDENCY_STORAGE_KEY = "lexprompt_residency_settings_v1";
const AUDIT_STORAGE_KEY = "lexprompt_audit_events_v1";

export const DEFAULT_RESIDENCY_SETTINGS: ResidencySettings = {
  primaryRegion: "uk-london",
  fallbackRegion: "eu-frankfurt",
  residencyMode: "uk_preferred_eu_fallback",
  noTraining: true,
  minRetention: true,
  policyVersion: "beta-uk-eu-v1",
};

export const ALLOWED_REGIONS: DataRegion[] = ["uk-london", "eu-frankfurt", "eu-ireland"];

const MODEL_BLOCKLIST_BY_REGION: Record<DataRegion, string[]> = {
  "uk-london": [],
  "eu-frankfurt": [],
  "eu-ireland": [],
};

export const loadResidencySettings = (): ResidencySettings => {
  try {
    const saved = localStorage.getItem(RESIDENCY_STORAGE_KEY);
    if (!saved) return DEFAULT_RESIDENCY_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<ResidencySettings>;
    return {
      ...DEFAULT_RESIDENCY_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_RESIDENCY_SETTINGS;
  }
};

export const saveResidencySettings = (settings: ResidencySettings): void => {
  localStorage.setItem(RESIDENCY_STORAGE_KEY, JSON.stringify(settings));
};

export const resolveActiveRegion = (settings: ResidencySettings): DataRegion => {
  if (settings.residencyMode === "strict_uk_only") return "uk-london";
  if (settings.residencyMode === "eu_only") return settings.fallbackRegion;
  return settings.primaryRegion;
};

export const isModelApprovedForRegion = (model: string, region: DataRegion): boolean => {
  const blocked = MODEL_BLOCKLIST_BY_REGION[region];
  return !blocked.some((blockedModel) => model.includes(blockedModel));
};

export const getRegionLabel = (region: DataRegion): string => {
  if (region === "uk-london") return "UK (London)";
  if (region === "eu-frankfurt") return "EU (Frankfurt)";
  return "EU (Ireland)";
};

export const createAuditEvent = (
  eventType: AnalysisAuditEvent["eventType"],
  data: {
    provider: AIProvider;
    model: string;
    region: DataRegion;
    policyVersion: string;
    residencyMode: ResidencyMode;
    workspaceId?: string;
    metadata?: AnalysisAuditEvent["metadata"];
  }
): AnalysisAuditEvent => ({
  id: `audit_${Math.random().toString(36).slice(2, 10)}`,
  eventType,
  createdAt: new Date().toISOString(),
  provider: data.provider,
  model: data.model,
  region: data.region,
  policyVersion: data.policyVersion,
  residencyMode: data.residencyMode,
  workspaceId: data.workspaceId,
  metadata: data.metadata,
});

export const appendAuditEvent = (event: AnalysisAuditEvent): void => {
  try {
    const current = localStorage.getItem(AUDIT_STORAGE_KEY);
    const events: AnalysisAuditEvent[] = current ? JSON.parse(current) : [];
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify([event, ...events].slice(0, 500)));
  } catch {
    // no-op in case storage is unavailable
  }
};

export const loadAuditEvents = (): AnalysisAuditEvent[] => {
  try {
    const current = localStorage.getItem(AUDIT_STORAGE_KEY);
    return current ? (JSON.parse(current) as AnalysisAuditEvent[]) : [];
  } catch {
    return [];
  }
};
