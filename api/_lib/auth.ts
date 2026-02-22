import { createClient } from "@supabase/supabase-js";
import { WorkspaceRole } from "../../types";
import { getMembership, hasRole } from "./collabStore";
import { enforceRateLimit } from "./rateLimit";

export type ActorContext = {
  email: string;
  userId: string;
  source: "supabase" | "insecure-demo";
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const allowInsecureDemoAuth =
  process.env.NODE_ENV !== "production" && String(process.env.ALLOW_INSECURE_DEMO_AUTH || "").toLowerCase() === "true";

const authClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const parseCsvEnv = (raw?: string): string[] =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const allowedEmails = new Set(parseCsvEnv(process.env.BETA_ALLOWED_EMAILS));
const allowedDomains = new Set(parseCsvEnv(process.env.BETA_ALLOWED_DOMAINS));

const isEmailAllowedForBeta = (email: string): boolean => {
  const normalized = email.toLowerCase();
  if (allowedEmails.size === 0 && allowedDomains.size === 0) return true;
  if (allowedEmails.has(normalized)) return true;
  const parts = normalized.split("@");
  const domain = parts.length === 2 ? parts[1] : "";
  return !!domain && allowedDomains.has(domain);
};

const getBearerToken = (req: any): string | null => {
  const raw = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof raw !== "string") return null;
  const [scheme, token] = raw.trim().split(/\s+/);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim();
};

const readInsecureDevEmail = (req: any): string | null => {
  const fromHeader = req?.headers?.["x-user-email"] || req?.headers?.["X-User-Email"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.toLowerCase();
  const fromBody = req?.body?.actorEmail;
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.toLowerCase();
  return "demo@lexprompt.ai";
};

export const getActorContext = async (req: any, res?: any): Promise<ActorContext> => {
  if (res && !enforceRateLimit(req, res, "auth", { limit: 180, windowMs: 60_000 })) {
    const err: any = new Error("Too many requests");
    err.status = 429;
    throw err;
  }

  const token = getBearerToken(req);
  if (token) {
    if (!authClient) {
      const err: any = new Error("Server auth is not configured");
      err.status = 500;
      throw err;
    }
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user?.email) {
      const err: any = new Error("Unauthorized: invalid bearer token");
      err.status = 401;
      throw err;
    }
    const email = String(data.user.email).toLowerCase();
    if (!isEmailAllowedForBeta(email)) {
      const err: any = new Error("Forbidden: email/domain is not allowlisted for beta");
      err.status = 403;
      throw err;
    }
    return { email, userId: data.user.id || email, source: "supabase" };
  }

  if (!allowInsecureDemoAuth) {
    const err: any = new Error("Unauthorized: missing bearer token");
    err.status = 401;
    throw err;
  }

  const devEmail = readInsecureDevEmail(req);
  if (!devEmail) {
    const err: any = new Error("Unauthorized: missing actor identity");
    err.status = 401;
    throw err;
  }
  if (!isEmailAllowedForBeta(devEmail)) {
    const err: any = new Error("Forbidden: email/domain is not allowlisted for beta");
    err.status = 403;
    throw err;
  }
  return { email: devEmail, userId: devEmail, source: "insecure-demo" };
};

export const getActorEmail = async (req: any, res?: any): Promise<string> => {
  const actor = await getActorContext(req, res);
  return actor.email;
};

export const requireWorkspaceMember = async (workspaceId: string, actorEmail: string) => {
  const m = await getMembership(workspaceId, actorEmail);
  if (!m) {
    const err: any = new Error("Forbidden: user is not a workspace member");
    err.status = 403;
    throw err;
  }
  return m;
};

export const requireWorkspaceRole = async (workspaceId: string, actorEmail: string, roles: WorkspaceRole[]) => {
  if (!(await hasRole(workspaceId, actorEmail, roles))) {
    const err: any = new Error("Forbidden: insufficient role");
    err.status = 403;
    throw err;
  }
  return requireWorkspaceMember(workspaceId, actorEmail);
};

