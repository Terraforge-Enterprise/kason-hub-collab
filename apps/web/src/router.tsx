import { createBrowserRouter, Navigate, useParams, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";
import { ChunkErrorBoundary, ChunkLoadMarker } from "@/components/chunk-error-boundary";

/** Forwards /parties/agents/:id → /organization/agents/:id preserving the param. */
function AgentDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/organization/agents/${id}`} replace />;
}

/** Forwards /admin/document-templates/:docType → /settings/document-templates/:docType preserving the param. */
function DocumentTemplateEditRedirect() {
  const { docType } = useParams<{ docType: string }>();
  return <Navigate to={`/settings/document-templates/${docType ?? ""}`} replace />;
}

/** Forwards any legacy /leasing/* URL → /tenancy/* preserving sub-path + query string. */
function LeasingToTenancyRedirect() {
  const { "*": rest } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/tenancy/${rest ?? ""}${search}`} replace />;
}

/** Forwards /portal/payments → /portal/billing?tab=payments, preserving any
 * existing query string. fpx-mock.tsx returns the payer here as
 * `?fpx=success|failed` after the mock bank redirect; a static <Navigate>
 * would silently drop that param and break the Billing shell's Payments-tab
 * FPX confirmation banner in the real navigation flow. */
function PaymentsToBillingRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("tab", "payments");
  return <Navigate to={`/portal/billing?${params.toString()}`} replace />;
}
import { ProtectedRoute } from "@/components/protected-route";
import { PortalProtectedRoute } from "@/components/portal-protected-route";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";

import LoginPage from "@/pages/login-page";
import { DashboardLayout } from "@/layouts/dashboard-layout";

// Admin pages (lazy)
const DashboardPage = lazy(() => import("@/pages/dashboard"));
const InventoryPage = lazy(() => import("@/pages/inventory/inventory-page"));
const InventorySettingsPage = lazy(() => import("@/pages/settings/sections/inventory-section"));
const UnitDetailPage = lazy(() => import("@/pages/inventory/unit-detail-page"));
const OwnersPage = lazy(() => import("@/pages/parties/owners-page"));
const TenantsPage = lazy(() => import("@/pages/parties/tenants-page"));
const TenanciesPage = lazy(() => import("@/pages/tenancy/tenancies-page"));
const LandlordTenanciesPage = lazy(() => import("@/pages/tenancy/landlord-tenancies-page"));
// Tenant Tracker UI removed 2026-08-06 — superseded by the Tenant & Owner
// Billing grid. Its API module + flag live on (Data Import + bills-grid use them).
const DataImportPage = lazy(() => import("@/pages/tenancy/data-import-page"));
// The admin owner-statements LIST page (M6 / F2) was retired: the Owner Ledger
// now issues the management fee itself (owner-ledger/month-review-sheet.tsx),
// and per-statement review lives on the per-month statement page routed below
// at /tenancy/owners/:ownerPartyId/statements/:month.
// Phase-2 Owner Billing (M6b) — admin owner-ledger entries page. Same flag gate.
const OwnerLedgerPage = lazy(() => import("@/pages/tenancy/owner-ledger-page"));
// Phase-2 Owner Billing (M6b / T3) — owner workspace drill-in. Same flag gate.
const OwnerWorkspacePage = lazy(() => import("@/pages/tenancy/owner-ledger/owner-workspace"));
// Phase-2 Owner Billing (P4) — unit-first workspace drill-in. Same flag gate.
const UnitWorkspacePage = lazy(() => import("@/pages/tenancy/owner-ledger/unit-workspace"));
// Phase-2 Owner Billing (2c-3) — full 5-section admin statement page. Same flag gate.
// Reached from the Owner Workspace unit cards → navigate('/tenancy/owners/:ownerPartyId/statements/:month').
const OwnerStatementPage = lazy(() => import("@/pages/tenancy/owner-statement-page"));
// Phase-2 Unit Analytics (Spec 2) — admin analytics page, flag-gated dark
// until ENABLE_PHASE2_UNIT_ANALYTICS (route registered below only when on).
const UnitAnalyticsPage = lazy(() => import("@/pages/tenancy/unit-analytics-page"));
// Tenant & Owner Billing grid (UI Task 10/11) — fully dark until
// VITE_ENABLE_PHASE2_BILLS_GRID=true (route registered below only when on).
const BillsGridPage = lazy(() => import("@/pages/bills-grid/bills-grid-page"));
// Charges/Payments — flag-forked shells (2026-07-04 redesign): flag-ON loads
// the v2 pages, flag-OFF keeps the legacy pages byte-identical (spec D2).
const ChargesPage = lazy(() =>
  isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
    ? import("@/pages/billing/v2/charges-page-v2")
    : import("@/pages/billing/charges-page"),
);
const PaymentsPage = lazy(() =>
  isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
    ? import("@/pages/billing/v2/payments-page-v2")
    : import("@/pages/billing/payments-page"),
);
// Accounting docs — Documents register. Flag-gated dark until ENABLE_PHASE2_BILLING_DOCS.
const BillingDocumentsPage = lazy(() => import("@/pages/billing/documents-page"));
// Accounting workspace (P3) — manual invoice create + Transfer-from-Invoice
// recording. Same flag gate as Documents.
const AccountingInvoicesPage = lazy(() => import("@/pages/accounting/invoices-page"));
const AccountingReceiptsPage = lazy(() => import("@/pages/accounting/receipts-page"));
const NotificationsPage = lazy(() => import("@/pages/communications/notifications-page"));
const AgentsPage = lazy(() => import("@/pages/parties/agents-page"));
const AgentDetailPage = lazy(() => import("@/pages/parties/agent-detail-page"));
const CardSettingsPage = lazy(() => import("@/pages/parties/card-settings-page"));
const CardApprovalsPage = lazy(() => import("@/pages/parties/card-approvals-page"));
const OrganizationHierarchyPage = lazy(() => import("@/pages/organization/hierarchy-page"));
// Managers + Admin unified into one operator-user register (Team hub → Staff).
const StaffPage = lazy(() => import("@/pages/organization/staff-page"));
const CommissionClaimsPage = lazy(() => import("@/pages/commissions/claims-page"));
const CommissionClaimDetailPage = lazy(() => import("@/pages/commissions/claim-detail-page"));
const CommissionSettingsPage = lazy(() => import("@/pages/settings/sections/commission-section"));
const DealAuditPage = lazy(() => import("@/pages/audit/deals-tab"));
const CommissionPerformancePage = lazy(() => import("@/pages/commissions/performance-page"));
const AuditLogPage = lazy(() => import("@/pages/audit/log-tab"));
const SettingsLayout = lazy(() => import("@/pages/settings/settings-layout"));
const FeatureFlagsSettingsPage = lazy(() => import("@/pages/settings/sections/feature-flags-section"));
const AuditLayout    = lazy(() => import("@/pages/audit/audit-layout"));
const DocumentTemplatesPage = lazy(() => import("@/pages/settings/sections/document-templates-section"));
const EditTemplatePage = lazy(() => import("@/pages/settings/sections/document-templates/edit-template-page"));
// Phase-2 Owner Billing (M6) settings — flag-gated dark until ENABLE_PHASE2_OWNER_BILLING.
const OwnerBillingSettingsPage = lazy(() => import("@/pages/settings/sections/owner-billing-section"));
// Phase-2 Auto-Draft Invoices (M5) settings — flag-gated dark until ENABLE_PHASE2_AUTODRAFT.
const BillingConfigSettingsPage = lazy(() => import("@/pages/settings/sections/billing-config-section"));
// Phase-2 Meter & Utilities (M2) settings — flag-gated dark until ENABLE_PHASE2_METER.
const UtilitiesSettingsPage = lazy(() => import("@/pages/settings/sections/utilities-section"));
// Accounting-docs P1 — Document Series numbering settings, flag-gated dark until ENABLE_PHASE2_BILLING_DOCS.
const DocumentSeriesSettingsPage = lazy(() => import("@/pages/settings/sections/document-series-section"));
// Bills-grid category-classification — ChargeCategory profit/expense + active management, flag-gated dark until ENABLE_PHASE2_BILLING_DOCS.
const ChargeCategoriesSettingsPage = lazy(() => import("@/pages/settings/sections/charge-categories-section"));
// Phase-2 Auto-Draft Invoices (M5) — draft-approvals queue. Flag-gated dark until ENABLE_PHASE2_AUTODRAFT.
const DraftApprovalsPage = lazy(() => import("@/pages/billing/draft-approvals-page"));

