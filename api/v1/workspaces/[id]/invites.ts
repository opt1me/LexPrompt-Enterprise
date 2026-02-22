import { getActorEmail, requireWorkspaceRole } from "../../../_lib/auth";
import { createInvite, getMembers } from "../../../_lib/collabStore";
import { WorkspaceRole } from "../../../../types";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;

  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
      return res.status(200).json({ members: await getMembers(workspaceId) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
      const email = String(req.body?.email || "").toLowerCase();
      const role = (req.body?.role || "reviewer") as WorkspaceRole;
      if (!email) return res.status(400).json({ error: "email is required" });
      const invite = await createInvite(workspaceId, actor, email, role);
      const inviteToken = invite.token || "";
      return res.status(201).json({ invite, inviteLink: `/accept-invite?workspace=${workspaceId}&token=${inviteToken}` });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
