// Tabbed shell for the agent's submission lifecycle view. Two tabs:
//   - Rentals: every UnitSubmission the agent owns (extracted to
//     ./my-uploads/rentals-tab.tsx)
//   - Properties: every PropertySubmission the agent owns (added in the
//     follow-up commit — currently a placeholder)
//
// Spec: docs/superpowers/specs/2026-05-21-agent-property-amendment-design.md §4.2

import { useSearchParams, Link } from "react-router-dom";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { RentalsTab, useRentalsTabCount } from "./my-uploads/rentals-tab";
import {
  PropertiesTab,
  usePropertiesTabCount,
} from "./my-uploads/properties-tab";

type TabKey = "rentals" | "properties";

function isTabKey(v: string | null): v is TabKey {
  return v === "rentals" || v === "properties";
}

export default function PortalMyUploadsPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const activeTab: TabKey = isTabKey(tabParam) ? tabParam : "rentals";

  const rentalsCount = useRentalsTabCount();
  const propertiesCount = usePropertiesTabCount();

  const renderCount = (n: number | null) =>
    n == null ? "" : ` (${n})`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Upload className="h-8 w-8 text-primary" />
          My uploads
        </h1>
        <Link to="/portal/inventory/new">
          <Button variant="gold">Add new</Button>
        </Link>
      </div>

      {/* Tabs */}
      <Segmented<TabKey>
        ariaLabel="My uploads sections"
        value={activeTab}
        onChange={(next) => setParams({ tab: next }, { replace: true })}
        options={[
          { value: "rentals", label: `Rentals${renderCount(rentalsCount)}` },
          { value: "properties", label: `Properties${renderCount(propertiesCount)}` },
        ]}
      />

      {/* Active tab body */}
      {activeTab === "rentals" ? <RentalsTab /> : <PropertiesTab />}
    </div>
  );
}
