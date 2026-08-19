import { Hono } from "hono";
import { portalCsrfIfCookie, portalCacheControl, portalLoginRateLimiter, portalCsrf, portalUserTypeGuard } from "./portal.middleware";
import { portalAuthRoutes, portalAuthMiddleware } from "./auth";
import type { PortalEnv } from "./auth/portal.auth.types";
import { portalDashboardRoutes } from "./dashboard";
import { portalChargesRoutes } from "./charges";
import { portalPaymentsRoutes } from "./payments";
import { portalDocumentsRoutes, portalFileRoutes } from "./documents";
import { portalProfileRoutes } from "./profile";
import { portalCommissionsRoutes } from "./commissions";
import { portalTeamRoutes } from "./team";
import { portalListingsRoutes } from "./listings";
import { portalFinancialsRoutes } from "./financials";
import { portalStatementsRoutes } from "./statements";
import { portalOwnerDocsRoutes } from "./owner-docs";
import { portalOwnerLedgerRoutes } from "./owner-ledger";
import { portalOwnerStatementsRoutes } from "./owner-statements";
import { portalOwnerStatementsV2Routes } from "./owner/portal.owner-statements-v2.routes";
import { tenantIcRoutes } from "./tenant-ic/tenant-ic.routes";
import { portalProjectsRoutes } from "./projects";
import { portalSalesUnitsRoutes } from "./sales-units";
import { portalSalesClaimsRoutes } from "./sales-claims";
import { portalSalesEntriesRoutes } from "./sales-entries";
import { portalRenovationClaimsRoutes } from "./renovation-claims";
import { portalRenovationProgressRoutes } from "./renovation-progress";
import { portalRenovationStagesRoutes } from "./renovation-stages";
import { portalInventoryRoutes } from "./inventory";
import { portalRentalEntriesRoutes } from "./rental-entries";
import { portalAgentHomeRoutes } from "./agent-home";
import { portalPartiesRoutes } from "./parties";
import { portalMyCardRoutes } from "../portal-my-card";
import { reservationsRoutes } from "../reservations/routes";
import { agentReservationSessionAdapter } from "../reservations/session-adapter";
import { getDb } from "@kason/db";

const portalRoutes = new Hono();

// Global middleware for all portal routes (CORS handled by app.ts global middleware)
portalRoutes.use("*", portalCacheControl);

// Public routes (login) — CSRF + rate limiter, no auth
portalRoutes.use("/auth/login", portalCsrf);
portalRoutes.use("/auth/login", portalLoginRateLimiter);
portalRoutes.route("/auth", portalAuthRoutes);

// Protected routes — auth first (sets authMethod), then conditional CSRF
portalRoutes.use("*", portalAuthMiddleware);
portalRoutes.use("*", portalCsrfIfCookie);

// Lightweight session endpoint (protected — registered after auth middleware)
const portalProtected = new Hono<PortalEnv>();
portalProtected.get("/", async (c) => {
  const session = c.get("session");
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { mustChangePassword: true, status: true },
  });
  if (!user || user.status !== "active") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({
    data: {
      userId: session.userId,
      userType: session.userType,
      partyId: session.partyId,
      orgId: session.orgId,
      mustChangePassword: user.mustChangePassword,
    },
  });
});
portalRoutes.route("/auth/me", portalProtected);

// Tenant-only routes
portalRoutes.use("/charges/*", portalUserTypeGuard("tenant"));
portalRoutes.use("/payments/*", portalUserTypeGuard("tenant"));
portalRoutes.use("/documents/*", portalUserTypeGuard("tenant"));
portalRoutes.use("/files/*", portalUserTypeGuard("tenant"));

portalRoutes.route("/dashboard", portalDashboardRoutes);
portalRoutes.route("/charges", portalChargesRoutes);
portalRoutes.route("/payments", portalPaymentsRoutes);
portalRoutes.route("/documents", portalDocumentsRoutes);
portalRoutes.route("/files", portalFileRoutes);
portalRoutes.route("/profile", portalProfileRoutes);
portalRoutes.route("/announcements", portalDashboardRoutes);

// Agent-only routes
portalRoutes.use("/tenant-ic/*", portalUserTypeGuard("agent"));
portalRoutes.route("/tenant-ic", tenantIcRoutes);
portalRoutes.use("/commissions/*", portalUserTypeGuard("agent"));
portalRoutes.route("/commissions", portalCommissionsRoutes);
portalRoutes.use("/team/*", portalUserTypeGuard("agent"));
portalRoutes.route("/team", portalTeamRoutes);
portalRoutes.use("/listings/*", portalUserTypeGuard("agent"));
portalRoutes.route("/listings", portalListingsRoutes);