// Sales / Renovation production pages
const SalesPipelinePage = lazy(() => import("@/pages/sales/sales-pipeline-page"));
const SalesUnitDetailPage = lazy(() => import("@/pages/sales/unit-detail-page"));
// Was previously at /sales/source-queue. Renamed to the canonical
// /source-queue URL — this page already shows BOTH sales + rental
// pending submissions (despite the legacy file path), so it's the
// unified queue per the unified-property-sourcing spec.
const SourceQueuePage = lazy(() => import("@/pages/sales/source-queue-page"));
const RenovationClaimsPage = lazy(() => import("@/pages/renovation/claims-page"));
const RenovationClaimDetailPage = lazy(() => import("@/pages/renovation/claim-detail-page"));
const SalesClaimsPage = lazy(() => import("@/pages/sales/claims-page"));
const SalesClaimDetailPage = lazy(() => import("@/pages/sales/claim-detail-page"));
const RenovationSettingsPage = lazy(() => import("@/pages/settings/sections/sales-renovation-section"));
const PortalSalesPipelinePage = lazy(() => import("@/pages/portal/sales-pipeline"));
const PipelinePage = lazy(() => import("@/pages/portal/pipeline"));
const PortalRenovationClaimsPage = lazy(() => import("@/pages/portal/renovation-claims"));
const PortalSalesClaimsPage = lazy(() => import("@/pages/portal/sales-claims"));

