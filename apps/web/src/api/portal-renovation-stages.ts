import { portalApiFetch } from "@/lib/portal-api";

export type PortalRenovationStage = {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
};

// Read-only on portal — admin module owns writes.
// Mounted at /portal-api/renovation/stages (added in this task).
export function listPortalRenovationStages(): Promise<{ data: PortalRenovationStage[] }> {
  return portalApiFetch<{ data: PortalRenovationStage[] }>("/renovation/stages");
}
