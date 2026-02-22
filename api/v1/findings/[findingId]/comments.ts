import { getActorEmail, requireWorkspaceRole } from "../../../_lib/auth";
import { addFindingComment, listFindingComments } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const findingId = req.query.findingId as string;
  const workspaceId = req.query.workspaceId as string;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor", "reviewer"]);
      return res.status(200).json({ comments: await listFindingComments(workspaceId, findingId) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor", "reviewer"]);
      const text = String(req.body?.text || "").trim();
      if (!text) return res.status(400).json({ error: "text is required" });
      const comment = await addFindingComment(workspaceId, findingId, actor, text);
      return res.status(201).json({ comment, comments: await listFindingComments(workspaceId, findingId) });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