// Portal pages (lazy — code-split from admin)
const PortalLoginPage = lazy(() => import("@/pages/portal/login"));
const PortalChargeDetailPage = lazy(() => import("@/pages/portal/charge-detail"));
// Phase-2 M3 Multi-invoice payment — portal basket pay page, flag-gated dark
// until VITE_ENABLE_PHASE2_MULTI_PAY=true. Route always registered; entry button
// is flag-gated on charges.tsx and the API returns empty/404 when flag is off.
const PortalPayPage = lazy(() => import("@/pages/portal/pay"));
// Phase-2 FPX gateway — mock bank redirect target. The gateway sends the payer to
// /portal/fpx/mock?txn=&amount= after pay.tsx initiates. Flag-gated dark until
// VITE_ENABLE_PHASE2_FPX=true (route registered below only when on).
const PortalFpxMockPage = lazy(() => import("@/pages/portal/fpx-mock"));
const PortalDocumentsPage = lazy(() => import("@/pages/portal/documents"));
// Phase-2 IA redesign (Task 2) — tenant nav re-IA: My Tenancy replaces Lease,
// Billing replaces Charges/Statement/Payments (tabbed). The old lease/charges/
// combined-statement/payments lazy consts were removed (routes below redirect
// instead of rendering them); the page files themselves stay on disk untouched.
const PortalMyTenancyPage = lazy(() => import("@/pages/portal/my-tenancy"));
const PortalBillingPage = lazy(() => import("@/pages/portal/billing"));
const PortalProfilePage = lazy(() => import("@/pages/portal/profile"));
const PortalForgotPasswordPage = lazy(() => import("@/pages/portal/forgot-password-page"));
const PortalResetPasswordPage = lazy(() => import("@/pages/portal/reset-password-page"));
const PortalLayout = lazy(() => import("@/layouts/portal-layout"));
const PortalDashboardDispatcher = lazy(() => import("@/pages/portal/dashboard-dispatcher"));
const CommissionClaimsPortalPage = lazy(() => import("@/pages/portal/commission-claims"));
const CommissionDashboardPortalPage = lazy(() => import("@/pages/portal/commission-dashboard"));
const AgentClaimNewPage = lazy(() => import("@/pages/portal/agent-claim-new"));
const AgentClaimDetailPage = lazy(() => import("@/pages/portal/agent-claim-detail"));
const PortalTeamPage = lazy(() => import("@/pages/portal/team/portal-team-page"));
const PortalInventoryPage = lazy(() => import("@/pages/portal/inventory-page"));
const PortalInventoryCreatePage = lazy(() => import("@/pages/portal/inventory-create-page"));
const PortalUnitDetailPage = lazy(() => import("@/pages/portal/unit-detail-page"));
const PortalInventoryEditPage = lazy(() => import("@/pages/portal/inventory-edit-page"));
const PortalPropertyEditPage = lazy(() => import("@/pages/portal/property-edit-page"));
const PortalMyUploadsPage = lazy(() => import("@/pages/portal/my-uploads-page"));
const PortalMyCardPage = lazy(() => import("@/pages/portal/my-card-page"));
const ReservationNewPage = lazy(() => import("@/pages/portal/reservation-new"));
const ReservationListPage = lazy(() => import("@/pages/portal/reservation-list"));
const PortalReservationDetailPage = lazy(() => import("@/pages/portal/reservation-detail"));
const AdminReservationsListPage = lazy(() => import("@/pages/admin/reservations/reservations-list-page"));
const AdminReservationDetailPage = lazy(() => import("@/pages/admin/reservations/reservation-detail-page"));
const ReservationFillPage = lazy(() => import("@/pages/public/reservation-fill"));
const ReservationSignedPage = lazy(() => import("@/pages/public/reservation-signed"));
// Public compliance pages — see the `/about` route block below for why these
// must never be placed behind an auth guard.
const AboutPage = lazy(() => import("@/pages/public/legal/about"));
const TermsPage = lazy(() => import("@/pages/public/legal/terms"));
const PrivacyPage = lazy(() => import("@/pages/public/legal/privacy"));
const RefundPolicyPage = lazy(() => import("@/pages/public/legal/refund-policy"));
const ContactPage = lazy(() => import("@/pages/public/legal/contact"));
// Public e-namecard — loaded by the main SPA when CloudFront lacks a /card/*
// path behaviour and falls through to index.html.  No auth required.
const PublicCardPageLazy = lazy(() =>
  import("@/public-card/PublicCardPage").then((m) => ({ default: m.PublicCardPage })),
);

// Invoice-adjustments PHASE PREVIEW (2026-07-20-invoice-adjustments plan, D6) —
// a dev-only, static-fixture preview of the 12 design states. NEVER present in
// a production build: gated below on import.meta.env.DEV/VITE_DESIGN_PREVIEW,
// mirroring the existing flag-gated route-registration pattern (isPhase2FlagEnabled
// spreads above). No auth required — it renders the real accounting components
// against a mock fixture, never the network.
const InvoiceAdjustmentsPreviewPage = lazy(() => import("@/design-preview/invoice-adjustments"));

import { RoleRoute } from "@/components/role-route";
import { PortalMustChangeGuard } from "@/components/portal-must-change-guard";
import { AdminMustChangeGuard } from "@/components/admin-must-change-guard";
const ChangePasswordPage = lazy(() => import("@/pages/portal/change-password-page"));
const AdminChangePasswordPage = lazy(() => import("@/pages/change-password-page"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password-page"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password-page"));
const AccountPage = lazy(() => import("@/pages/account-page"));
const PortalOwnerDocsPage = lazy(() => import("@/pages/portal/owner-docs"));
// Phase-2 Owner Billing (M6b) — portal owner-ledger page (now routed as /portal/transactions).
// Flag-gated dark until ENABLE_PHASE2_OWNER_BILLING is on.
const PortalOwnerLedgerPage = lazy(() => import("@/pages/portal/owner-ledger"));
// Phase-2 Owner Billing (T7) — portal tax summary page (now routed as /portal/income-tax). Same flag gate.
const PortalOwnerTaxSummaryPage = lazy(() => import("@/pages/portal/owner-tax-summary"));
// Phase-2 Owner Billing (T8) — portal property view. Flag-gated dark until
// ENABLE_PHASE2_OWNER_BILLING is on. Reached via the "View property" link in
// owner-financials; no nav item of its own.
const PortalOwnerPropertyPage = lazy(() => import("@/pages/portal/owner-property"));
// Phase-2 IA redesign Task 2 — /portal/statements payout view. KAEN-flow only.
const PortalOwnerStatementPage = lazy(() => import("@/pages/portal/owner-statement"));

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ChunkErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
          </div>
        }
      >
        <ChunkLoadMarker />
        {children}
      </Suspense>
    </ChunkErrorBoundary>
  );
}

