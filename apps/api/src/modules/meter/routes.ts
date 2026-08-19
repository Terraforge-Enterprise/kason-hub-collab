import { Hono } from "hono";
import type { Context } from "hono";
import { z, type ZodError } from "zod";
import {
  billingGridQuerySchema,
  chargeUtilityBillSchema,
  cockpitQuerySchema,
  createMeterSchema,
  createReadingSchema,
  createUtilityBillSchema,
  meterListQuerySchema,
  readingListQuerySchema,
  setTenancyPaxSchema,
  updateMeterSchema,
  updateReadingSchema,
  updateUtilityBillSchema,
  utilityBillListQuerySchema,
  voidReasonBody,
} from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireRole } from "../../middleware/require-role";
import {
  attachBillAttachmentsService,
  chargeUtilityBillService,
  createMeterService,
  createReadingService,
  createUtilityBillService,
  detachBillAttachmentService,
  getAllocationService,
  getBillingGridService,
  getCockpitService,
  getMeterService,
  getReadingService,
  getUtilityBillService,
  listBillAttachmentsService,
  listMetersService,
  listReadingsService,
  listUtilityBillsService,
  previewUtilityBillService,
  setMeterActiveService,
  setTenancyPaxService,
  updateMeterService,
  updateReadingService,
  updateUtilityBillService,
  voidReadingService,
  voidUtilityBillService,
} from "./service";

const meterRoutes = new Hono<{ Variables: { session: SessionPayload } }>();
const idParam = z.string().uuid();

// ── Feature-flag gate (FIRST — before requireRole; canonical 404 even unauth) ─
meterRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_METER")) return c.json({ error: "not_found" }, 404);
  await next();
});

function zodBadRequest(c: Context, error: ZodError) {
  const friendly = formatZodError(error, { domain: "tenancy" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}
function badId(c: Context) {
  return c.json({ error: "Invalid id" }, 400);
}

// ── AircondMeter ────────────────────────────────────────────────────────────
meterRoutes.post("/", requireRole("manager"), async (c) => {
  const session = c.get("session");
  const parsed = createMeterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await createMeterService(session, parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 422);
  return c.json(r.data, r.status as 201);
});
meterRoutes.get("/", requireRole("editor"), async (c) => {
  const session = c.get("session");
  const parsed = meterListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await listMetersService(session, parsed.data);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});
// NOTE: the bare "/:id" AircondMeter routes (detail/update/retire/restore)
// are registered LAST (see end of file). Hono matches in REGISTRATION ORDER, so
// "/:id" MUST come AFTER the static "/readings" + "/utility-bills" sub-resources
// — otherwise GET /utility-bills matches "/:id" (id="utility-bills") → 400.

// ── MeterReading ────────────────────────────────────────────────────────────
meterRoutes.post("/readings", requireRole("editor"), async (c) => {
  const parsed = createReadingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await createReadingService(c.get("session"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 422);
  return c.json(r.data, r.status as 201);
});
meterRoutes.get("/readings", requireRole("editor"), async (c) => {
  const parsed = readingListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await listReadingsService(c.get("session"), parsed.data);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});
meterRoutes.get("/readings/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await getReadingService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});
meterRoutes.patch("/readings/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = updateReadingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await updateReadingService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 422);
  return c.json(r.data, 200);
});
meterRoutes.post("/readings/:id/void", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await voidReadingService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, 200);
});

// ── UnitUtilityBill ─────────────────────────────────────────────────────────
meterRoutes.post("/utility-bills", requireRole("editor"), async (c) => {
  const parsed = createUtilityBillSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await createUtilityBillService(c.get("session"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, r.status as 201);
});
meterRoutes.get("/utility-bills", requireRole("editor"), async (c) => {
  const parsed = utilityBillListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await listUtilityBillsService(c.get("session"), parsed.data);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});
meterRoutes.get("/utility-bills/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await getUtilityBillService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});
meterRoutes.patch("/utility-bills/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = updateUtilityBillSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await updateUtilityBillService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, 200);
});
meterRoutes.post("/utility-bills/:id/preview", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await previewUtilityBillService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 422);
  return c.json(r.data, 200);
});
meterRoutes.post("/utility-bills/:id/charge", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = chargeUtilityBillSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await chargeUtilityBillService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 422);
  return c.json(r.data, 200);
});
meterRoutes.post("/utility-bills/:id/void", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  // Spec §4.3: reason mandatory (min 3) on every void surface once
  // ENABLE_PHASE2_BILLING_DOCS is on. Flag-dark keeps the body-less contract.
  let input: { reason?: string } | undefined;
  if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    const parsed = voidReasonBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return zodBadRequest(c, parsed.error);
    input = parsed.data;
  }
  const r = await voidUtilityBillService(c.get("session"), c.req.param("id"), input);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, 200);
});

