import { WorkspaceRole } from "../../../../../types";
import { getActorEmail, requireWorkspaceRole } from "../../../../_lib/auth";
import { updateMemberRole } from "../../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  if (req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });

  const workspaceId = req.query.id as string;
  const userId = req.query.userId as string;

  try {
    const actor = await getActorEmail(req, res);
    await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
    const role = (req.body?.role || "reviewer") as WorkspaceRole;
    const member = await updateMemberRole(workspaceId, userId, role, actor);
    return res.status(200).json({ member });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
