import { getActorEmail, requireWorkspaceMember } from "../../_lib/auth";
import { listActivity } from "../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const workspaceId = req.query.workspaceId as string;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
  try {
    const actor = await getActorEmail(req, res);
    await requireWorkspaceMember(workspaceId, actor);
    return res.status(200).json({ activity: await listActivity(workspaceId) });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
