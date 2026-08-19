import { Link, Outlet, useLocation, Navigate } from "react-router-dom";
import {
  Calculator,
  Building2,
  Paintbrush,
  LayoutTemplate,
  Receipt,
  FileText,
  Zap,
  Hash,
  Flag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { canSeeNavItem, type NavItem, type MinRole } from "@/components/navigation";

const SECTIONS: NavItem[] = [
  { title: "Commission & TA",    href: "/settings/commission",         icon: Calculator,     minRole: "manager" },
  { title: "Inventory",          href: "/settings/inventory",          icon: Building2,      minRole: "manager" },
  { title: "Sales & Renovation", href: "/settings/sales-renovation",   icon: Paintbrush,     minRole: "admin" },
  { title: "Document Templates", href: "/settings/document-templates", icon: LayoutTemplate, minRole: "admin" },
  // Phase-2 Owner Billing (M6) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
    ? [{ title: "Owner Billing", href: "/settings/owner-billing", icon: Receipt, minRole: "admin" as const }]
    : []),
  // Phase-2 Auto-Draft Invoices (M5) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  //
  // minRole "manager" (was "admin"): this page now also hosts the Charge Categories
  // panel, which managers maintain (API: requireRole("manager") on category
  // create/patch/deactivate). The auto-draft config above it stays admin-editable —
  // BillingConfigSection's own `canWrite` is still `role === "admin"`, so a manager
  // sees the schedule read-only with no Save / Run now.
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
    ? [{ title: "Billing Config", href: "/settings/billing-config", icon: FileText, minRole: "manager" as const }]
    : []),
  // Phase-2 Meter & Utilities (M2) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_METER")
    ? [{ title: "Utilities", href: "/settings/utilities", icon: Zap, minRole: "admin" as const }]
    : []),
  // Accounting-docs P1 — BillingDocument numbering config; section only exists
  // when the flag is on (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
    ? [{ title: "Document Series", href: "/settings/document-series", icon: Hash, minRole: "admin" as const }]
    : []),
  // NOTE (2026-08-03): the "Charge Categories" entry that used to sit here was removed.
  // That table is now a panel inside Billing Config above. The /settings/charge-categories
  // route still resolves (charge-categories-section.tsx redirects) so old bookmarks work —
  // it just has no nav item of its own.
  // Feature Flags (2026-08-06) — deliberately NOT flag-gated: the flag diagnostic must
  // stay reachable precisely when flags are misconfigured.
  { title: "Feature Flags", href: "/settings/feature-flags", icon: Flag, minRole: "manager" },
];

function isSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const role = user?.role;
  const allowed = SECTIONS.filter((s) => canSeeNavItem(role, s));

  if (allowed.length === 0) {
    return <Navigate to="/dashboard" replace />;
  }

  if (pathname === "/settings" || pathname === "/settings/") {
    return <Navigate to={allowed[0].href} replace />;
  }

  return (
    <div className="flex flex-col md:flex-row gap-6 md:gap-8 min-h-[calc(100vh-8rem)]">
      <aside className="md:w-64 md:shrink-0 md:border-r md:border-border/50 md:pr-6">
        <p className="hidden md:block mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Settings
        </p>
        <nav
          aria-label="Settings sections"
          className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mb-px md:mb-0 border-b md:border-b-0 border-border/50"
        >
          {allowed.map((section) => {
            const active = isSectionActive(pathname, section.href);
            return (
              <Link
                key={section.href}
                to={section.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all whitespace-nowrap",
                  active
                    ? "bg-white/[0.08] text-[#D4AF37]"
                    : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                {active && (
                  <span className="hidden md:block absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#D4AF37]" />
                )}
                <section.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                <span className="truncate">{section.title}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}

export { SECTIONS as SETTINGS_SECTIONS };
export type { MinRole };
