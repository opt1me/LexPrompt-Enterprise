import { getActorEmail, requireWorkspaceMember, requireWorkspaceRole } from "../../../../_lib/auth";
import { createReviewSession, listReviewSessions } from "../../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;

  if (req.method === "GET") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceMember(workspaceId, actor);
      const reviews = await listReviewSessions(workspaceId);
      return res.status(200).json({ reviews });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const actor = await getActorEmail(req, res);
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor"]);
      const input = {
        title: req.body?.title || "Contract Analysis",
        templateSnapshot: req.body?.templateSnapshot || {},
        findings: req.body?.findings || {},
        docOrder: req.body?.docOrder || [],
        provider: req.body?.provider || null,
        model: req.body?.model || null,
        region: req.body?.region || null,
        policyVersion: req.body?.policyVersion || null,
        status: req.body?.status || "complete",
        documents: Array.isArray(req.body?.documents) ? req.body.documents : [],
      };

      const review = await createReviewSession(workspaceId, actor, input);
      return res.status(201).json({ review });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
