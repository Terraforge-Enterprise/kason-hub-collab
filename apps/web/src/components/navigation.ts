import type { LucideIcon } from "lucide-react";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import {
  BarChart3,
  BellDot,
  BookOpen,
  Building2,
  CheckSquare,
  ClipboardList,
  CreditCard,
  FileCheck,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Hammer,
  LayoutDashboard,
  Landmark,
  ListTodo,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";

/**
 * Minimum admin role required to see a nav item. Mirrors apps/api/src/lib/rbac.ts
 * (editor < manager < admin). Undefined = visible to all admin roles.
 */
export type MinRole = "editor" | "manager" | "admin";

export type NavWorkspace = "operations" | "accounting" | "neutral";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  minRole?: MinRole;
  workspace?: NavWorkspace;
};

export type NavSection = {
  label: string;
  items: NavItem[];
  /** If true, the section header is a click-to-toggle dropdown (collapsed by default). */
  collapsible?: boolean;
};

const ROLE_RANK: Record<string, number> = { editor: 1, manager: 2, admin: 3 };

/** Returns true if `role` meets the minimum for a nav item. */
export function canSeeNavItem(role: string | undefined, item: NavItem): boolean {
  if (!item.minRole) return true;
  const current = ROLE_RANK[role ?? ""] ?? 0;
  const required = ROLE_RANK[item.minRole] ?? Number.POSITIVE_INFINITY;
  return current >= required;
}

/**
 * Workspace-aware visibility. The accountant is a capability, not a rank, so it
 * is DEFAULT-DENIED: it sees only items tagged "accounting" or "neutral".
 * Other roles: an "accounting"-tagged item is visible to admin/manager only;
 * everything else falls back to the rank gate (canSeeNavItem).
 */
export function canSeeNavItemFor(role: string | undefined, item: NavItem): boolean {
  if (role === "accountant") return item.workspace === "accounting" || item.workspace === "neutral";
  if (item.workspace === "accounting") return role === "admin" || role === "manager";
  return canSeeNavItem(role, item);
}

/**
 * True when `role` meets the minimum (editor < manager < admin). Same ranking
 * canSeeNavItem uses — exported so pages gate role-bound affordances (e.g.
 * tenant-tracker export/IC-reveal) without hand-rolling role literals.
 */
export function hasMinRole(role: string | undefined, min: "editor" | MinRole): boolean {
  const current = ROLE_RANK[role ?? ""] ?? 0;
  const required = ROLE_RANK[min] ?? Number.POSITIVE_INFINITY;
  return current >= required;
}

