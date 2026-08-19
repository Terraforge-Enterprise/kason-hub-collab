import { Hono } from "hono";
import type { CommissionsSession } from "./commissions.types";
import { requireRole } from "../../middleware/require-role";
import { z } from "zod";
import {
  createTierMappingSchema,
  updateTierMappingSchema,
  approveClaimSchema,
  rejectClaimSchema,
  payClaimSchema,
  bulkApproveClaimsSchema,
  createRoomTypeSchema,
  updateRoomTypeSchema,
} from "@kason/shared";
import {
  listTierMappingsService,
  createTierMappingService,
  updateTierMappingService,
  deleteTierMappingService,
  listClaimsService,
  getClaimDetailService,
  approveClaimService,
  rejectClaimService,
  payClaimService,
  bulkApproveClaimsService,
  undoApproveClaimService,
  setClaimNeedsAmendmentService,
  getPerformanceService,
  listRoomTypesService,
  createRoomTypeService,
  updateRoomTypeService,
  deleteRoomTypeService,
  reApproveClaimService,
  getRoomTypeUsageService,
  getRentalCommissionClaimPdfService,
} from "./commissions.service";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import settingsRoutes from "./settings.routes";
import dealAuditRoutes from "./deal-audit.routes";

const commissionsRoutes = new Hono<{ Variables: { session: CommissionsSession } }>();

// Commission settings sub-router — aggregate GET + TA tier CRUD. Mounted
// first so its per-route middleware pins (GET = manager, writes = admin)
// apply independently of the coarser `.use()` blocks below.
commissionsRoutes.route("/settings", settingsRoutes);

// Deal Audit sub-router — grouped read-only view over CommissionClaimItem.
commissionsRoutes.route("/deal-audit", dealAuditRoutes);

// ── Tier Mappings ───────────────────────────────────────────────────────────

commissionsRoutes.use("/tier-mappings", requireRole("manager"));
commissionsRoutes.use("/tier-mappings/*", requireRole("manager"));
commissionsRoutes.use("/room-types", requireRole("manager"));
commissionsRoutes.use("/room-types/*", requireRole("manager"));

commissionsRoutes.get("/tier-mappings", async (c) => {
  const q = c.req.query();
  const result = await listTierMappingsService(c.get("session"), {
    claimType: q.claimType || undefined,
    search:    q.search    || undefined,
    sort:      (q.sort as "default" | "created" | "updated" | undefined) || undefined,
    order:     (q.order as "asc" | "desc" | undefined) || undefined,
    from:      q.from      || undefined,
    to:        q.to        || undefined,
  });
  return c.json({ data: result.data });
});

commissionsRoutes.post("/tier-mappings", async (c) => {
  const session = c.get("session");
  const parsed = createTierMappingSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createTierMappingService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json(result.data, result.status as 201);
});

