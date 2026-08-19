import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { OwnerTable } from "./owners-table";
import { CreateOwnerDialog } from "./owners-action-dialogs";
import { PartiesAreaTabs } from "./parties-area-tabs";
import type { OwnerListItem } from "./owners-table";

export default function OwnersPage() {
  const owners = useQuery({
    queryKey: ["owners"],
    queryFn: () => apiFetch<{ data: OwnerListItem[] }>("/parties/owners"),
  });

  if (owners.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <PartiesAreaTabs activeTab="owners" />
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (owners.isError) {
    return (
      <div className="space-y-6">
        <PartiesAreaTabs activeTab="owners" />
        <p className="p-6 text-sm text-rose-600">
          Failed to load owners. Please refresh.
        </p>
      </div>
    );
  }

  const ownerList = owners.data!.data;
  const blacklistedCount = ownerList.filter((o) => o.isBlacklisted).length;

  return (
    <div className="space-y-6">
      <PartiesAreaTabs activeTab="owners" />
      <PageHeader
        title="Owner registry"
        description="Owner records are the control surface for identity, bank details, and blacklist governance."
        metrics={[
          { label: "Owners", value: String(ownerList.length), hint: "Total owner profiles" },
          {
            label: "Active",
            value: String(ownerList.filter((o) => o.status === "active").length),
            hint: "Profiles currently usable",
          },
          { label: "Blacklisted", value: String(blacklistedCount), hint: "Restricted owners" },
          {
            label: "Reachable",
            value: String(ownerList.filter((o) => o.primaryEmail || o.primaryPhone).length),
            hint: "Has email or phone",
          },
        ]}
      />
      <Surface
        title="Owner records"
        description="Role-backed party records with status and screening visibility."
        actions={
          <CreateOwnerDialog
            trigger={
              <Button variant="gold">
                <Plus className="size-4" /> New Owner
              </Button>
            }
          />
        }
      >
        <OwnerTable owners={ownerList} />
      </Surface>
    </div>
  );
}
