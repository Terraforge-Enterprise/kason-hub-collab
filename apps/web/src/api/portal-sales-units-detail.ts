/**
 * Portal sales-unit detail client.
 *
 * Calls `GET /portal-api/sales/units/:id/detail` — the rich shape the
 * pipeline page's Unit Detail drawer consumes (joins project, owner,
 * renovation progress + stages).
 *
 * Kept separate from `portal-sales.ts` so existing `getPortalSalesUnit`
 * consumers keep their narrow flat shape.
 */
import { portalApiFetch } from "@/lib/portal-api";

export type PortalSalesUnitDetailStage = {
  stageProgressId: string;
  stageKey: string;
  stageLabel: string;
  sortOrder: number;
  status: "pending" | "in_progress" | "completed";
};

export type PortalSalesUnitDetail = {
  id: string;
  unitNumber: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  bedrooms: number;
  bathrooms: number;
  sourcingApproved: boolean;
  project: { id: string; name: string };
  ownerParty: { id: string; displayName: string };
  renovationProgress: null | {
    id: string;
    status: "not_started" | "on_going" | "completed";
    startDate: string | null;
    expectedCompletion: string | null;
    actualCompletion: string | null;
    stages: PortalSalesUnitDetailStage[];
  };
};

export function getPortalSalesUnitDetail(
  id: string,
): Promise<PortalSalesUnitDetail> {
  return portalApiFetch<{ data: PortalSalesUnitDetail }>(
    `/sales/units/${id}/detail`,
  ).then((r) => r.data);
}
