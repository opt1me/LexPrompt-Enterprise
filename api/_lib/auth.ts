import { WorkspaceRole } from "../../types";
import { getMembership, hasRole } from "./collabStore";

export const getActorEmail = (req: any): string => {
  const headerEmail = req.headers["x-user-email"] || req.headers["X-User-Email"];
  if (typeof headerEmail === "string" && headerEmail.trim()) return headerEmail.toLowerCase();
  const bodyEmail = req.body?.actorEmail;
  if (typeof bodyEmail === "string" && bodyEmail.trim()) return bodyEmail.toLowerCase();
  return "demo@lexprompt.ai";
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
