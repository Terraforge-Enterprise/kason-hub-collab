import { Hono, type Context } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { getActorHeaders } from "../../../lib/actor-ctx";
import { getDb } from "@kason/db";
import {
  createPortalPropertySchema,
  createPortalUnitSchema,
  createPortalUnitsBatchSchema,
  updatePortalPropertySchema,
  updatePortalUnitSchema,
} from "@kason/shared";
import {
  portalCancelOwnUnitService,
  portalCreateUnitService,
  portalCreateUnitsBatchService,
  portalGetApartmentsByPropertyService,
  portalListOwnUnitsService,
  portalUpdateOwnUnitService,
} from "./portal.inventory.service";
import {
  portalCancelOwnPropertyService,
  portalCreatePropertyService,
  portalGetOwnPropertyService,
  portalListOwnPropertiesService,
  portalUpdateOwnPropertyService,
} from "./portal.properties.service";
import { portalAmenitiesRoutes } from "./amenities";
import { portalPropertyTypesRoutes } from "./property-types";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalInventoryRoutes = new Hono<PortalEnv>();

portalInventoryRoutes.route("/amenities", portalAmenitiesRoutes);
portalInventoryRoutes.route("/property-types", portalPropertyTypesRoutes);

function actorCtx(c: Context<PortalEnv>) {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    partyId: session.partyId!,
    ip,
    userAgent,
  };
}

// Property picker for the portal unit-create form. Returns:
//   - all active properties in the org (admin-approved)
//   - PLUS the caller's own pending PropertySubmissions (so an agent who
//     just created a property can immediately attach a unit submission to
//     it while it's awaiting admin approval).
// Each row has `status` so the UI can render a "Pending" badge.
portalInventoryRoutes.get("/properties", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const db = getDb();
  const [active, pending] = await Promise.all([
    db.property.findMany({
      where: { organizationId: session.orgId, status: "active" },
      select: {
        id: true,
        name: true,
        propertyCode: true,
        status: true,
      },
      orderBy: { name: "asc" },
      take: 200,
    }),
    db.propertySubmission.findMany({
      where: {
        organizationId: session.orgId,
        sourcingAgentId: session.partyId,
        submissionState: { in: ["pending", "needs_amendment"] },
      },
      select: {
        id: true,
        proposedName: true,
        propertyCode: true,
        submissionState: true,
      },
      orderBy: { proposedName: "asc" },
      take: 200,
    }),
  ]);

  // Shape the two sources into one list so the SPA can render them
  // together. Submission rows carry `submissionId` so the form can attach
  // unit submissions via `propertySubmissionId` until the property approves.
  const data = [
    ...active.map((p) => ({
      id: p.id,
      name: p.name,
      propertyCode: p.propertyCode,
      status: p.status,
      sourcingApproved: true,
      submissionId: null as string | null,
    })),
    ...pending.map((s) => ({
      id: null as string | null,
      name: s.proposedName,
      propertyCode: s.propertyCode,
      status: s.submissionState,
      sourcingApproved: false,
      submissionId: s.id,
    })),
  ];
  return c.json({ data });
});

