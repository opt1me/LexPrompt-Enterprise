import { FindingReviewStatus } from "../../../../types";
import { getActorEmail, requireWorkspaceRole } from "../../../_lib/auth";
import { listStatusesForWorkspace, updateFindingStatus } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const findingId = req.query.findingId as string;
  const workspaceId = req.query.workspaceId as string;
  const actor = getActorEmail(req);
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  if (req.method === "GET") {
    try {
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor", "reviewer"]);
      const history = (await listStatusesForWorkspace(workspaceId)).filter((x) => x.findingId === findingId);
      return res.status(200).json({ history, current: history[history.length - 1]?.to || "open", version: history.length });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor", "reviewer"]);
      const next = (req.body?.status || "open") as FindingReviewStatus;
      const expectedVersion = req.body?.expectedVersion;
      const data = await updateFindingStatus(workspaceId, findingId, next, actor, expectedVersion);
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