// Sales pipeline (W2a): Projects + SalesUnits — agent-only.
portalRoutes.use("/projects/*", portalUserTypeGuard("agent"));
portalRoutes.route("/projects", portalProjectsRoutes);
portalRoutes.use("/sales/*", portalUserTypeGuard("agent"));
// W2c: SalesClaims must mount BEFORE the sales-units router so /sales/claims
// is matched by the claims router rather than treated as a unit id.
portalRoutes.route("/sales/claims", portalSalesClaimsRoutes);
portalRoutes.route("/sales/units", portalSalesUnitsRoutes);
portalRoutes.route("/sales/entries", portalSalesEntriesRoutes);

// Renovation claims (W2b): Packages (read) + Claims (own-only) + uploads.
portalRoutes.use("/renovation/*", portalUserTypeGuard("agent"));
// Mount the more-specific renovation/progress + renovation/stages routers
// BEFORE the broader /renovation router (which handles /packages and
// /claims/...). Using the same pattern as /inventory/agent-listings vs
// /inventory.
portalRoutes.route("/renovation/progress", portalRenovationProgressRoutes);
portalRoutes.route("/renovation/stages", portalRenovationStagesRoutes);
portalRoutes.route("/renovation", portalRenovationClaimsRoutes);

// Unified-property-sourcing (2026-04-29 spec): agent creates rental Unit.
// Mirrors /portal-api/sales/units shape — own-only CRUD, source queue
// review, soft-delete withdraw. /properties helper for the form's picker.
portalRoutes.use("/inventory/*", portalUserTypeGuard("agent"));
// Mount rental-entries (atomic Rental Entry POST) BEFORE the broader
// /inventory router so the more-specific path is matched first. The
// existing /inventory router already exposes a POST /units, so we use
// /inventory/agent-listings here to avoid collision while keeping the
// agent-sourced semantics distinct from the older inventory shape.
portalRoutes.route("/inventory/agent-listings", portalRentalEntriesRoutes);
portalRoutes.route("/inventory", portalInventoryRoutes);

// Cross-domain agent home aggregator (read-only).
portalRoutes.use("/agent-home/*", portalUserTypeGuard("agent"));
portalRoutes.route("/agent-home", portalAgentHomeRoutes);

// Owner picker for Sales Entry drawer — agent-only.
portalRoutes.use("/parties/*", portalUserTypeGuard("agent"));
portalRoutes.route("/parties", portalPartiesRoutes);

// Agent E-Namecard — portal envelope (spec §6.2). Agent-only: tenants and
// owners do not have a card surface. The route handlers also re-check
// session.userType defensively.
portalRoutes.use("/my-card/*", portalUserTypeGuard("agent"));
portalRoutes.route("/my-card", portalMyCardRoutes);

// Reservations (agent surface). Adapter maps PortalSessionPayload to
// ReservationSession before the shared route handlers run.
portalRoutes.use("/reservations/*", portalUserTypeGuard("agent"));
portalRoutes.use("/reservations/*", agentReservationSessionAdapter);
portalRoutes.route("/reservations", reservationsRoutes);

// Owner-only routes
portalRoutes.use("/financials/*", portalUserTypeGuard("owner"));
portalRoutes.use("/statements/*", portalUserTypeGuard("owner"));
portalRoutes.use("/owner-docs/*", portalUserTypeGuard("owner"));
portalRoutes.use("/owner-ledger/*", portalUserTypeGuard("owner"));
// Distinct segment from /owner-ledger + /owner-docs — no route collision.
portalRoutes.use("/owner/*", portalUserTypeGuard("owner"));
// Phase-2 owner-statement live ledger (Task 8) — transactions (live) + frozen
// statements. Mounted at the DISTINCT /owner-live prefix (NOT /owner): the existing
// portalOwnerStatementsRoutes at /owner carries a `use("*")` gate keyed on
// ENABLE_PHASE2_OWNER_BILLING, and Hono applies that wildcard middleware to EVERY
// route sharing the /owner prefix — so mounting here at /owner would 404 these
// endpoints whenever owner-billing is dark, coupling this feature to another
// module's flag. A distinct sibling prefix keeps its own flag gate self-contained.
portalRoutes.use("/owner-live/*", portalUserTypeGuard("owner"));

portalRoutes.route("/financials", portalFinancialsRoutes);
portalRoutes.route("/statements", portalStatementsRoutes);
portalRoutes.route("/owner-docs", portalOwnerDocsRoutes);
// Phase-2 owner-billing: ledger read endpoints + property view (own-data-only).
// The ownerLedgerFlagGate inside the router handles flag-off → 404.
portalRoutes.route("/owner-ledger", portalOwnerLedgerRoutes);
// Phase-2 owner-billing: owner-scoped 5-section statement (Task 2c-4).
// GET /portal-api/owner/statements/:id/sections — own-data-only, flag-gated.
portalRoutes.route("/owner", portalOwnerStatementsRoutes);
// Phase-2 owner-statement live ledger (Task 8): GET /portal-api/owner-live/
// transactions + /statements(+/:id +/:id/pdf) — own-data-only, gated on
// ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (see the /owner-live guard note above).
portalRoutes.route("/owner-live", portalOwnerStatementsV2Routes);

export { portalRoutes };