export const router = createBrowserRouter([
  // Admin login
  {
    path: "/login",
    element: <LoginPage />,
  },

  // Admin password recovery (public)
  {
    path: "/forgot-password",
    element: (
      <SuspenseWrapper>
        <ForgotPasswordPage />
      </SuspenseWrapper>
    ),
  },
  {
    path: "/reset-password",
    element: (
      <SuspenseWrapper>
        <ResetPasswordPage />
      </SuspenseWrapper>
    ),
  },

  // Admin change-password (outside guard to avoid infinite redirect loop)
  {
    path: "/change-password",
    element: (
      <SuspenseWrapper>
        <ProtectedRoute>
          <AdminChangePasswordPage />
        </ProtectedRoute>
      </SuspenseWrapper>
    ),
  },

  // Admin protected routes
  {
    element: (
      <ProtectedRoute>
        <AdminMustChangeGuard>
          <DashboardLayout />
        </AdminMustChangeGuard>
      </ProtectedRoute>
    ),
    children: [
      { path: "/dashboard", element: <SuspenseWrapper><DashboardPage /></SuspenseWrapper> },
      { path: "/inventory", element: <SuspenseWrapper><InventoryPage /></SuspenseWrapper> },
      { path: "/inventory/properties", element: <Navigate to="/inventory" replace /> },
      { path: "/inventory/listings", element: <Navigate to="/inventory" replace /> },
      // Legacy URL — replaced by /source-queue. Bookmarks redirect.
      { path: "/inventory/agent-sourced", element: <Navigate to="/source-queue" replace /> },
      { path: "/inventory/settings", element: <Navigate to="/settings/inventory" replace /> },
      { path: "/inventory/units/:id", element: <SuspenseWrapper><UnitDetailPage /></SuspenseWrapper> },
      // /parties is the single sidebar entry for the Tenants & Owners area.
      // Default lands on the Tenants tab; tab strip on each page switches.
      { path: "/parties", element: <Navigate to="/parties/tenants" replace /> },
      { path: "/parties/owners", element: <SuspenseWrapper><OwnersPage /></SuspenseWrapper> },
      { path: "/parties/tenants", element: <SuspenseWrapper><TenantsPage /></SuspenseWrapper> },
      // Legacy /leasing/* bookmarks (pre-rename) → /tenancy/* (preserves sub-path + query).
      { path: "/leasing/*", element: <LeasingToTenancyRedirect /> },
      { path: "/tenancy/tenancies", element: <SuspenseWrapper><TenanciesPage /></SuspenseWrapper> },
      { path: "/tenancy/landlord-tenancies", element: <SuspenseWrapper><LandlordTenanciesPage /></SuspenseWrapper> },
      // The Tenant Tracker (`/tenancy/tenant-tracker`), its Bill-this-unit
      // workspace, and the old /tenancy/meter redirect were REMOVED 2026-08-06 —
      // superseded by the Tenant & Owner Billing grid. Old links fall through to
      // `{ path: "*" }` → /dashboard, same as when the flag was dark.
      // Tenant & Owner Billing grid — fully dark until VITE_ENABLE_PHASE2_BILLS_GRID=true
      // (flag OFF = route not registered, so a deep link falls through to `{ path: "*" }` → /dashboard).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID")
        ? [{ path: "/billing/tenant-owner-billing", element: <SuspenseWrapper><BillsGridPage /></SuspenseWrapper> }]
        : []),
      // Phase-2 M9 — Data Import admin UI. Still gated by ENABLE_PHASE2_TENANT_TRACKER
      // (the flag outlived the tracker page; the import feeds the same data domain).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_TENANT_TRACKER")
        ? [{ path: "/tenancy/data-import", element: <SuspenseWrapper><DataImportPage /></SuspenseWrapper> }]
        : []),
      // /tenancy/owner-statements is gone — the Owner Ledger replaced it.
      // Phase-2 Owner Billing (M6b) — admin owner-ledger entries. Same flag gate.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/tenancy/owner-ledger", element: <SuspenseWrapper><OwnerLedgerPage /></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (P4) — unit workspace. Registered BEFORE the
      // :ownerPartyId drill-in for readability; React Router ranks the static
      // "unit" segment above the param route regardless of order.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/tenancy/owner-ledger/unit/:apartmentId", element: <SuspenseWrapper><UnitWorkspacePage /></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (M6b / T3) — owner workspace drill-in. Same flag gate.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/tenancy/owner-ledger/:ownerPartyId", element: <SuspenseWrapper><OwnerWorkspacePage /></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (2c-3) — full 5-section admin statement page. Same flag gate.
      // Derives statementId from month param via useOwnerMonthlySummaries.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/tenancy/owners/:ownerPartyId/statements/:month", element: <SuspenseWrapper><OwnerStatementPage /></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (Task 10) — per-unit statement page. Same component as
      // the legacy route above but reads `apartmentId` param and scopes the data to
      // that apartment. KEEP the legacy route above (cleanup is deferred, spec §12).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/tenancy/owners/:ownerPartyId/units/:apartmentId/statements/:month", element: <SuspenseWrapper><OwnerStatementPage /></SuspenseWrapper> }]
        : []),
      // Phase-2 Unit Analytics (Spec 2) — read-only analytics dashboard.
      // Only registered when ENABLE_PHASE2_UNIT_ANALYTICS is on (manager+ via
      // nav minRole + the API's analyticsGate). Mirrors the Owner Statements dark gate.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_UNIT_ANALYTICS")
        ? [{ path: "/tenancy/unit-analytics", element: <SuspenseWrapper><UnitAnalyticsPage /></SuspenseWrapper> }]
        : []),
      { path: "/billing/charges", element: <SuspenseWrapper><ChargesPage /></SuspenseWrapper> },
      { path: "/billing/payments", element: <SuspenseWrapper><PaymentsPage /></SuspenseWrapper> },
      // Accounting docs — Documents register (spec §4.2). Only registered when
      // ENABLE_PHASE2_BILLING_DOCS is on (manager+ via nav minRole + the API gate).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
        ? [{ path: "/billing/documents", element: <SuspenseWrapper><BillingDocumentsPage /></SuspenseWrapper> }]
        : []),
      // Accounting workspace (P3): manual invoice create + Transfer-from-Invoice
      // recording. Same flag gate as Documents.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
        ? [
            { path: "/accounting/invoices", element: <SuspenseWrapper><AccountingInvoicesPage /></SuspenseWrapper> },
            { path: "/accounting/receipts", element: <SuspenseWrapper><AccountingReceiptsPage /></SuspenseWrapper> },
          ]
        : []),
      // Phase-2 Auto-Draft Invoices (M5) — draft-approvals queue.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
        ? [{ path: "/billing/draft-approvals", element: <SuspenseWrapper><DraftApprovalsPage /></SuspenseWrapper> }]
        : []),
      { path: "/communications/notifications", element: <SuspenseWrapper><NotificationsPage /></SuspenseWrapper> },
      // /parties/agents → /organization/agents (spec §4a). Old paths redirect for bookmark continuity.
      { path: "/parties/agents", element: <Navigate to="/organization/agents" replace /> },
      { path: "/parties/agents/:id", element: <AgentDetailRedirect /> },
      { path: "/organization/agents", element: <SuspenseWrapper><AgentsPage /></SuspenseWrapper> },
      // Sub-tabs of the Agents area (per agent-card spec §7.1). Static paths
      // listed BEFORE the :id dynamic route so they match first.
      { path: "/organization/agents/card-settings", element: <SuspenseWrapper><CardSettingsPage /></SuspenseWrapper> },
      { path: "/organization/agents/card-approvals", element: <SuspenseWrapper><CardApprovalsPage /></SuspenseWrapper> },
      { path: "/organization/agents/:id", element: <SuspenseWrapper><AgentDetailPage /></SuspenseWrapper> },
      // /organization is the single sidebar entry for the Team area (mirrors
      // /parties → /parties/tenants). Lands on the Staff tab.
      { path: "/organization", element: <Navigate to="/organization/staff" replace /> },
      { path: "/organization/hierarchy", element: <SuspenseWrapper><OrganizationHierarchyPage /></SuspenseWrapper> },
      { path: "/organization/staff", element: <SuspenseWrapper><StaffPage /></SuspenseWrapper> },
      // Managers + Admin merged into the unified Staff register (Team hub → Staff
      // tab). Old URLs redirect for bookmark continuity (spec: keep /organization/*).
      { path: "/organization/managers", element: <Navigate to="/organization/staff" replace /> },
      { path: "/organization/admins", element: <Navigate to="/organization/staff" replace /> },
      { path: "/commissions/claims", element: <SuspenseWrapper><CommissionClaimsPage /></SuspenseWrapper> },
      { path: "/commissions/claims/:id", element: <SuspenseWrapper><CommissionClaimDetailPage /></SuspenseWrapper> },
      { path: "/commissions/performance", element: <SuspenseWrapper><CommissionPerformancePage /></SuspenseWrapper> },
      { path: "/commissions/settings", element: <Navigate to="/settings/commission" replace /> },
      { path: "/commissions/deals", element: <Navigate to="/audit/deals" replace /> },
      { path: "/workspace/audit-log", element: <Navigate to="/audit/log" replace /> },

      // Sales / Renovation production routes
      { path: "/sales/pipeline", element: <SuspenseWrapper><SalesPipelinePage /></SuspenseWrapper> },
      { path: "/sales/units/:id", element: <SuspenseWrapper><SalesUnitDetailPage /></SuspenseWrapper> },
      // Legacy URL — replaced by /source-queue. Bookmarks redirect.
      { path: "/sales/source-queue", element: <Navigate to="/source-queue" replace /> },
      { path: "/sales/claims", element: <SuspenseWrapper><SalesClaimsPage /></SuspenseWrapper> },
      { path: "/sales/claims/:id", element: <SuspenseWrapper><SalesClaimDetailPage /></SuspenseWrapper> },
      { path: "/renovation/claims", element: <SuspenseWrapper><RenovationClaimsPage /></SuspenseWrapper> },
      { path: "/renovation/claims/:id", element: <SuspenseWrapper><RenovationClaimDetailPage /></SuspenseWrapper> },
      // Combined Sales & Renovation settings — single page, tabbed.
      // Old path kept; UI title says "Sales & Renovation Settings".
      { path: "/workspace/renovation-settings", element: <Navigate to="/settings/sales-renovation" replace /> },
      // Bookmarks from the brief stint when Sales had its own page.
      { path: "/sales/settings", element: <Navigate to="/settings/sales-renovation?tab=sales" replace /> },

      // Unified source queue — replaces /sales/source-queue and
      // /inventory/agent-sourced in nav. Old routes still resolve for
      // bookmark continuity (one release of backwards compat).
      { path: "/source-queue", element: <SuspenseWrapper><SourceQueuePage /></SuspenseWrapper> },

      // Old mock routes — redirect to production pages for one release
      { path: "/sales-mock/pipeline", element: <Navigate to="/sales/pipeline" replace /> },
      { path: "/sales-mock/claims", element: <Navigate to="/renovation/claims" replace /> },

      // Document templates (legacy URLs — redirect to /settings/document-templates)
      { path: "/admin/document-templates", element: <Navigate to="/settings/document-templates" replace /> },
      { path: "/admin/document-templates/:docType", element: <DocumentTemplateEditRedirect /> },

      // Reservations (admin)
      { path: "/admin/reservations", element: <SuspenseWrapper><AdminReservationsListPage /></SuspenseWrapper> },
      { path: "/admin/reservations/:id", element: <SuspenseWrapper><AdminReservationDetailPage /></SuspenseWrapper> },

      // New canonical Settings shell + nested sections
      {
        path: "/settings",
        element: <SuspenseWrapper><SettingsLayout /></SuspenseWrapper>,
        children: [
          // Bare /settings is handled by SettingsLayout's component-level redirect — no index route needed.
          { path: "commission",                  element: <SuspenseWrapper><CommissionSettingsPage /></SuspenseWrapper> },
          { path: "inventory",                   element: <SuspenseWrapper><InventorySettingsPage /></SuspenseWrapper> },
          { path: "sales-renovation",            element: <SuspenseWrapper><RenovationSettingsPage /></SuspenseWrapper> },
          { path: "document-templates",          element: <SuspenseWrapper><DocumentTemplatesPage /></SuspenseWrapper> },
          { path: "document-templates/:docType", element: <SuspenseWrapper><EditTemplatePage /></SuspenseWrapper> },
          // Flag VISIBILITY — deliberately NOT flag-gated (the diagnostic must stay
          // reachable precisely when flags are misconfigured).
          { path: "feature-flags",               element: <SuspenseWrapper><FeatureFlagsSettingsPage /></SuspenseWrapper> },
          // Phase-2 Owner Billing (M6) — child route only registered when the flag is on.
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
            ? [{ path: "owner-billing", element: <SuspenseWrapper><OwnerBillingSettingsPage /></SuspenseWrapper> }]
            : []),
          // Phase-2 Auto-Draft Invoices (M5) — child route only registered when the flag is on.
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
            ? [{ path: "billing-config", element: <SuspenseWrapper><BillingConfigSettingsPage /></SuspenseWrapper> }]
            : []),
          // Phase-2 Meter & Utilities (M2) — child route only registered when the flag is on.
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_METER")
            ? [{ path: "utilities", element: <SuspenseWrapper><UtilitiesSettingsPage /></SuspenseWrapper> }]
            : []),
          // Accounting-docs P1 — child route only registered when the flag is on.
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
            ? [{ path: "document-series", element: <SuspenseWrapper><DocumentSeriesSettingsPage /></SuspenseWrapper> }]
            : []),
          // Bills-grid category-classification — the table moved into Billing Config
          // (2026-08-03); this route is retained so old bookmarks resolve, and the page
          // itself redirects to /settings/billing-config. Still flag-gated the same way.
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
            ? [{ path: "charge-categories", element: <SuspenseWrapper><ChargeCategoriesSettingsPage /></SuspenseWrapper> }]
            : []),
          // Old /settings/* sub-paths — redirect directly to canonical (skip double-hop via old /commissions/settings)
          { path: "tier-mappings",       element: <Navigate to="/settings/commission" replace /> },
          { path: "room-types",          element: <Navigate to="/settings/commission" replace /> },
          { path: "level-thresholds",    element: <Navigate to="/settings/commission" replace /> },
          { path: "commission-rules",    element: <Navigate to="/settings/commission" replace /> },
          { path: "ta-tiers",            element: <Navigate to="/settings/commission" replace /> },
        ],
      },
      // New canonical Audit shell + nested tabs
      {
        path: "/audit",
        element: <SuspenseWrapper><AuditLayout /></SuspenseWrapper>,
        children: [
          { index: true,    element: <Navigate to="/audit/deals" replace /> },
          { path: "deals",  element: <SuspenseWrapper><DealAuditPage /></SuspenseWrapper> },
          { path: "log",    element: <SuspenseWrapper><AuditLogPage /></SuspenseWrapper> },
        ],
      },

      // Self-service account page
      { path: "/account", element: <SuspenseWrapper><AccountPage /></SuspenseWrapper> },

      // Redirects from old paths — preserve bookmarks for one release (direct to canonical, no double-hop)
      { path: "/commissions/tier-mappings",     element: <Navigate to="/settings/commission" replace /> },
      { path: "/commissions/room-types",        element: <Navigate to="/settings/commission" replace /> },
      { path: "/commissions/level-thresholds",  element: <Navigate to="/settings/commission" replace /> },
      // /settings/tier-mappings etc. are now handled as children of the /settings nested route above
      { path: "/workspace/commission-rules",    element: <Navigate to="/settings/commission" replace /> },
      { path: "/workspace/ta-tiers",            element: <Navigate to="/settings/commission" replace /> },
      { path: "/workspace/deals",               element: <Navigate to="/audit/deals" replace /> },
    ],
  },

  // Portal login (public)
  { path: "/portal/login", element: <SuspenseWrapper><PortalLoginPage /></SuspenseWrapper> },

  // Portal password recovery (public)
  {
    path: "/portal/forgot-password",
    element: (
      <SuspenseWrapper>
        <PortalForgotPasswordPage />
      </SuspenseWrapper>
    ),
  },
  {
    path: "/portal/reset-password",
    element: (
      <SuspenseWrapper>
        <PortalResetPasswordPage />
      </SuspenseWrapper>
    ),
  },

  // Portal change-password (outside guard to avoid infinite redirect loop)
  {
    path: "/portal/change-password",
    element: (
      <SuspenseWrapper>
        <PortalProtectedRoute>
          <ChangePasswordPage />
        </PortalProtectedRoute>
      </SuspenseWrapper>
    ),
  },

  // Portal protected routes
  {
    element: (
      <SuspenseWrapper>
        <PortalProtectedRoute>
          <PortalMustChangeGuard>
            <PortalLayout />
          </PortalMustChangeGuard>
        </PortalProtectedRoute>
      </SuspenseWrapper>
    ),
    children: [
      { path: "/portal/dashboard", element: <SuspenseWrapper><PortalDashboardDispatcher /></SuspenseWrapper> },
      { path: "/portal/profile", element: <SuspenseWrapper><PortalProfilePage /></SuspenseWrapper> },
      // Tenant routes
      { path: "/portal/my-tenancy", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalMyTenancyPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/billing", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalBillingPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/charges/:id", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalChargeDetailPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/pay", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalPayPage /></RoleRoute></SuspenseWrapper> },
      // IA redesign (Task 2) — old paths kept registered as redirects (not
      // deleted; page files stay on disk per page-deletion-guard) so existing
      // bookmarks/links keep working.
      { path: "/portal/lease", element: <Navigate to="/portal/my-tenancy" replace /> },
      { path: "/portal/charges", element: <Navigate to="/portal/billing?tab=invoices" replace /> },
      { path: "/portal/statement", element: <Navigate to="/portal/billing" replace /> },
      // Query-string-preserving redirect (not a plain <Navigate>) — see
      // PaymentsToBillingRedirect for why (FPX return-param continuity).
      { path: "/portal/payments", element: <PaymentsToBillingRedirect /> },
      // Phase-2 FPX gateway — mock bank redirect target. Only registered when
      // VITE_ENABLE_PHASE2_FPX is on (mirrors the dark-gate pattern of the other
      // Phase-2 portal routes). The payer lands here after pay.tsx initiates FPX.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_FPX")
        ? [{ path: "/portal/fpx/mock", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalFpxMockPage /></RoleRoute></SuspenseWrapper> }]
        : []),
      { path: "/portal/documents", element: <SuspenseWrapper><RoleRoute allowed={["tenant"]}><PortalDocumentsPage /></RoleRoute></SuspenseWrapper> },
      // Agent routes
      { path: "/portal/commissions/dashboard", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><CommissionDashboardPortalPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/commissions/claims",   element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><CommissionClaimsPortalPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/claims", element: <Navigate to="/portal/commissions/claims" replace /> },
      { path: "/portal/claims/new", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><AgentClaimNewPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/claims/:id", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><AgentClaimDetailPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/team", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalTeamPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/my-card", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalMyCardPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/inventory", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalInventoryPage /></RoleRoute></SuspenseWrapper> },
      // Agent creates a rental Unit. Submission lands in /source-queue
      // (server forces sourceFlag=AGENT_SOURCED, sourcingApproved=false).
      { path: "/portal/inventory/new", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalInventoryCreatePage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/inventory/:id", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalUnitDetailPage /></RoleRoute></SuspenseWrapper> },
      // Agent amends a pending / needs-amendment submission. PATCHes via
      // updatePortalUnit; backend rejects (409) if state is rejected/withdrawn.
      { path: "/portal/inventory/:id/edit", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalInventoryEditPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/properties/:submissionId/edit", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalPropertyEditPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/my-uploads", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalMyUploadsPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/pipeline", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PipelinePage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/reservations", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><ReservationListPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/reservations/new", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><ReservationNewPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/reservations/:id", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalReservationDetailPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/sales-pipeline", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalSalesPipelinePage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/renovation-claims", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalRenovationClaimsPage /></RoleRoute></SuspenseWrapper> },
      // Deep-link entry points: pipeline rows link straight to a pre-filled
      // new-claim drawer with ?salesUnitId=<id>. Same component as the list
      // route — the page reads useLocation().pathname to auto-open the
      // drawer in "new" mode and useSearchParams() to prefill the unit.
      { path: "/portal/renovation-claims/new", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalRenovationClaimsPage /></RoleRoute></SuspenseWrapper> },
      { path: "/portal/sales-claims", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><PortalSalesClaimsPage /></RoleRoute></SuspenseWrapper> },
      // Plan 2: filing now happens in the unified Pipeline. Old deep-link
      // /portal/sales-claims/new redirects to the Sales tab of Pipeline.
      // Stays in Sales domain — never cross-redirect to Commission/Renovation.
      // RoleRoute mirrors the sister list route at /portal/sales-claims so
      // the redirect doesn't bypass the agent role gate.
      { path: "/portal/sales-claims/new", element: <SuspenseWrapper><RoleRoute allowed={["agent"]}><Navigate to="/portal/pipeline?tab=sales" replace /></RoleRoute></SuspenseWrapper> },
      // Old mock route — redirect to production
      { path: "/portal/sales-mock/entry", element: <Navigate to="/portal/sales-pipeline" replace /> },
      { path: "/portal/deals", element: <Navigate to="/portal/claims" replace /> },
      { path: "/portal/deals/:id", element: <Navigate to="/portal/claims" replace /> },
      // Owner routes
      { path: "/portal/owner-docs", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><PortalOwnerDocsPage /></RoleRoute></SuspenseWrapper> },
      // Phase-2 IA redesign — /portal/transactions (renamed ledger; was /portal/owner-ledger).
      // Flag-gated dark until ENABLE_PHASE2_OWNER_BILLING is on.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/transactions", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><PortalOwnerLedgerPage /></RoleRoute></SuspenseWrapper> }]
        : []),
      // Phase-2 IA redesign — /portal/owner-ledger → /portal/transactions redirect (bookmark continuity).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/owner-ledger", element: <Navigate to="/portal/transactions" replace /> }]
        : []),
      // Phase-2 IA redesign Task 2 — /portal/statements (payout view). KAEN-flow only.
      // Replaced the interim PortalReportsPage stub with the real OwnerStatementPage.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/statements", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><PortalOwnerStatementPage /></RoleRoute></SuspenseWrapper> }]
        : []),
      // Phase-2 IA redesign — /portal/income-tax (full record; Task 3 will enrich owner-tax-summary).
      // Points to existing owner-tax-summary.tsx for now; flag-gated owner route.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/income-tax", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><PortalOwnerTaxSummaryPage /></RoleRoute></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (T7) — legacy /portal/owner-tax-summary → redirect to canonical /portal/income-tax.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/owner-tax-summary", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><Navigate to="/portal/income-tax" replace /></RoleRoute></SuspenseWrapper> }]
        : []),
      // Phase-2 Owner Billing (T8) — portal property view. Reached from
      // owner-financials "View property" link; no nav item. Flag gate matches T6/T7.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ path: "/portal/owner-property/:id", element: <SuspenseWrapper><RoleRoute allowed={["owner"]}><PortalOwnerPropertyPage /></RoleRoute></SuspenseWrapper> }]
        : []),
    ],
  },

  // Public reservation sign flow — token-gated, no auth.
  { path: "/reserve/:token", element: <SuspenseWrapper><ReservationFillPage /></SuspenseWrapper> },
  { path: "/reserve/:token/signed", element: <SuspenseWrapper><ReservationSignedPage /></SuspenseWrapper> },

  // Public e-namecard — token-gated, no auth.
  // Cloudfront in UAT is not yet configured with a /card/* behaviour so
  // requests fall through to index.html (this SPA). This route ensures the
  // React Router picks up the token and renders the card without bouncing
  // the visitor to /login. A separate CloudFront infra change (path-behaviour
  // /card/* → card.html) is the long-term fix — see spec §13.
  { path: "/card/:token", element: <SuspenseWrapper><PublicCardPageLazy /></SuspenseWrapper> },

  // Public compliance pages — NO AUTH, and they must stay that way.
  //
  // Two separate obligations are satisfied by these five routes being reachable
  // with no session on the domain where tenants actually pay:
  //
  //   1. Fiuu (Razer Merchant Services) ToS cl. 3.9 — the merchant website must
  //      publish trading name, address, telephone, URL, what is being paid for,
  //      and the refund policy. Fiuu's onboarding reviewer cannot log in; if a
  //      reviewer hits a login wall the merchant application stalls. Clause 3.9
  //      also makes Fiuu's OWN default refund policy binding on a merchant that
  //      publishes none.
  //   2. Consumer Protection (Electronic Trade Transaction) Regulations 2024
  //      (in force 25 Dec 2024; grace period ended 24 Jun 2025) — business name,
  //      SSM number, address, email and phone owed to consumers. Breach is an
  //      offence under the Consumer Protection Act 1999.
  //
  // Registered ABOVE the `{ path: "*" }` catch-all on purpose: that catch-all
  // redirects to /dashboard, which bounces a logged-out visitor to /login. Do
  // not move these below it, and do not wrap them in ProtectedRoute.
  { path: "/about", element: <SuspenseWrapper><AboutPage /></SuspenseWrapper> },
  { path: "/terms", element: <SuspenseWrapper><TermsPage /></SuspenseWrapper> },
  { path: "/privacy", element: <SuspenseWrapper><PrivacyPage /></SuspenseWrapper> },
  { path: "/refund-policy", element: <SuspenseWrapper><RefundPolicyPage /></SuspenseWrapper> },
  { path: "/contact", element: <SuspenseWrapper><ContactPage /></SuspenseWrapper> },

  // Invoice-adjustments PHASE PREVIEW — dev-only, falls through to `*` below
  // (→ /dashboard) whenever DEV/VITE_DESIGN_PREVIEW is off, so a prod build
  // never registers this path at all.
  ...(import.meta.env.DEV || import.meta.env.VITE_DESIGN_PREVIEW
    ? [{ path: "/design-preview/invoice-adjustments", element: <SuspenseWrapper><InvoiceAdjustmentsPreviewPage /></SuspenseWrapper> }]
    : []),

  // Redirects
  { path: "/portal", element: <Navigate to="/portal/dashboard" replace /> },
  { path: "/", element: <Navigate to="/dashboard" replace /> },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);
