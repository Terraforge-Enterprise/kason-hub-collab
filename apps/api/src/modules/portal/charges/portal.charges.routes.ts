import { Hono } from "hono";
import { paginationSchema, paymentSubmissionSchema } from "@kason/shared";
import type { PortalEnv } from "../auth/portal.auth.types";
import { listCharges, getChargeDetail } from "./portal.charges.repository";
import { getCombinedStatement } from "./portal.statement.repository";
import { submitPayment } from "./portal.charges.service";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalChargesRoutes = new Hono<PortalEnv>();

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

portalChargesRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid pagination" }, 400);
  const result = await listCharges(
    { partyId: session.partyId, orgId: session.orgId },
    parsed.data.page, parsed.data.limit,
  );
  return c.json(result);
});

// Combined tenant statement for a month — charges grouped by unit context
// (unit code / "Carpark"); NO owner identity is resolved or returned (PDPA #5).
// Registered BEFORE "/:id" so the literal "/statement" segment is never read as a charge id.
portalChargesRoutes.get("/statement", async (c) => {
  const session = c.get("session");
  const monthParam = c.req.query("month");
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : currentMonth();
  if (monthParam && !MONTH_RE.test(monthParam)) {
    return c.json({ error: "Invalid month (expected YYYY-MM)" }, 400);
  }
  const data = await getCombinedStatement(
    { partyId: session.partyId, orgId: session.orgId },
    month,
  );
  return c.json({ data });
});

portalChargesRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const charge = await getChargeDetail(
    { partyId: session.partyId, orgId: session.orgId },
    c.req.param("id"),
  );
  if (!charge) return c.json({ error: "Charge not found" }, 404);
  return c.json({ data: charge });
});

portalChargesRoutes.post("/:id/pay", async (c) => {
  const session = c.get("session");
  const parsed = paymentSubmissionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await submitPayment(
    { partyId: session.partyId, orgId: session.orgId, userId: session.userId },
    c.req.param("id"),
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json(result.data, 201);
});

export { portalChargesRoutes };
