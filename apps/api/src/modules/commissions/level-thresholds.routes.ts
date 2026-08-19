import { Hono } from "hono";
import { requireRole } from "../../middleware/require-role";
import {
  agentLevelEnum,
  updateLevelThresholdSchema,
  levelThresholdPreviewSchema,
} from "@kason/shared";
import {
  listLevelThresholdsService,
  updateLevelThresholdService,
  previewLevelThresholdService,
} from "./level-thresholds.service";
import type { CommissionsSession } from "./commissions.types";
import { formatZodError } from "../../lib/zod-error-mapper";

const levelThresholdsRoutes = new Hono<{ Variables: { session: CommissionsSession } }>();

levelThresholdsRoutes.use("/", requireRole("manager"));
levelThresholdsRoutes.use("/*", requireRole("manager"));

levelThresholdsRoutes.get("/", async (c) => {
  const result = await listLevelThresholdsService(c.get("session") as any);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

levelThresholdsRoutes.put("/:agentLevel", async (c) => {
  const levelParam = agentLevelEnum.safeParse(c.req.param("agentLevel"));
  if (!levelParam.success) return c.json({ error: "Unknown level" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateLevelThresholdSchema.safeParse({ ...body, agentLevel: levelParam.data });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await updateLevelThresholdService(c.get("session") as any, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ ok: true, data: result.data });
});

levelThresholdsRoutes.post("/:agentLevel/preview", async (c) => {
  const levelParam = agentLevelEnum.safeParse(c.req.param("agentLevel"));
  if (!levelParam.success) return c.json({ error: "Unknown level" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = levelThresholdPreviewSchema.safeParse({ ...body, agentLevel: levelParam.data });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await previewLevelThresholdService(c.get("session") as any, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

export default levelThresholdsRoutes;
