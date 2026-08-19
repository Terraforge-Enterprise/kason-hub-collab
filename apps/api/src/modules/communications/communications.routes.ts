import { Hono } from "hono";
import type { CommunicationsSession } from "./communications.types";
import { processEmailQueue } from "./email-worker";
import {
  createNotificationSchema,
  enqueueNotificationSchema,
} from "./communications.validation";
import {
  createNotificationService,
  enqueueNotificationService,
  getNotificationQueueService,
  getNotificationsService,
} from "./communications.service";
import { formatZodError } from "../../lib/zod-error-mapper";

const communicationsRoutes = new Hono<{ Variables: { session: CommunicationsSession } }>();

communicationsRoutes.get("/notifications", async (c) => c.json({ data: await getNotificationsService(c.get("session")) }));
communicationsRoutes.get("/notification-queue", async (c) => c.json({ data: await getNotificationQueueService(c.get("session")) }));

communicationsRoutes.post("/notifications", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = createNotificationSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "communications" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createNotificationService(session, parsed.data);
  return c.json(result.data, result.status as 201);
});

communicationsRoutes.post("/notification-queue", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = enqueueNotificationSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "communications" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await enqueueNotificationService(session, parsed.data);
  return c.json(result.data, result.status as 201);
});

communicationsRoutes.post("/process-queue", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const result = await processEmailQueue(session.orgId);
  return c.json({ data: result });
});

export { communicationsRoutes };
