import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getDb } from "@kason/db";
import { authMiddleware } from "./middleware/auth";
import { ClosedPeriodError, toClosedPeriodBody } from "./modules/owner-ledger/closed-period";
import { accountantScope } from "./middleware/accountant-scope";
import { noStore } from "./middleware/cache-control";
import { adminCsrfIfCookie } from "./modules/auth/admin.middleware";
import { requestLogger } from "./middleware/request-logger";
import { authRoutes } from "./modules/auth";
import { billingRoutes } from "./modules/billing";
import { chargeCategoriesRoutes } from "./modules/charge-categories";
import { inventoryRoutes } from "./modules/inventory";
import { apartmentRoutes } from "./modules/inventory/apartment.routes";
import { carparkRoutes } from "./modules/carpark";
import { amenitiesRoutes } from "./modules/inventory/amenities";
import { workCategoriesRoutes } from "./modules/inventory/work-categories";
import { propertyTypesRoutes } from "./modules/inventory/property-types";
import { listingsRoutes } from "./modules/listings";
import { tenantTrackerRoutes } from "./modules/tenant-tracker";
import { meterRoutes } from "./modules/meter";
import { utilityBillingConfigRoutes } from "./modules/utility-billing-config";
import { featureFlagsRoutes } from "./modules/feature-flags";
import { billsGridRoutes } from "./modules/bills-grid";
import { dataImportRoutes } from "./modules/data-import";
import { projectsRoutes } from "./modules/projects";
import { salesRoutes } from "./modules/sales";
import { sourceQueueRoutes } from "./modules/source-queue";
import { salesClaimsRoutes } from "./modules/sales-claims";
import { renovationRoutes } from "./modules/renovation-claims";
import { renovationSettingsRoutes } from "./modules/renovation-settings";
import { renovationStagesRoutes } from "./modules/renovation-stages";
import { salesClaimDefaultsRoutes } from "./modules/sales-claim-defaults";
import { partiesRoutes } from "./modules/parties";
import { tasksRoutes, ticketsRoutes, unitScopedTasksRoutes, analyticsRoutes, sprintsRoutes } from "./modules/tasks";
import { ownerBillingRoutes } from "./modules/owner-billing";
import { ownerLedgerRoutes } from "./modules/owner-ledger";
import { ownerRemittanceRoutes, ownerReceivableOffsetRoutes } from "./modules/owner-remittance";
import { reconciliationRoutes } from "./modules/owner-ledger/reconciliation/reconciliation.routes";
import { billingDocumentsRoutes } from "./modules/billing-documents";
import { expensesRoutes } from "./modules/expenses";
import { ownerFundingRequestsRoutes } from "./modules/owner-funding-requests";
import { usersRoutes } from "./modules/users";
import { organizationCardSettingsRoutes } from "./modules/organization-card-settings";
import { organizationRoutes } from "./modules/organization";
import { agentCardsRoutes } from "./modules/agent-cards";
import { profileRoutes } from "./modules/profile";
import { tenancyRoutes } from "./modules/tenancy";
import { paymentsRoutes } from "./modules/payments";
import { communicationsRoutes } from "./modules/communications";
import { dashboardRoutes } from "./modules/dashboard";
import { portalRoutes } from "./modules/portal";
import { commissionsRoutes } from "./modules/commissions";
import levelThresholdsRoutes from "./modules/commissions/level-thresholds.routes";
import { auditRoutes } from "./modules/audit";
import { publicCardRoutes } from "./modules/public-card";
import { adminTenantIcRoutes } from "./modules/admin/tenant-ic.routes";
import { adminRenovationClaimsRoutes } from "./modules/admin/renovation-claims.routes";
import { documentTemplatesRoutes } from "./modules/document-templates/routes";
import { reservationsRoutes } from "./modules/reservations/routes";
import { publicReservationsRoutes } from "./modules/reservations/public.routes";
import { adminReservationSessionAdapter } from "./modules/reservations/session-adapter";
import { mountWhatsAppWebhook } from "./modules/webhooks/whatsapp.routes";
import { mountFpxWebhook } from "./modules/webhooks/fpx.routes";
import { runtimeConfig } from "./lib/runtime-config";

