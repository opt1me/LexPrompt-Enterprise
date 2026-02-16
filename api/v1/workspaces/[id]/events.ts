import { getActorEmail, requireWorkspaceMember, requireWorkspaceRole } from "../../../_lib/auth";
import { listEvents, publishEvent, pushActivity } from "../../../_lib/collabStore";

export default async function handler(req: any, res: any) {
  const workspaceId = req.query.id as string;
  const actor = getActorEmail(req);

  if (req.method === "POST") {
    try {
      await requireWorkspaceRole(workspaceId, actor, ["owner", "admin", "editor"]);
      const type = req.body?.type || "analysis_completed";
      const entityId = req.body?.entityId || "analysis";
      const payload = req.body?.payload || {};
      await publishEvent(workspaceId, type, entityId, payload);
      await pushActivity(workspaceId, actor, type, entityId, payload);
      return res.status(201).json({ ok: true });
    } catch (e: any) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  try {
    await requireWorkspaceMember(workspaceId, actor);
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  const accept = req.headers.accept || "";
  const since = typeof req.query.since === "string" ? req.query.since : undefined;

  if (String(accept).includes("text/event-stream")) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let lastSince = since || new Date(Date.now() - 5000).toISOString();
    const send = async () => {
      const events = await listEvents(workspaceId, lastSince);
      if (events.length > 0) {
        lastSince = events[events.length - 1].createdAt;
        res.write(`data: ${JSON.stringify({ events })}\n\n`);
      } else {
        res.write(`: ping\n\n`);
      }
    };
    await send();
    const timer = setInterval(() => {
      send().catch(() => {
        // Keep stream alive; transient errors should not kill interval.
      });
    }, 1000);
    req.on("close", () => clearInterval(timer));
    return;
  }

  return res.status(200).json({ events: await listEvents(workspaceId, since) });
}
