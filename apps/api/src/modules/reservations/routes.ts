import { Hono } from "hono";
import { z } from "zod";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  adminEditReservationSchema,
  approveReservationSchema,
  cancelReservationSchema,
  createReservationSchema,
  rejectReservationSchema,
  resubmitReservationSchema,
} from "./validation";
import {
  adminEditAfterSigningService,
  approveReservationService,
  cancelReservationService,
  createReservationService,
  getLinkedSignedReservationService,
  getReservationEditHistory,
  getReservationForOrg,
  getUnsignedReservationPdfService,
  listEligibleUnitsForAgent,
  listPickableReservationsService,
  listReservationsForAgent,
  listReservationsForOrg,
  rejectReservationService,
  resubmitReservationService,
} from "./service";
import type { ReservationSession } from "./types";
import { convertReservationToTenancy } from "../tenancy/convert-reservation.service";

export const reservationsRoutes = new Hono<{ Variables: { session: ReservationSession } }>();

reservationsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const status = c.req.query("status") ?? undefined;

  const data =
    session.role === "agent"
      ? await listReservationsForAgent(session.orgId, session.partyId)
      : await listReservationsForOrg(session.orgId, status);
  return c.json({ data });
});

// Picker source for the agent portal's "new reservation" form. Returns the
// units the requesting agent is allowed to reserve against — active listings
// flagged readyNow, filtered through the visibility rules. Registered BEFORE
// the `/:id` route so the literal path is not captured by the param matcher.
reservationsRoutes.get("/eligible-units", async (c) => {
  const session = c.get("session");
  if (session.role !== "agent") {
    return c.json({ error: "Agent-only endpoint" }, 403);
  }
  const data = await listEligibleUnitsForAgent(session.orgId, session.partyId);
  return c.json({ data });
});

// Picker source for the tenant-create "from reservation" flow (T3/T5+).
// Returns SIGNED reservations not yet linked to a tenant (tenantPartyId IS
// NULL), NRIC masked. Any operator may read (incl. viewer) — this is a
// read-only listing. Registered BEFORE the `/:id` route, same as
// `/eligible-units`, so the literal path is not captured by the param
// matcher.
reservationsRoutes.get("/pickable", async (c) => {
  const session = c.get("session");
  const data = await listPickableReservationsService(session);
  return c.json({ data });
});

// Tenant-driven auto-derive source (T13/R5). Resolves the signed,
// not-yet-converted reservation linked to a SPECIFIC tenant Party, so the web
// assign form can derive tenancy terms from the reservation actually linked
// to the selected tenant instead of a free-pick select. Read-only, any
// operator (incl. viewer) — same access as /pickable. Registered BEFORE the
// `/:id` route, same reasoning as `/eligible-units` and `/pickable`, so the
// literal path segment isn't captured by the param matcher.
reservationsRoutes.get("/linked-to-tenant/:tenantPartyId", async (c) => {
  const session = c.get("session");
  const data = await getLinkedSignedReservationService(session, c.req.param("tenantPartyId"));
  return c.json({ data });
});

reservationsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const data = await getReservationForOrg(session.orgId, c.req.param("id"), session);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ data });
});

