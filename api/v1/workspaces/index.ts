import { createWorkspaceWithOwner, getMembers, listWorkspacesForUser } from "../../_lib/collabStore";
import { getActorEmail } from "../../_lib/auth";

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      const workspaces = await listWorkspacesForUser(actor);
      return res.status(200).json({ workspaces });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const actor = await getActorEmail(req, res);
      const name = String(req.body?.name || "Untitled Workspace").trim();
      const ws = await createWorkspaceWithOwner(name, actor);
      return res.status(201).json({ workspace: ws, members: await getMembers(ws.id) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
