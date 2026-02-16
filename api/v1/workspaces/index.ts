import { createWorkspaceWithOwner, getMembers, listWorkspacesForUser } from "../../_lib/collabStore";
import { getActorEmail } from "../../_lib/auth";

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    const actor = getActorEmail(req);
    const workspaces = await listWorkspacesForUser(actor);
    return res.status(200).json({ workspaces });
  }

  if (req.method === "POST") {
    const actor = getActorEmail(req);
    const name = (req.body?.name || "Untitled Workspace").trim();
    const ws = await createWorkspaceWithOwner(name, actor);
    return res.status(201).json({ workspace: ws, members: await getMembers(ws.id) });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
