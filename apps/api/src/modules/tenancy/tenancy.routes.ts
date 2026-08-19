import { Hono } from "hono";
import type { TenancySession } from "./tenancy.types";
import {
  createLandlordTenancySchema,
  createTenancySchema,
  renewTenancySchema,
  updateLandlordTenancyStatusSchema,
  updateTenancySchema,
} from "./tenancy.validation";
import {
  createLandlordTenancyService,
  createTenancyService,
  getLandlordTenanciesService,
  getTenanciesService,
  renewTenancyService,
  updateLandlordTenancyStatusService,
  updateTenancyService,
} from "./tenancy.service";
import { formatZodError } from "../../lib/zod-error-mapper";
import { previewFirstMonthRent, computeFirstMonthCommission } from "./rent-preview";

const tenancyRoutes = new Hono<{ Variables: { session: TenancySession } }>();

// Read-only first-month rent preview. A pure calculation (no DB read, no
// mutation) that reuses computeProratedRent so the admin sees exactly what the
// poster will charge. Optional query params; a missing/invalid date yields a
// 400 rather than a surprising number.
tenancyRoutes.get("/tenancies/rent-preview", (c) => {
  const q = c.req.query();
  const rent = Number(q.monthlyRent);
  if (!q.startDate || !Number.isFinite(rent) || rent < 0) {
    return c.json({ error: "monthlyRent (>= 0) and startDate are required" }, 400);
  }
  const startDate = new Date(q.startDate);
  if (Number.isNaN(startDate.getTime())) return c.json({ error: "Invalid startDate" }, 400);
  const endDate = q.endDate ? new Date(q.endDate) : null;
  if (endDate && Number.isNaN(endDate.getTime())) return c.json({ error: "Invalid endDate" }, 400);
  const rentInvoiceStartDate = q.rentInvoiceStartDate ? new Date(q.rentInvoiceStartDate) : null;
  if (rentInvoiceStartDate && Number.isNaN(rentInvoiceStartDate.getTime())) {
    return c.json({ error: "Invalid rentInvoiceStartDate" }, 400);
  }
  const preview = previewFirstMonthRent({ monthlyRent: rent, startDate, endDate, rentInvoiceStartDate });
  const isCommission = q.firstMonthIsCommission === "true";
  const sstBearer = q.commissionSstBearer === "kaen" ? "kaen" : "owner";
  const commission = computeFirstMonthCommission({ monthlyRent: rent, startDate, endDate, isCommission, sstBearer });
  return c.json({ data: preview, commission });
});

tenancyRoutes.get("/landlord-tenancies", async (c) => {
  const data = await getLandlordTenanciesService(c.get("session"));
  return c.json({ data });
});

tenancyRoutes.post("/landlord-tenancies", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = createLandlordTenancySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createLandlordTenancyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json(result.data, result.status as 201);
});

tenancyRoutes.put("/landlord-tenancies/:landlordTenancyId/status", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = updateLandlordTenancyStatusSchema.safeParse({ ...(await c.req.json()), landlordTenancyId: c.req.param("landlordTenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateLandlordTenancyStatusService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

tenancyRoutes.get("/tenancies", async (c) => {
  const data = await getTenanciesService(c.get("session"));
  return c.json({ data });
});

tenancyRoutes.post("/tenancies", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = createTenancySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createTenancyService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        ...("code" in result ? { code: result.code } : {}),
        ...("incumbent" in result && result.incumbent ? { incumbent: result.incumbent } : {}),
        ...("existingTenancyId" in result ? { existingTenancyId: result.existingTenancyId } : {}),
      },
      result.status as 400 | 403 | 404 | 409 | 422,
    );
  }
  return c.json(result.data, result.status as 201);
});

tenancyRoutes.put("/tenancies/:tenancyId", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = updateTenancySchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateTenancyService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      { error: result.error, ...("code" in result ? { code: result.code } : {}) },
      result.status as 400 | 403 | 404 | 409 | 422,
    );
  }
  return c.json(result.data);
});

tenancyRoutes.post("/tenancies/:tenancyId/renew", async (c) => {
  const session = c.get("session");
  if (session.role === "viewer") return c.json({ error: "Read-only access" }, 403);
  const parsed = renewTenancySchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await renewTenancyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data, result.status as 201);
});

export { tenancyRoutes };