// ── Bill attachments (draft-bill uploads, e.g. the TNB/AirSelangor PDF) ──────
// Nested under "/utility-bills/:id/...", registered alongside the bill's other
// sub-routes above — well before the bare "/:id" AircondMeter routes at the end
// of the file, so the ordering caveat there doesn't apply here. Attach/detach
// = manager (money-adjacent); list = editor (read).
meterRoutes.post("/utility-bills/:id/attachments", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);
  const uploads = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  const files = await Promise.all(
    uploads.map(async (file) => ({ filename: file.name, mimeType: file.type, content: Buffer.from(await file.arrayBuffer()) })),
  );
  const r = await attachBillAttachmentsService(c.get("session"), c.req.param("id"), files);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 404 | 409);
  return c.json(r.data, r.status as 201);
});
meterRoutes.get("/utility-bills/:id/attachments", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await listBillAttachmentsService(c.get("session"), c.req.param("id"));
  return c.json(r.ok ? { data: r.data } : { error: r.error }, r.status as 200);
});
meterRoutes.delete("/utility-bills/:id/attachments/:attId", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("attId")).success) return badId(c);
  const r = await detachBillAttachmentService(c.get("session"), c.req.param("attId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json({ ok: true }, 200);
});

meterRoutes.get("/allocations/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await getAllocationService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});

// ── Billing grid ─────────────────────────────────────────────────────────────
meterRoutes.get("/apartments/:apartmentId/billing-grid", requireRole("editor"), async (c) => {
  const parsed = billingGridQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await getBillingGridService(c.get("session"), c.req.param("apartmentId"), parsed.data.period);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});

// ── Tenancy pax (billing headcount) ────────────────────────────────────────────
// PATCH /tenancies/:tenancyId/pax — set Tenancy.numberOfPax inline from the bill
// workspace so a paxless tenant becomes billable. Editor-OK (mirrors the
// editor-gated assign-PIC + reading-update mutations — it edits occupancy data,
// not money). Registered BEFORE the bare "/:id" routes (Hono matches in
// registration order) so "tenancies" is never matched as id="tenancies".
meterRoutes.patch("/tenancies/:tenancyId/pax", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("tenancyId")).success) return badId(c);
  const parsed = setTenancyPaxSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await setTenancyPaxService(c.get("session"), c.req.param("tenancyId"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});

// ── Month cockpit ─────────────────────────────────────────────────────────────
// Portfolio-wide, read-only billing-progress + reconciliation worklist for the
// session org + period (§4.1/§4.6). Registered BEFORE the bare "/:id" routes so
// "/cockpit" is not matched as id="cockpit". Gated by the meter flag (router-
// level gate above) — flag-off returns the canonical 404, so the cockpit
// affordances simply don't exist when meter is dark (spec §7).
meterRoutes.get("/cockpit", requireRole("editor"), async (c) => {
  const parsed = cockpitQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await getCockpitService(c.get("session"), parsed.data.period);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});

// ── AircondMeter detail/update — bare "/:id" routes registered LAST so the
// static "/readings" + "/utility-bills" + "/allocations" sub-resources above are
// matched first (Hono matches in registration order). ────────────────────────
meterRoutes.get("/:id", requireRole("editor"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await getMeterService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});
meterRoutes.patch("/:id", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = updateMeterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await updateMeterService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, 200);
});
meterRoutes.post("/:id/retire", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await setMeterActiveService(c.get("session"), c.req.param("id"), false);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});
meterRoutes.post("/:id/restore", requireRole("manager"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await setMeterActiveService(c.get("session"), c.req.param("id"), true);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, 200);
});

export { meterRoutes };