export const navSections: NavSection[] = [
  {
    label: "Main",
    items: [
      { title: "Overview", href: "/dashboard", icon: LayoutDashboard, workspace: "neutral" },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { title: "Inventory",  href: "/inventory",            icon: Building2 },
      // Source queue moved to its own canonical /source-queue URL (was
      // duplicated here as /inventory/agent-sourced + under Sales as
      // /sales/source-queue). Per unified-property-sourcing spec.
      { title: "Source Queue", href: "/source-queue", icon: CheckSquare, minRole: "manager" },
      // Inventory Settings is now a section inside /settings (left-rail).
      { title: "Tenants & Owners", href: "/parties", icon: Users },
    ],
  },
  {
    // Organization-scoped concerns collapsed into ONE "Team" sidebar entry whose
    // surfaces switch via TeamAreaTabs (Staff · Agents · Hierarchy). Staff is the
    // unified operator-user register that replaced the separate Managers + Admin
    // tabs (same /api/users entity); Agents + Hierarchy keep their own URLs.
    label: "Team",
    items: [
      // href is the /organization landing (redirects to the Staff tab) so the
      // sidebar entry stays active across all Team tabs — mirrors /parties.
      { title: "Team", href: "/organization", icon: Users },
    ],
  },
  // Phase-2 Operations — Tasks board (M7) + Unit Analytics (Spec 2), placed
  // above Tenancy. Section appears when either flag is on; each item is gated
  // by its own flag (routes are gated the same way in router.tsx).
  ...((isPhase2FlagEnabled("ENABLE_PHASE2_TASKS") || isPhase2FlagEnabled("ENABLE_PHASE2_UNIT_ANALYTICS"))
    ? [
        {
          label: "Operations",
          items: [
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_TASKS")
              ? [{ title: "Tasks", href: "/tasks", icon: ListTodo, minRole: "editor" as const }]
              : []),
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_UNIT_ANALYTICS")
              ? [{ title: "Unit Analytics", href: "/tenancy/unit-analytics", icon: BarChart3, minRole: "manager" as const }]
              : []),
          ],
        },
      ]
    : []),
  {
    label: "Tenancy",
    items: [
      { title: "Reservations",       href: "/admin/reservations",         icon: FileSignature },
      // Tenant Tracker nav entry REMOVED 2026-08-06 — superseded by the Tenant &
      // Owner Billing grid. The tenant-tracker API module + flag live on
      // (Data Import below + bills-grid still use them).
      // Phase-2 M9 — Data Import (admin only). Still gated by
      // ENABLE_PHASE2_TENANT_TRACKER (the flag outlived the tracker page);
      // further restricted to admin role (GET is editor+, but the dry-run CTA
      // requires admin so the nav entry reflects that).
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_TENANT_TRACKER")
        ? [{ title: "Data Import", href: "/tenancy/data-import", icon: FileSpreadsheet, minRole: "admin" as const }]
        : []),
      // "Owner Statements" was retired — the Owner Ledger is the single front
      // door now (it issues the management fee and links through to each
      // per-month statement).
      // Phase-2 Owner Billing (M6b) — admin owner-ledger entries. Same flag gate.
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
        ? [{ title: "Owner Ledger", href: "/tenancy/owner-ledger", icon: BookOpen, minRole: "manager" as const }]
        : []),
      // Unit Analytics (Spec 2) moved to the Operations section (above Tenancy).
      // Landlord Tenancies + Tenancies parked in the Hidden section below.
    ],
  },
  // Billing section — exists when Auto-Draft (M5) OR the accounting Documents
  // register OR the Tenant & Owner Billing grid is on. Each item gated by its
  // own flag (routes gated the same way in router.tsx). Draft Approvals:
  // minRole editor matches requireRole("editor"); Documents: minRole manager
  // matches the API's requireRole("manager"). ENABLE_PHASE2_BILLS_GRID is
  // included in the SECTION condition (not just its item) so the grid stays
  // visible even when AUTODRAFT + BILLING_DOCS are both dark.
  ...((isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT") || isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") || isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID"))
    ? [
        {
          label: "Billing",
          items: [
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID")
              ? [
                  {
                    title: "Tenant & Owner Billing",
                    href: "/billing/tenant-owner-billing",
                    icon: Table2,
                    minRole: "editor" as const,
                  },
                ]
              : []),
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
              ? [
                  {
                    title: "Draft Approvals",
                    href: "/billing/draft-approvals",
                    icon: FileCheck,
                    minRole: "editor" as const,
                  },
                ]
              : []),
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
              ? [
                  {
                    title: "Documents",
                    href: "/billing/documents",
                    icon: FileText,
                    minRole: "manager" as const,
                    workspace: "accounting" as const,
                  },
                ]
              : []),
            // Charges/Payments retired from the active nav once the accounting
            // workspace is on — Invoices/Receipts/Documents supersede them for
            // day-to-day work. They remain in the flag-OFF Hidden fallback below
            // (the only billing surface when the accounting workspace is dark)
            // and reachable by URL for the admin-only post/void + FPX-recovery +
            // refund flows the accounting workspace doesn't yet cover.
          ],
        },
      ]
    : []),
  // Accounting section (P3): the accountant's manual invoice-create + Transfer
  // -from-Invoice recording surfaces. workspace:"accounting" admits admin/manager
  // + the accountant; minRole:"manager" gives non-accountant admin/manager the
  // rank fallback too.
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
    ? [
        {
          label: "Accounting",
          items: [
            { title: "Invoices", href: "/accounting/invoices", icon: FileText, minRole: "manager" as const, workspace: "accounting" as const },
            { title: "Receipts", href: "/accounting/receipts", icon: ReceiptText, minRole: "manager" as const, workspace: "accounting" as const },
          ],
        },
      ]
    : []),
  {
    label: "Commissions",
    items: [
      { title: "Claims",      href: "/commissions/claims",      icon: ClipboardList },
      { title: "Performance", href: "/commissions/performance", icon: TrendingUp },
    ],
  },
  {
    label: "Audit",
    items: [
      { title: "Audit", href: "/audit", icon: ShieldCheck, minRole: "manager" },
    ],
  },
  {
    // Settings — single canonical entry. Inside /settings, a left-rail nav
    // covers Commission & TA, Inventory, Sales & Renovation, Document Templates.
    label: "Settings",
    items: [
      { title: "Settings", href: "/settings", icon: SlidersHorizontal, workspace: "neutral" },
    ],
  },
  // Operations section relocated above Tenancy (Tasks + Unit Analytics).
  {
    // Parked sections — surfaces that exist in the codebase but are not part
    // of the active product flow yet. Kept here (instead of removed) so we
    // don't forget about them. Click "Hidden" in the sidebar to expand.
    // S&R Settings moved out — it's now reachable via /settings/sales-renovation.
    label: "Hidden",
    collapsible: true,
    items: [
      { title: "Landlord Tenancies", href: "/tenancy/landlord-tenancies",    icon: Landmark },
      { title: "Tenancies",          href: "/tenancy/tenancies",             icon: ShieldCheck },
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
        ? []
        : [
            { title: "Charges",  href: "/billing/charges",  icon: ReceiptText },
            { title: "Payments", href: "/billing/payments", icon: CreditCard },
          ]),
      { title: "Pipeline",           href: "/sales/pipeline",                icon: Workflow },
      { title: "Renovation Claims",  href: "/renovation/claims",             icon: Hammer },
      { title: "Sales Claims",       href: "/sales/claims",                  icon: ClipboardList },
      { title: "Notifications",      href: "/communications/notifications",  icon: BellDot },
    ],
  },
];

// Flat list for mobile nav
export const allNavItems: NavItem[] = navSections.flatMap((s) => s.items);
