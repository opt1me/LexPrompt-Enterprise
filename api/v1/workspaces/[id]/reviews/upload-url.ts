import { getActorEmail, requireWorkspaceRole } from "../../../../_lib/auth";
import { createReviewUploadContract } from "../../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const workspaceId = req.query.id as string;

  try {
    const actor = await getActorEmail(req, res);
    await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor"]);
    const reviewId = String(req.body?.reviewId || "").trim();
    const docs = Array.isArray(req.body?.documents) ? req.body.documents : [];
    if (!reviewId) return res.status(400).json({ error: "reviewId is required" });
    if (docs.length === 0) return res.status(400).json({ error: "documents is required" });

    const contract = await createReviewUploadContract(workspaceId, reviewId, docs);
    return res.status(200).json(contract);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
