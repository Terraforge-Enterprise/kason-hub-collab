import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { createClaimSchema, saveDraftSchema, updateDraftSchema, taTierLookupQuerySchema } from "@kason/shared";
import {
  portalClaimCreateLimiter,
  portalClaimSubmitLimiter,
} from "../portal.middleware";
import { existingClaimsOnKeyRoutes } from "./existing-claims-on-key.routes";
import {
  dashboardService, listClaimsService, getClaimService,
  submitClaimService, deleteClaimService,
  cancelClaimService,
  tierMappingLookupService, searchPropertiesService,
  createAndSubmitClaimService, updateDraftService, saveDraftService,
  listRoomTypesService,   // NEW
  amendClaimService,
  taTierLookupService,
  taTierOptionsService,
} from "./portal.commissions.service";
import { getActorHeaders } from "../../../lib/actor-ctx";
import { formatZodError } from "../../../lib/zod-error-mapper";
import { getRentalCommissionClaimPdfService } from "../../commissions/commissions.service";

const portalCommissionsRoutes = new Hono<PortalEnv>();

portalCommissionsRoutes.get("/dashboard", async (c) => {
  const session = c.get("session");
  const data = await dashboardService(session);
  return c.json({ data });
});

portalCommissionsRoutes.get("/claims", async (c) => {
  const session = c.get("session");
  const result = await listClaimsService(session, c.req.query());
  return c.json(result);
});

// POST /claims = Save as Draft (permissive). Only propertyId is required;
// other fields default server-side. Rules B/C apply only at submit time.
portalCommissionsRoutes.post("/claims", portalClaimCreateLimiter, async (c) => {
  const session = c.get("session");
  const parsed = saveDraftSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await saveDraftService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 409 | 422 | 500);
  return c.json({ data: result.data }, result.status as 201);
});

portalCommissionsRoutes.get("/claims/:id", async (c) => {
  const session = c.get("session");
  const result = await getClaimService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Same server-side puppeteer pipeline as the admin route. The shared service
// already enforces agent self-only auth — we pass the portal session through
// shaped as a CommissionsSession.
portalCommissionsRoutes.get("/claims/:id/pdf", async (c) => {
  const session = c.get("session");
  const result = await getRentalCommissionClaimPdfService(
    {
      userId: session.userId,
      orgId: session.orgId,
      role: "agent",
      partyId: session.partyId,
    },
    c.req.param("id"),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 403 | 404);
  return new Response(new Uint8Array(result.pdf), {
    status: result.status,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
});

portalCommissionsRoutes.post("/claims/:id/submit", portalClaimSubmitLimiter, async (c) => {
  const session = c.get("session");
  const result = await submitClaimService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  return c.json({ data: result.data });
});

// Atomic create-and-submit: skip the draft step. Serializable tx inside the
// service guarantees Rules A/B/C hold at commit time.
portalCommissionsRoutes.post("/claims/submit", portalClaimSubmitLimiter, async (c) => {
  const session = c.get("session");
  const parsed = createClaimSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createAndSubmitClaimService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 409 | 422 | 500);
  return c.json({ data: result.data }, result.status as 201);
});

portalCommissionsRoutes.patch("/claims/:id", async (c) => {
  const session = c.get("session");
  const parsed = updateDraftSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "commission" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateDraftService(session, c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409 | 422 | 500);
  return c.json({ data: result.data });
});

portalCommissionsRoutes.delete("/claims/:id", async (c) => {
  const session = c.get("session");
  const result = await deleteClaimService(session, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// Agent withdraws a submitted claim before admin reviews it. State machine
// gates submitted→cancelled (agent_owner only); admin actions stay unaffected.
portalCommissionsRoutes.post("/claims/:id/cancel", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const result = await cancelClaimService(session, c.req.param("id"), {
    ...getActorHeaders(c),
    actorRole: "agent",
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  return c.json({ data: result.data });
});

portalCommissionsRoutes.get("/tier-mapping", async (c) => {
  const session = c.get("session");
  const claimType = c.req.query("claimType");
  if (!claimType) return c.json({ error: "claimType query parameter is required" }, 400);
  const result = await tierMappingLookupService(session, claimType);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

portalCommissionsRoutes.get("/ta-tier", async (c) => {
  const session = c.get("session");
  const parsed = taTierLookupQuerySchema.safeParse({
    monthlyRental: c.req.query("monthlyRental"),
  });
  if (!parsed.success) {
    return c.json({ error: "monthlyRental query param required" }, 400);
  }
  const res = await taTierLookupService(session, parsed.data);
  if (!res.ok) return c.json({ error: res.error }, res.status as 404);
  return c.json({ data: res.data }, 200);
});

portalCommissionsRoutes.get("/ta-tier-options", async (c) => {
  const session = c.get("session");
  const res = await taTierOptionsService(session);
  return c.json({ data: res.data }, 200);
});

portalCommissionsRoutes.get("/properties", async (c) => {
  const data = await searchPropertiesService(c.get("session"), c.req.query("q"));
  return c.json({ data });
});

portalCommissionsRoutes.get("/room-types", async (c) => {
  const data = await listRoomTypesService(c.get("session"));
  return c.json({ data });
});

// Agent amend-after-approve. Route-level guard: agent userType only (operators
// and non-agent portal users are 403'd here rather than at the service). The
// service then applies its own owner-scoping (`agentPartyId === session.partyId`)
// so even an agent with a valid session cannot amend another agent's claim.
portalCommissionsRoutes.patch("/claims/:id/amend", async (c) => {
  const session = c.get("session");
  if (session.userType !== "agent") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const result = await amendClaimService(session, c.req.param("id"), body, {
    ...getActorHeaders(c),
    actorRole: "agent",
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409 | 422 | 500);
  }
  return c.json({ data: result.data });
});

portalCommissionsRoutes.route("/claims", existingClaimsOnKeyRoutes);

export { portalCommissionsRoutes };
