// Admin client for the unified source queue. Returns the full pending set
// in one payload — sales-side and rental-side — so the new admin page
// can render them together.
//
// After the three-table refactor (2026-05-19), `units` are UnitSubmission
// rows (not the old Unit.sourcingApproved=false slice). `properties` are
// PropertySubmission rows (not Property.sourcingApproved=false). The
// SalesUnit slice still uses the legacy SalesUnit table.

import { apiFetch } from "@/lib/api-client";

// Sales-side row shape, keyed off the existing SalesUnitRow contract.
// We pick only the fields the unified queue needs to render (the detail
// page does the heavy lifting on click-through).
export type SourceQueueSalesUnit = {
  id: string;
  unitNumber: string;
  projectId: string;
  agentPartyId: string;
  inChargePartyId: string | null;
  purpose: string;
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  purchasePrice: number;
  expectedRental: number | null;
  amendmentNotes: string | null;
  sourcingApproved: boolean;
  sourcingApprovedById: string | null;
  sourcingApprovedAt: Date | string | null;
  createdAt: Date | string;
};

// Rental-side row — now a UnitSubmission. The wire shape is the
// `UNIT_SUBMISSION_SELECT` projection from
// `apps/api/src/modules/submissions/submission.repository.ts`.
export type SourceQueueRentalUnit = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  propertySubmissionId: string | null;
  unitCode: string;
  listingType: string;
  listingMode: "WHOLE" | "PARTITIONED";
  parentListingId: string | null;
  sourcingAgentId: string | null;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  submittedPayload: Record<string, unknown> | null;
  approvedAt: string | null;
  approvedById: string | null;
  approvedListingId: string | null;
  createdAt: string;
  updatedAt: string;
};

// Property-side row — a PropertySubmission. The unified queue surfaces
// the slim columns admins need for listing in the queue UI.
export type SourceQueuePropertySubmission = {
  id: string;
  propertyCode: string;
  proposedName: string;
  propertyType: string;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  sourcingAgentId: string;
  createdAt: string;
  updatedAt: string;
};

export type SourceQueueResponse = {
  salesUnits: SourceQueueSalesUnit[];
  units: SourceQueueRentalUnit[];
  properties: SourceQueuePropertySubmission[];
};

export async function getSourceQueue(): Promise<SourceQueueResponse> {
  const res = await apiFetch<{ data: SourceQueueResponse }>("/source-queue");
  return res.data;
}
