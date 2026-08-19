import {
  LayoutDashboard,
  FileSignature,
  FileText,
  Wallet,
  FolderOpen,
  ClipboardList,
  Users,
  Building2,
  Hammer,
  Workflow,
  IdCard,
  Upload,
  Home,
  TrendingUp,
  Receipt,
  FileBarChart2,
  ArrowLeftRight,
} from "lucide-react";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";

type PortalNavItem = {
  title: string;
  href: string;
  icon: typeof LayoutDashboard;
};

type PortalNavSection = {
  label: string;
  items: PortalNavItem[];
};

const tenantSections: PortalNavSection[] = [
  {
    label: "",
    items: [
      // Phase-2 IA redesign (Task 2) — Home/My Tenancy/Billing/Documents replaces
      // the old Dashboard/Lease/Charges/Statement/Payments/Documents 6-item nav.
      // Old routes (/portal/lease, /portal/charges, /portal/statement,
      // /portal/payments) still resolve — router.tsx redirects them into the new
      // pages so no bookmark breaks.
      { title: "Home", href: "/portal/dashboard", icon: Home },
      { title: "My Tenancy", href: "/portal/my-tenancy", icon: FileText },
      { title: "Billing", href: "/portal/billing", icon: Wallet },
      { title: "Documents", href: "/portal/documents", icon: FolderOpen },
    ],
  },
];

const agentSections: PortalNavSection[] = [
  {
    label: "Main",
    items: [
      { title: "Home", href: "/portal/dashboard", icon: Home },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { title: "Inventory", href: "/portal/inventory", icon: Building2 },
      { title: "Reservations", href: "/portal/reservations", icon: FileSignature },
      { title: "My Uploads", href: "/portal/my-uploads", icon: Upload },
    ],
  },
  {
    label: "Sales & Renovation",
    items: [
      { title: "Sales Pipeline", href: "/portal/sales-pipeline", icon: Workflow },
      { title: "Sales Claims", href: "/portal/sales-claims", icon: ClipboardList },
      { title: "Renovation Claims", href: "/portal/renovation-claims", icon: Hammer },
    ],
  },
  {
    label: "Commissions",
    items: [
      { title: "Commission Analytics", href: "/portal/commissions/dashboard", icon: TrendingUp },
      { title: "Commission Claims", href: "/portal/commissions/claims", icon: ClipboardList },
    ],
  },
  {
    label: "Team",
    items: [
      { title: "My Team", href: "/portal/team", icon: Users },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "My E-Namecard", href: "/portal/my-card", icon: IdCard },
    ],
  },
];

const _ownerPhase2FinanceItems: PortalNavItem[] = isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
  ? [
      // Phase-2 IA redesign — Statements (payout view, Task 2 will enrich)
      { title: "Statements", href: "/portal/statements", icon: FileBarChart2 },
      // Phase-2 IA redesign — Income & Tax (full record, Task 3 will enrich)
      { title: "Income & Tax", href: "/portal/income-tax", icon: Receipt },
      // Phase-2 IA redesign — Transactions (renamed + demoted ledger)
      { title: "Transactions", href: "/portal/transactions", icon: ArrowLeftRight },
    ]
  : [];

const ownerSections: PortalNavSection[] = [
  {
    label: "",
    items: [
      { title: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
      ..._ownerPhase2FinanceItems,
      { title: "Documents", href: "/portal/owner-docs", icon: FolderOpen },
    ],
  },
];

export function getPortalNavSections(userType: string): PortalNavSection[] {
  if (userType === "agent") return agentSections;
  if (userType === "owner") return ownerSections;
  return tenantSections;
}

export function getPortalNavItems(userType: string): PortalNavItem[] {
  return getPortalNavSections(userType).flatMap((s) => s.items);
}

export const portalNavItems = tenantSections.flatMap((s) => s.items);
