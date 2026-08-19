/**
 * AgentsAreaTabs — sub-tab navigation for the Agents area.
 *
 * Per spec §7.1, the new admin Card surfaces are nested as sub-routes under
 * the existing Agents tab to keep the Organization sidebar at 4 top-level
 * tabs. This component renders the same 3-tab strip on:
 *   - /organization/agents              (Agents list)
 *   - /organization/agents/card-settings
 *   - /organization/agents/card-approvals
 *
 * Symmetric placement on all three pages so navigation feels consistent.
 */
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export type AgentsAreaTab = "agents" | "card-settings" | "card-approvals";

const TABS: { id: AgentsAreaTab; label: string; to: string }[] = [
  { id: "agents", label: "Agents", to: "/organization/agents" },
  { id: "card-settings", label: "Card Settings", to: "/organization/agents/card-settings" },
  { id: "card-approvals", label: "Card Approvals", to: "/organization/agents/card-approvals" },
];

export function AgentsAreaTabs({ activeTab }: { activeTab: AgentsAreaTab }) {
  return (
    <div className="border-b border-border/50">
      <nav className="flex gap-1" aria-label="Agents area">
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
