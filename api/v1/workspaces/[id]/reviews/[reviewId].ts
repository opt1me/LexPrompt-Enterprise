import { getActorEmail, requireWorkspaceMember, requireWorkspaceRole } from "../../../../_lib/auth";
import { deleteReviewSession, getReviewSessionDetail } from "../../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;
  const reviewId = req.query.reviewId as string;
  const actor = getActorEmail(req);

  if (req.method === "GET") {
    try {
      await requireWorkspaceMember(workspaceId, actor);
      const review = await getReviewSessionDetail(workspaceId, reviewId);
      return res.status(200).json({ review });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin"]);
      await deleteReviewSession(workspaceId, reviewId, actor);
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
