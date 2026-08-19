/**
 * PartiesAreaTabs — sub-tab navigation for the Tenants & Owners area.
 *
 * Renders the same Tenants | Owners strip on both pages so the sidebar entry
 * "Tenants & Owners" (→ /parties → /parties/tenants) feels like one tabbed
 * surface, mirroring the pattern used by AgentsAreaTabs.
 */
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export type PartiesAreaTab = "tenants" | "owners";

const TABS: { id: PartiesAreaTab; label: string; to: string }[] = [
  { id: "tenants", label: "Tenants", to: "/parties/tenants" },
  { id: "owners", label: "Owners", to: "/parties/owners" },
];

export function PartiesAreaTabs({ activeTab }: { activeTab: PartiesAreaTab }) {
  return (
    <div className="border-b border-border/50">
      <nav className="flex gap-1" aria-label="Tenants & Owners">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                isActive
                  ? "text-primary border-primary"
                  : "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