// Portal property creation -> PropertySubmission.
portalInventoryRoutes.post("/properties", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createPortalPropertySchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await portalCreatePropertyService(actorCtx(c), parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// Agent's own property submissions, every state. Used by the portal's My
// Uploads → Properties tab as the lifecycle view. The picker in
// inventory-create-page.tsx (which calls the same endpoint) filters
// client-side to only show pending / needs_amendment rows it can attach
// units to.
portalInventoryRoutes.get("/properties/own", async (c) => {
  const data = await portalListOwnPropertiesService(actorCtx(c));
  return c.json({ data });
});

// Single PropertySubmission detail scoped to the calling agent. Used by
// the property-edit page to prefill the form. 404s on cross-agent reads
// (no information leak).
portalInventoryRoutes.get("/properties/own/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Invalid submission id" }, 400);
  const result = await portalGetOwnPropertyService(actorCtx(c), id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Edit & resubmit. Allowed only while submissionState ∈ {pending,
// needs_amendment}; resubmit flips state back to pending and clears
// amendmentNote so admin re-reviews from scratch.
portalInventoryRoutes.patch("/properties/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Invalid submission id" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = updatePortalPropertySchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await portalUpdateOwnPropertyService(actorCtx(c), id, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data });
});

// Withdraw — soft-cancel a pending / needs_amendment PropertySubmission.
// 409 with PROPERTY_HAS_PENDING_UNITS when child UnitSubmissions are still
// pending — agent must withdraw those first. Spec §4.8 Option B.
portalInventoryRoutes.delete("/properties/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Invalid submission id" }, 400);
  const result = await portalCancelOwnPropertyService(actorCtx(c), id);
  if (!result.ok) {
    if (result.status === 409 && result.error === "PROPERTY_HAS_PENDING_UNITS") {
      return c.json(
        { error: result.error, blockingUnitIds: result.blockingUnitIds },
        409,
      );
    }
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data });
});

// Agent's own unit submissions (pending + needs_amendment + approved +
// rejected; excludes withdrawn).
portalInventoryRoutes.get("/units", async (c) => {
  const data = await portalListOwnUnitsService(actorCtx(c));
  return c.json({ data });
});

portalInventoryRoutes.post("/units", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createPortalUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await portalCreateUnitService(actorCtx(c), parsed.data);
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    return c.json({ error: result.error }, result.status as 400 | 404);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// Apartment-grouped view of a property — used by the portal create page's
// +Rooms typeahead to detect existing apartments. Filtered by agent
// visibility (sees apartments that have at least one Listing the agent has
// visibility on).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
portalInventoryRoutes.get(
  "/apartments/by-property/:propertyId",
  async (c) => {
    const propertyId = c.req.param("propertyId");
    if (!UUID_RE.test(propertyId)) {
      return c.json({ error: "Invalid property id" }, 400);
    }
    const result = await portalGetApartmentsByPropertyService(
      actorCtx(c),
      propertyId,
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 404);
    }
    return c.json({ data: result.data });
  },
);

// Multi-room batch — N submissions sharing one apartment-shared payload.
// Registered BEFORE /units/:id so the literal /batch path isn't matched as
// an id.
portalInventoryRoutes.post("/units/batch", async (c) => {
  const session = c.get("session");
  if (!session.partyId) {
    return c.json({ error: "AGENT_PROFILE_MISSING" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createPortalUnitsBatchSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await portalCreateUnitsBatchService(actorCtx(c), parsed.data);
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    return c.json(
      { error: result.error },
      result.status as 400 | 403 | 404 | 409,
    );
  }
  return c.json({ data: result.data }, result.status as 201);
});

// NOTE: The legacy portal /units/:propertyId/:unitCode/flip-listing-mode
// route is intentionally removed in the three-table refactor. Listing-mode
// is now an Apartment-row column flipped via the admin
// `flipApartmentModeService` (admin-only operation). Portal agents do not
// flip listing-mode anymore.

portalInventoryRoutes.patch("/units/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  // The portal validator omits server-controlled fields. updatePortalUnitSchema
  // requires unitId in the body — inject it from the URL param so portal
  // callers don't have to repeat it.
  const parsed = updatePortalUnitSchema.safeParse({
    ...body,
    unitId: c.req.param("id"),
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const { unitId, ...rest } = parsed.data;
  const result = await portalUpdateOwnUnitService(actorCtx(c), unitId, rest);
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  }
  return c.json({ data: result.data });
});

// Withdraw — soft-cancel a pending / needs_amendment UnitSubmission.
portalInventoryRoutes.delete("/units/:id", async (c) => {
  const result = await portalCancelOwnUnitService(
    actorCtx(c),
    c.req.param("id"),
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data });
});

export { portalInventoryRoutes };
