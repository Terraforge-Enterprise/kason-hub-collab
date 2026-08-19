/**
 * TeamAreaTabs — top-level tab strip for the Team hub.
 *
 * Collapses the former four Organization sidebar links into ONE "Team" entry
 * whose surfaces switch via this strip, mirroring PartiesAreaTabs ("Tenants &
 * Owners") and AgentsAreaTabs. Each tab still routes to its own page hitting its
 * own backend — this is navigation grouping, NOT a data merge:
 *   - Staff     → /organization/staff      (operator Users — /api/users)
 *   - Agents    → /organization/agents      (party-side agents — /api/parties/agents)
 *   - Hierarchy → /organization/hierarchy    (agent reporting tree)
 *
 * Managers + Admin were the SAME operator-User entity split across two pages;
 * they are unified into the single Staff surface (with a role filter). Agents
 * and Hierarchy stay their own domain and keep their existing URLs.
 */
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export type TeamAreaTab = "staff" | "agents" | "hierarchy";

const TABS: { id: TeamAreaTab; label: string; to: string }[] = [
  { id: "staff", label: "Staff", to: "/organization/staff" },
  { id: "agents", label: "Agents", to: "/organization/agents" },
  { id: "hierarchy", label: "Hierarchy", to: "/organization/hierarchy" },
];

export function TeamAreaTabs({ activeTab }: { activeTab: TeamAreaTab }) {
  return (
    <div className="border-b border-border/50">
      <nav className="flex gap-1" aria-label="Team">
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
