import { getActorEmail, requireWorkspaceMember } from "../../_lib/auth";
import { listNotifications, markNotificationRead } from "../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      const workspaceId = req.query.workspaceId as string;
      if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
      await requireWorkspaceMember(workspaceId, actor);
      return res.status(200).json({ notifications: await listNotifications(workspaceId, actor) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const actor = await getActorEmail(req, res);
      const workspaceId = req.body?.workspaceId as string;
      if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
      await requireWorkspaceMember(workspaceId, actor);
      const id = req.body?.id as string;
      if (!id) return res.status(400).json({ error: "id is required" });
      const notification = await markNotificationRead(workspaceId, id, actor);
      if (!notification) return res.status(404).json({ error: "notification not found" });
      return res.status(200).json({ notification });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
