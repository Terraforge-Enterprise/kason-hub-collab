import type { z } from "zod";
import type {
  amendmentSchema,
  createSalesUnitSchema,
  listSalesUnitsQuery,
  rejectSchema,
  renovationStatusSchema,
  updateSalesUnitSchema,
} from "./sales.validation";

export type CreateSalesUnitInput = z.infer<typeof createSalesUnitSchema>;
export type UpdateSalesUnitInput = z.infer<typeof updateSalesUnitSchema>;
export type ListSalesUnitsQuery = z.infer<typeof listSalesUnitsQuery>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type AmendmentInput = z.infer<typeof amendmentSchema>;
export type RenovationStatusInput = z.infer<typeof renovationStatusSchema>;

/**
 * Slim SalesUnit row exposed by the API. Numeric Decimal columns are
 * converted to plain numbers at the repository boundary so the JSON layer
 * stays string-free.
 */
export interface SalesUnitRow {
  id: string;
  organizationId: string;
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: Date;
  purpose: "rent" | "own_stay";
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental: number | null;
  purchasePrice: number;
  agentPartyId: string;
  inChargePartyId: string | null;
  sourceFlag: string;
  sourcingApproved: boolean;
  sourcingApprovedById: string | null;
  sourcingApprovedAt: Date | null;
  amendmentNotes: string | null;
  promotedUnitId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenovationProgressRow {
  id: string;
  organizationId: string;
  salesUnitId: string;
  status: "not_started" | "on_going" | "completed";
  startDate: Date | null;
  expectedCompletion: Date | null;
  actualCompletion: Date | null;
  notes: string | null;
  updatedAt: Date;
  updatedById: string | null;
}

export interface RenovationTransitionRow {
  id: string;
  organizationId: string;
  progressId: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedAt: Date;
  note: string | null;
}