// Returns a short-TTL signed view URL for one admin-uploaded ID scan
// (documents.service.ts, Task 3). PII-sensitive — the underlying object is a
// passport/IC scan.
// The admin adapter flattens admin/manager/editor/viewer all to role:"admin"
// (session-adapter.ts:18), so `role` CANNOT distinguish a viewer. The real
// role is in `operatorRole`, which is undefined for a viewer AND for a portal
// agent (agentReservationSessionAdapter sets no operatorRole). Gating on
// `!session.operatorRole` therefore 403s both viewers and agents — only
// admin/manager/editor may fetch a signed URL to an ID scan (spec R4).
reservationsRoutes.get("/:id/documents/:docId/view-url", async (c) => {
  const session = c.get("session");
  if (!session.operatorRole) return c.json({ error: "Forbidden" }, 403);
  // Validate the uuid path params before they reach Prisma — a non-uuid value
  // against a uuid column throws P2023, which would fall through to the generic
  // 500 handler (same guard as /convert-to-tenancy below). Authz is checked
  // first so an unauthorized caller still gets 403, not a shape hint.
  const idParse = z.string().uuid().safeParse(c.req.param("id"));
  const docIdParse = z.string().uuid().safeParse(c.req.param("docId"));
  if (!idParse.success || !docIdParse.success) {
    return c.json({ error: "Invalid id", code: "INVALID_ID" }, 400);
  }
  const { getReservationDocViewUrlForAdmin } = await import("./documents.service");
  const result = await getReservationDocViewUrlForAdmin(
    session.orgId,
    idParse.data,
    docIdParse.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

reservationsRoutes.get("/:id/unsigned-pdf", async (c) => {
  const session = c.get("session");
  const result = await getUnsignedReservationPdfService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return new Response(new Uint8Array(result.pdf), {
    status: result.status,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

// Converts a signed reservation into an active Tenancy (T7 service). Admin
// portal only (also mounted on the agent portal per session-adapter.ts,
// where the missing `operatorRole` 403s agents just the same). The viewer
// gate checks `!session.operatorRole`, NOT `session.role` -- the admin
// adapter flattens admin/manager/editor/viewer all to `role: "admin"`, so
// `role` can never distinguish a viewer here.
reservationsRoutes.post("/:id/convert-to-tenancy", async (c) => {
  const session = c.get("session");
  if (!session.operatorRole) return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  // Reservation id is read from the path, not the JSON body -- validate it
  // BEFORE the body parse so a malformed `:id` never reaches Prisma (a
  // non-uuid string against a uuid column throws P2023, which neither
  // mapTenancyP2002 nor the tagged-error unwrap in
  // convert-reservation.service.ts catches, so it used to fall through to
  // the generic 500 handler).
  const reservationIdParse = z.string().uuid().safeParse(c.req.param("id"));
  if (!reservationIdParse.success) {
    return c.json({ error: "Reservation id is invalid", code: "RESERVATION_ID_INVALID" }, 400);
  }
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const body = json as {
    tenantPartyId?: string;
    overwrite?: boolean;
    tenancyCode?: string;
    carparks?: Array<{ carparkId: string; monthlyCharge?: string }>;
  };
  const tenantPartyIdParse = z.string().uuid().safeParse(body?.tenantPartyId);
  if (!tenantPartyIdParse.success) {
    return c.json({ error: "tenantPartyId is required", code: "TENANT_PARTY_INVALID" }, 400);
  }
  const result = await convertReservationToTenancy(
    { orgId: session.orgId, userId: session.userId, role: session.operatorRole },
    {
      reservationId: reservationIdParse.data,
      tenantPartyId: tenantPartyIdParse.data,
      overwrite: body.overwrite,
      tenancyCode: body.tenancyCode,
      carparks: body.carparks,
    },
  );
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        code: result.code,
        ...("incumbent" in result && result.incumbent ? { incumbent: result.incumbent } : {}),
        ...("existingTenancyId" in result ? { existingTenancyId: result.existingTenancyId } : {}),
      },
      // ConvertResult's false branch types `status` as a plain `number` (not
      // narrowed per-code), so Hono's ContentfulStatusCode overload needs an
      // explicit cast -- same idiom as renovation-claims.routes.ts. The union
      // covers every status the service (and the carpark-assign tagged-error
      // unwrap it delegates to) can actually return.
      result.status as 400 | 404 | 409 | 422,
    );
  }
  return c.json({ data: result.data }, 201);
});

reservationsRoutes.post("/", async (c) => {
  const session = c.get("session");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = createReservationSchema.safeParse(json);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await createReservationService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data }, result.status);
});

reservationsRoutes.put("/:id/cancel", async (c) => {
  const session = c.get("session");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = cancelReservationSchema.safeParse(json);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await cancelReservationService(
    session,
    c.req.param("id"),
    parsed.data.cancelReason,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

reservationsRoutes.put("/:id/approve", async (c) => {
  const session = c.get("session");
  const result = await approveReservationService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

reservationsRoutes.put("/:id/reject", async (c) => {
  const session = c.get("session");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = rejectReservationSchema.safeParse(json);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await rejectReservationService(session, c.req.param("id"), parsed.data.note);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

reservationsRoutes.put("/:id/resubmit", async (c) => {
  const session = c.get("session");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = resubmitReservationSchema.safeParse(json);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  // IP + UA flow through to the audit-log row when the agent edits a
  // signed reservation (D2). Other resubmit paths don't write AuditLog,
  // so the values are simply ignored on those branches.
  const ip = c.req.header("x-forwarded-for") ?? undefined;
  const userAgent = c.req.header("user-agent") ?? undefined;
  const result = await resubmitReservationService(session, c.req.param("id"), parsed.data, {
    ip,
    userAgent,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

// Admin-only edit for already-signed reservations (spec §5.3).
// Writes ONE AuditLog row per edit with action=admin_edit_after_signing,
// before/after diff, and meta.reason — the admin's mandatory ≥10-char reason.
// Status remains "signed"; the customer's customTerms / signed-PDF blob are
// out of scope (legal record). Friendly Zod errors via formatZodError so the
// "Reason ≥10 chars" rule surfaces clearly to the admin.
reservationsRoutes.patch("/:id/admin-edit", async (c) => {
  const session = c.get("session");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = adminEditReservationSchema.safeParse(json);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const ip = c.req.header("x-forwarded-for") ?? undefined;
  const userAgent = c.req.header("user-agent") ?? undefined;
  const result = await adminEditAfterSigningService(session, c.req.param("id"), {
    ...parsed.data,
    ip,
    userAgent,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

reservationsRoutes.get("/:id/edit-history", async (c) => {
  const session = c.get("session");
  const result = await getReservationEditHistory(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});
