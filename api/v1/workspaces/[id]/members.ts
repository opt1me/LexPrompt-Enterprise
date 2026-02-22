import { WorkspaceRole } from "../../../../types";
import { getActorEmail, requireWorkspaceRole } from "../../../_lib/auth";
import { acceptInvite, addMemberDirect, getMembers } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;

  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor", "reviewer"]);
      return res.status(200).json({ members: await getMembers(workspaceId) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const token = req.body?.token as string | undefined;
    try {
      const actor = await getActorEmail(req, res);
      if (token) {
        const member = await acceptInvite(workspaceId, token, actor);
        return res.status(201).json({ member });
      }
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
      const email = String(req.body?.email || "").toLowerCase();
      const role = (req.body?.role || "reviewer") as WorkspaceRole;
      if (!email) return res.status(400).json({ error: "email is required" });
      const member = await addMemberDirect(workspaceId, actor, email, role);
      return res.status(201).json({ member });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
