import { getActorEmail, requireWorkspaceMember, requireWorkspaceRole } from "../../../_lib/auth";
import { getWorkspaceSettings, updateWorkspaceSettings } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceMember(workspaceId, actor);
      const settings = await getWorkspaceSettings(workspaceId);
      return res.status(200).json({ settings });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
      const settings = await updateWorkspaceSettings(workspaceId, actor, {
        retainSourceDocuments: Boolean(req.body?.retainSourceDocuments),
      });
      return res.status(200).json({ settings });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