const app = new Hono();

// Request logging — must be first middleware for accurate timing
app.use("*", requestLogger);

app.use(
  "*",
  cors({
    origin: runtimeConfig.corsOrigins,
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Without this the browser uses the Fetch-spec default of FIVE SECONDS, so
    // the admin SPA (CloudFront origin) re-preflights the API (Lightsail origin)
    // on essentially every call — two requests per click instead of one, against
    // a container that measurably serialises under concurrency (UAT, 2026-08-17:
    // /health 58ms at 1 concurrent request, 290ms at 16).
    //
    // 7200 = Chrome's hard cap; larger values are silently clamped there, and
    // Safari's cap is lower still. This is a MITIGATION, not the fix: the real
    // fix is serving /api/* from the SPA's own origin, after which no preflight
    // happens at all. Note the trade-off while it stands — tightening any CORS
    // rule (revoking an origin, dropping an allowed header) takes up to this
    // long to reach browsers that already cached the permissive answer.
    maxAge: 7200,
  }),
);
app.use("*", secureHeaders());

app.get("/health", async (c) => {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return c.json({ ok: true, service: "kason-api", version: "0.2.0" });
  } catch (err) {
    return c.json(
      { ok: false, service: "kason-api", version: "0.2.0", error: "db unreachable" },
      503,
    );
  }
});

// Portal API — separate auth (httpOnly cookies), mounted BEFORE admin auth middleware
app.route("/portal-api", portalRoutes);

// Public agent-card API — NO AUTH AT ALL. Mounted BEFORE the /api/* admin
// auth middleware so requests never touch authMiddleware. The sub-app
// itself is gated by FEATURE_AGENT_NAMECARD; while off, every request
// returns the canonical 404. Per spec §6.3, §6.4, §9.1.
app.route("/public-api/card", publicCardRoutes);

// Public reservation routes — token-gated, no auth middleware. Mounted
// before admin auth so unauth public PUT/POST never hits authMiddleware.
app.route("/public-api/reservations", publicReservationsRoutes);

// No-store for the whole admin API surface. Mounted BEFORE /api/auth on
// purpose: the login response carries the session token in its body, and it is
// the single response on this API that must never be held by a shared cache.
app.use("/api/*", noStore);

// Public auth endpoints
app.route("/api/auth", authRoutes);

// CSRF protection for admin cookie-based auth
app.use("/api/*", adminCsrfIfCookie);

