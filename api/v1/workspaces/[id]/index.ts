import { getActorEmail, requireWorkspaceMember } from "../../../_lib/auth";
import { getWorkspace, getMembers } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const actor = getActorEmail(req);
  const workspaceId = req.query.id as string;
  try {
    await requireWorkspaceMember(workspaceId, actor);
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    return res.status(200).json({ workspace, members: await getMembers(workspaceId) });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
