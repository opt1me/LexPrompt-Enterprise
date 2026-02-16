import { getActorEmail } from "../../_lib/auth";
import { listNotifications, markNotificationRead } from "../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const actor = getActorEmail(req);

  if (req.method === "GET") {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    return res.status(200).json({ notifications: await listNotifications(workspaceId, actor) });
  }

  if (req.method === "PATCH") {
    const id = req.body?.id as string;
    if (!id) return res.status(400).json({ error: "id is required" });
    const notification = await markNotificationRead(id, actor);
    if (!notification) return res.status(404).json({ error: "notification not found" });
    return res.status(200).json({ notification });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