// Protected API surface
app.use("/api/*", authMiddleware);
app.use("/api/*", accountantScope); // default-deny wall for the accountant (runs after auth sets session)
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/billing", billingRoutes);
// ChargeCategory registry + DocumentSeries (accounting-docs P1) — mounted
// UNCONDITIONALLY; the router's first middleware gates every request on
// ENABLE_PHASE2_BILLING_DOCS (canonical 404 while dark, owner-ledger precedent).
app.route("/api/charge-categories", chargeCategoriesRoutes);
// Internal Expense (EXP-) — accounting-doc redesign P3. Mounted UNCONDITIONALLY;
// the router's first middleware 404s every request while ENABLE_SUPPLIER_EXPENSES is dark.
app.route("/api/expenses", expensesRoutes);
// Owner Funding Request — accounting-doc redesign P7 (reshaped). Mounted
// UNCONDITIONALLY; the router's first middleware 404s every request while
// ENABLE_OWNER_FUNDING_REQUEST is dark. NOT a BillingDocument/invoice route.
app.route("/api/owner-funding-requests", ownerFundingRequestsRoutes);
// Mount amenity admin routes BEFORE the generic /api/inventory mount so that
// `/api/inventory/amenities` is matched by the dedicated router rather than
// being shadowed by any future sub-route on the inventory module.
app.route("/api/inventory/amenities", amenitiesRoutes);
app.route("/api/inventory/work-categories", workCategoriesRoutes);
app.route("/api/inventory/property-types", propertyTypesRoutes);
app.route("/api/inventory", inventoryRoutes);
// Admin apartment-level mutations (flip-mode, shared-fields update). Lives
// at a top-level prefix (not under /api/inventory) because the underlying
// service is a separate module and the operations target the Apartment
// row directly, not the unit-listing tree.
app.route("/api/apartments", apartmentRoutes);
// Carpark bay management + assignment (carpark-redesign). Mounted next to
// /api/apartments because carparks are an apartment-level resource.
app.route("/api/carparks", carparkRoutes);
app.route("/api/listings", listingsRoutes);
// Tenant Tracker (Phase-2 M1) — mounted UNCONDITIONALLY; the router's first
// middleware gates every request on ENABLE_PHASE2_TENANT_TRACKER per-request
// (public-card precedent), so flag-off returns the canonical 404.
app.route("/api/tenant-tracker", tenantTrackerRoutes);
// Electricity-Meter / per-unit utility billing (Phase-2 M2) — mounted
// UNCONDITIONALLY at the locked singular path /api/meter; the router's first
// middleware gates every request on ENABLE_PHASE2_METER per-request (same
// public-card / tenant-tracker precedent), so flag-off returns the canonical 404.
app.route("/api/meter", meterRoutes);
// Utility-Billing global config (per-org singleton) — flag-gated by ENABLE_PHASE2_METER
// (same gate as /api/meter; flag-off returns canonical 404).
app.route("/api/utility-billing-config", utilityBillingConfigRoutes);
// Flag VISIBILITY (not flag-gated by design — the diagnostic must always answer).
app.route("/api/feature-flags", featureFlagsRoutes);
// Tenant & Owner Bills & Expenses grid (standalone store) — mounted
// UNCONDITIONALLY; the router's first middleware gates every request on
// ENABLE_PHASE2_BILLS_GRID per-request, so flag-off returns the canonical 404.
// The flag is deliberately NOT ENABLE_PHASE2_METER: enabling the meter module
// in any env must never auto-expose the unfinished grid.
app.route("/api/bills-grid", billsGridRoutes);
// Data Import (Phase-2 M9) — mounted UNCONDITIONALLY; the router's first
// middleware gates every request on ENABLE_PHASE2_TENANT_TRACKER per-request.
app.route("/api/data-import", dataImportRoutes);
app.route("/api/projects", projectsRoutes);
// Sales-claims (W2c) is mounted BEFORE the sales router so that
// `/api/sales/claims` is matched by the claims router rather than being
// shadowed by any future sub-route on the sales-units module.
app.route("/api/sales/claims", salesClaimsRoutes);
app.route("/api/sales", salesRoutes);
app.route("/api/sales-claim-defaults", salesClaimDefaultsRoutes);
app.route("/api/renovation", renovationRoutes);
app.route("/api/renovation-stages", renovationStagesRoutes);
app.route("/api/settings/renovation", renovationSettingsRoutes);
app.route("/api/parties", partiesRoutes);
// Tasks + Tickets (M7) — each router carries its own ENABLE_PHASE2_TASKS flag
// gate (canonical 404 while dark). NOTE: /api/units is the unit-scoped
// tasks/tickets surface; inventory units live under /api/inventory — the
// prefixes do not overlap.
app.route("/api/tasks", tasksRoutes);
app.route("/api/tickets", ticketsRoutes);
app.route("/api/units", unitScopedTasksRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/sprints", sprintsRoutes);
// Owner-Billing (M6) — mounted UNCONDITIONALLY; the router's first middleware
// gates every request on ENABLE_PHASE2_OWNER_BILLING per-request (public-card
// precedent), so flag-off returns the canonical 404.
app.route("/api/owner-billing", ownerBillingRoutes);
// Owner-Ledger (M6b) — same flag gate as owner-billing (ENABLE_PHASE2_OWNER_BILLING).
app.route("/api/owner-ledger", ownerLedgerRoutes);
// Owner-Remittance (Phase-2 rent-reclassification plan, Task 6) — mounted
// UNCONDITIONALLY; the router's first middleware gates every request on
// ENABLE_PHASE2_OWNER_REMITTANCE per-request (utility-billing-config
// precedent), so flag-off returns the canonical 404.
app.route("/api/owner-remittances", ownerRemittanceRoutes);
// Owner-Receivable-Offset (Phase-2 rent-reclassification plan, Task 8) — a
// DIFFERENT base path from /api/owner-remittances (non-cash settlement of an
// owner's own IVOWN lines, not a remittance). Mounted UNCONDITIONALLY; the
// router's first middleware gates every request on the SAME
// ENABLE_PHASE2_OWNER_REMITTANCE flag per-request, so flag-off returns the
// canonical 404.
app.route("/api/owner-receivable-offsets", ownerReceivableOffsetRoutes);
// Owner-ledger closed-period RECONCILIATION (R8/R10) — admin runs + findings triage.
// Mounted at a DISTINCT top-level prefix (NOT under /api/owner-ledger) ON PURPOSE: the
// owner-ledger router applies ownerLedgerFlagGate via `use("*")`, which Hono binds to
// `/api/owner-ledger/*`, so anything under that prefix 404s while ENABLE_PHASE2_OWNER_
// BILLING is dark. The reconciliation endpoints + enablement preflight MUST run BEFORE
// the live-ledger flag is enabled (spec R10), so they cannot inherit that gate. This
// distinct prefix cannot match `/api/owner-ledger/*`, so it carries no flag gate — only
// requireRole("admin"). Mirrors the portal `/owner-live` distinct-prefix precedent.
app.route("/api/owner-ledger-reconciliation", reconciliationRoutes);
// Accounting documents core — mounted UNCONDITIONALLY; the router's first
// middleware gates every request on ENABLE_PHASE2_BILLING_DOCS per-request
// (public-card precedent), so flag-off returns the canonical 404.
app.route("/api/billing-documents", billingDocumentsRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/organization-card-settings", organizationCardSettingsRoutes);
app.route("/api/organization", organizationRoutes);
// Admin agent-card endpoints (read-only in Phase 3 — mutations land in
// Phase 4). Distinct from the unauthenticated public sub-app mounted at
// /public-api/card above.
app.route("/api/agent-cards", agentCardsRoutes);
app.route("/api/profile", profileRoutes);
app.route("/api/tenancy", tenancyRoutes);
app.route("/api/payments", paymentsRoutes);
app.route("/api/communications", communicationsRoutes);
app.route("/api/commissions", commissionsRoutes);
app.route("/api/commissions/level-thresholds", levelThresholdsRoutes);
app.route("/api/audit-log", auditRoutes);
app.route("/api/tenant-ic", adminTenantIcRoutes);
app.route("/api/admin/renovation-claims", adminRenovationClaimsRoutes);
app.route("/api/admin/document-templates", documentTemplatesRoutes);
// Reservations (admin surface). Session adapter maps SessionPayload to the
// ReservationSession shape the shared route handlers expect.
app.use("/api/admin/reservations/*", adminReservationSessionAdapter);
app.route("/api/admin/reservations", reservationsRoutes);
// Unified source queue (sales + rental in one admin view).
app.route("/api/source-queue", sourceQueueRoutes);

// Public webhooks — no auth middleware
mountWhatsAppWebhook(app, { prisma: getDb() });
// FPX settle callback (Phase-2 M4) — public; auth IS the HMAC signature; the
// route itself gates on ENABLE_PHASE2_FPX (canonical 404 while dark).
mountFpxWebhook(app, { prisma: getDb() });

// ── Global error handler ─────────────────────────────────
app.onError((err, c) => {
  // R2: a frozen-period rejection thrown from any write route → HTTP 409 with the
  // structured closed_period body (createEntryService surfaces its own body via the
  // route; the throw-based statement paths land here).
  if (err instanceof ClosedPeriodError) {
    return c.json(toClosedPeriodBody(err), 409);
  }
  console.error("[unhandled]", err);
  const status = (err as any).status ?? 500;
  return c.json(
    { error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message },
    status,
  );
});

export { app };