commissionsRoutes.put("/tier-mappings/:id", async (c) => {
  const session = c.get("session");
  const parsed = updateTierMappingSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateTierMappingService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

// DELETE locked to Super Admin (admin) per meeting spec §3.1 + decision 7.
// The group guard above is `requireRole("manager")` which admits both
// manager AND admin; the per-route `requireRole("admin")` narrows DELETE
// to admin only while leaving GET/POST/PUT at manager+.
commissionsRoutes.delete("/tier-mappings/:id", requireRole("admin"), async (c) => {
  const session = c.get("session");
  const result = await deleteTierMappingService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

// ── Room Types ─────────────────────────────────────────────────────────────

commissionsRoutes.get("/room-types", async (c) => {
  const q = c.req.query();
  const result = await listRoomTypesService(c.get("session"), {
    search: q.search || undefined,
    activeOnly: q.activeOnly === "true",
    sort: (q.sort as "sortOrder" | "name" | "created" | "updated" | undefined) || undefined,
    order: (q.order as "asc" | "desc" | undefined) || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
  });
  return c.json({ data: result.data });
});

commissionsRoutes.post("/room-types", async (c) => {
  const parsed = createRoomTypeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createRoomTypeService(c.get("session"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json(result.data, result.status as 201);
});

commissionsRoutes.put("/room-types/:id", async (c) => {
  const parsed = updateRoomTypeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateRoomTypeService(c.get("session"), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

// DELETE locked to Super Admin (admin) per meeting spec §3.1 + decision 7.
// Group guard above is `requireRole("manager")`; per-route `requireRole("admin")`
// narrows DELETE without loosening the other /room-types methods.
commissionsRoutes.delete("/room-types/:id", requireRole("admin"), async (c) => {
  const result = await deleteRoomTypeService(c.get("session"), c.req.param("id"));
  if (!result.ok) {
    if (result.status === 409) return c.json(result.error, 409);
    return c.json({ error: result.error }, result.status as 404);
  }
  return c.json(result.data);
});

// Returns the count of active Units (listingStatus != "archived") that reference
// this room type by name. Used by the frontend to gate deletion warnings.
// Inherits the `requireRole("manager")` group guard from the `/room-types/*` block.
commissionsRoutes.get("/room-types/:id/usage", async (c) => {
  const result = await getRoomTypeUsageService(c.get("session"), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

// ── Claims ──────────────────────────────────────────────────────────────────

// List + detail: editor+ can read (shape is role-aware at the service layer —
// editors get a redacted row with no `totalNettPayout` / `items`).
commissionsRoutes.use("/claims", requireRole("editor"));
commissionsRoutes.use("/claims/*", requireRole("editor"));

// Approve / reject / pay / bulk-approve / undo-approve: manager+.
// Previously admin-only (inline `session.role !== "admin"` check); opened up
// to manager per the RBAC matrix (`canApprove(role) = atLeast("manager")`).
commissionsRoutes.use("/claims/:id/approve", requireRole("manager"));
commissionsRoutes.use("/claims/:id/reject", requireRole("manager"));
commissionsRoutes.use("/claims/:id/pay", requireRole("manager"));
commissionsRoutes.use("/claims/bulk-approve", requireRole("manager"));
commissionsRoutes.use("/claims/:id/undo-approve", requireRole("manager"));
commissionsRoutes.use("/claims/:id/re-approve", requireRole("manager"));
commissionsRoutes.use("/claims/:id/needs-amendment", requireRole("manager"));

commissionsRoutes.get("/claims", async (c) => {
  const session = c.get("session");
  const q = c.req.query();
  const result = await listClaimsService(session, {
    agentPartyId: q.agentPartyId || undefined,
    status:       q.status       || undefined,
    claimType:    q.claimType    || undefined,
    dateField:    (q.dateField as "createdAt" | "salesDate" | "moveInDate" | undefined) || undefined,
    dateFrom:     q.dateFrom     || undefined,
    dateTo:       q.dateTo       || undefined,
    search:       q.search       || undefined,
    sort:         (q.sort as "newest" | "oldest" | "updated" | "status" | "claimType" | undefined) || undefined,
    page:         q.page  ? Number(q.page)  : undefined,
    limit:        q.limit ? Number(q.limit) : undefined,
  });
  return c.json(result.data);
});

commissionsRoutes.get("/claims/:id", async (c) => {
  const result = await getClaimDetailService(c.get("session"), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Server-side PDF render. Same puppeteer pipeline as reservations — produces
// a PDF with the org's configured letterhead (logo + tax IDs + address).
commissionsRoutes.get("/claims/:id/pdf", async (c) => {
  const session = c.get("session");
  const result = await getRentalCommissionClaimPdfService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return new Response(new Uint8Array(result.pdf), {
    status: result.status,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

commissionsRoutes.post("/claims/:id/approve", async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = approveClaimSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await approveClaimService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

commissionsRoutes.post("/claims/:id/reject", async (c) => {
  const session = c.get("session");
  const parsed = rejectClaimSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await rejectClaimService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

const needsAmendmentBodySchema = z.object({
  note: z.string().trim().min(1, "Note is required").max(2000, "Note must be 2000 characters or fewer"),
});

commissionsRoutes.post("/claims/:id/needs-amendment", async (c) => {
  const session = c.get("session");
  const parsed = needsAmendmentBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await setClaimNeedsAmendmentService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

commissionsRoutes.post("/claims/:id/pay", async (c) => {
  const session = c.get("session");
  const parsed = payClaimSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await payClaimService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

commissionsRoutes.post("/claims/bulk-approve", async (c) => {
  const session = c.get("session");
  const parsed = bulkApproveClaimsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await bulkApproveClaimsService(session, parsed.data);
  return c.json(result.data);
});

commissionsRoutes.post("/claims/:id/undo-approve", async (c) => {
  const session = c.get("session");
  const result = await undoApproveClaimService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

// Re-approve after amendment. Route is manager+ gated (see `.use` above);
// the service then runs the state-machine check (`amended → approved`). A
// request that targets any other source state surfaces as 403
// `forbidden_transition` with structured error payload.
commissionsRoutes.post("/claims/:id/re-approve", async (c) => {
  const session = c.get("session");
  const result = await reApproveClaimService(session, c.req.param("id"), getActorHeaders(c));
  if (!result.ok) {
    return c.json(
      { error: result.error },
      result.status as 400 | 403 | 404 | 409 | 500,
    );
  }
  return c.json({ data: result.data });
});

// ── Performance ─────────────────────────────────────────────────────────────

// Performance returns aggregate commission amounts per agent — manager+ only.
commissionsRoutes.use("/performance", requireRole("manager"));
commissionsRoutes.get("/performance", async (c) => {
  const result = await getPerformanceService(c.get("session"));
  return c.json({ data: result.data });
});

export { commissionsRoutes };
