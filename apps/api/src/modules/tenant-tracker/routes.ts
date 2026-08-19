// Tenant Tracker (M1) — HTTP routes.
// Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 4).
//
// Mounted UNCONDITIONALLY at /api/tenant-tracker in app.ts; the FIRST
// middleware below gates every request on ENABLE_PHASE2_TENANT_TRACKER
// (per-request, mirroring the public-card precedent) and returns the
// canonical public-card 404 body — even for unauthenticated callers (the
// gate runs BEFORE requireRole, so flag-off wins over 401/403).
//
// Zod errors are serialized via formatZodError ONLY — never echo issue.input
// or raw query values (PII: phone numbers; see packages/shared phone.ts).

import { Hono } from "hono";
import ExcelJS from "exceljs";
import { z } from "zod";
import type { ZodError } from "zod";
import type { Context } from "hono";
import {
  assignInChargeSchema,
  icRevealBodySchema,
  tenantTrackerListQuerySchema,
  tenantTrackerLookupQuerySchema,
} from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireRole } from "../../middleware/require-role";
import {
  assignInChargeService,
  exportTrackerRowsService,
  listAgentLabelsService,
  listTrackerService,
  lookupPhoneService,
  recordIcRevealService,
  trackerSummaryService,
  type TrackerExportRow,
} from "./service";

const tenantTrackerRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// ── Per-request feature-flag gate (FIRST — before requireRole) ──────────────
tenantTrackerRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_TENANT_TRACKER")) {
    // Canonical 404 shape (public-card/routes.ts notFound body).
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});

// ── Validation helpers ───────────────────────────────────────────────────────

const unitIdParamSchema = z.string().uuid();

// Export takes the SAME filters as the list; cursor/limit are pagination
// concerns the export owns internally (zod strips the unknown keys).
const exportQuerySchema = tenantTrackerListQuerySchema.omit({ cursor: true, limit: true });

function zodBadRequest(c: Context, error: ZodError) {
  const friendly = formatZodError(error, { domain: "tenancy" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ── GET / — grouped-by-apartment tracker list (editor+) ─────────────────────

tenantTrackerRoutes.get("/", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const parsed = tenantTrackerListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);

  const result = await listTrackerService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200);
});

// ── GET /lookup — ⌘K phone-search-to-act (editor+) ──────────────────────────

tenantTrackerRoutes.get("/lookup", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const parsed = tenantTrackerLookupQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);

  const result = await lookupPhoneService(session, parsed.data.phone);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200); // empty match → 200 []
});

// ── GET /agents — distinct raw agent labels (editor+) ───────────────────────

tenantTrackerRoutes.get("/agents", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const result = await listAgentLabelsService(session);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200);
});

// ── GET /summary — rail/header counts (editor+) ─────────────────────────────

tenantTrackerRoutes.get("/summary", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const result = await trackerSummaryService(session);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json(result.data, result.status as 200);
});

// ── GET /export.xlsx — flattened export (manager+; IC raw only for admin) ───

const EXPORT_COLUMNS: Array<{ header: string; key: keyof TrackerExportRow; width: number }> = [
  { header: "Property", key: "propertyName", width: 24 },
  { header: "Unit", key: "unitCode", width: 14 },
  { header: "Room", key: "room", width: 14 },
  { header: "Kind", key: "kind", width: 10 },
  { header: "Tenant", key: "tenantName", width: 24 },
  { header: "Phone", key: "phone", width: 16 },
  { header: "Email", key: "email", width: 26 },
  { header: "Gender", key: "gender", width: 8 },
  { header: "IC", key: "idNumber", width: 18 },
  { header: "Pax", key: "pax", width: 6 },
  { header: "Agent", key: "agentLabel", width: 14 },
  { header: "Access Card", key: "accessCardNo", width: 14 },
  { header: "Status", key: "status", width: 12 },
  { header: "Start Date", key: "startDate", width: 12 },
  { header: "End Date", key: "endDate", width: 12 },
  { header: "Monthly Rent", key: "monthlyRent", width: 13 },
  { header: "PIC", key: "picName", width: 20 },
];

tenantTrackerRoutes.get("/export.xlsx", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const parsed = exportQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);

  const result = await exportTrackerRowsService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Tenant Tracker");
  sheet.columns = EXPORT_COLUMNS;
  for (const row of result.data) sheet.addRow(row);

  const buffer = await workbook.xlsx.writeBuffer();
  c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  c.header("Content-Disposition", 'attachment; filename="tenant-tracker.xlsx"');
  // The export can carry raw ICs (admin column) — keep it out of every cache;
  // secureHeaders() sets no caching directives.
  c.header("Cache-Control", "no-store");
  // exceljs types writeBuffer() as its own ArrayBuffer alias, but at runtime
  // it returns a Node Buffer (a Uint8Array) — the cast bridges the typing
  // gap only.
  return c.body(buffer as unknown as Uint8Array<ArrayBuffer>);
});

// ── PATCH /:unitId/in-charge — assign/unassign the room PIC (editor+) ───────

tenantTrackerRoutes.patch("/:unitId/in-charge", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const unitId = c.req.param("unitId");
  if (!unitIdParamSchema.safeParse(unitId).success) {
    // Static message — never echo the supplied param.
    return c.json({ error: "Invalid unit id" }, 400);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = assignInChargeSchema.safeParse(body);
  if (!parsed.success) return zodBadRequest(c, parsed.error);

  const result = await assignInChargeService(session, unitId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data, result.status as 200);
});

// ── POST /ic-reveal — audited unmasked-IC reveal (manager+) ─────────────────

tenantTrackerRoutes.post("/ic-reveal", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = icRevealBodySchema.safeParse(body);
  if (!parsed.success) return zodBadRequest(c, parsed.error);

  const result = await recordIcRevealService(session, parsed.data.partyId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data, result.status as 200);
});

export { tenantTrackerRoutes };
