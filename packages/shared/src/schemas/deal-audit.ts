import { z } from "zod";

export const dealAuditClaimSliceSchema = z.object({
  claimId: z.string().uuid(),
  claimNumber: z.string(),
  agentPartyId: z.string().uuid(),
  agentName: z.string(),
  claimType: z.enum(["tenant_portion", "listing_portion"]),
  agentTierPercentage: z.string(),
  commissionPercentage: z.string(),
  effectivePercentage: z.string(),
  monthlyRental: z.string(),
  nettPayout: z.string(),
  status: z.string(),
  shortfallApplied: z.string().nullable(),
  outstandingBalance: z.string().nullable(),
});

export const dealAuditRowSchema = z.object({
  propertyId: z.string().uuid(),
  condoName: z.string(),
  unitCode: z.string(),
  roomType: z.string(),
  moveInDate: z.string(),
  tenantName: z.string(),
  salesDate: z.string(),
  tenantSideTotal: z.string(),
  listingSideTotal: z.string(),
  combinedTotal: z.string(),
  companyResidual: z.string(),
  totalShortfall: z.string(),
  claims: z.array(dealAuditClaimSliceSchema),
});

export const dealAuditResponseSchema = z.object({
  data: z.array(dealAuditRowSchema),
  pageInfo: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
  }),
});

export type DealAuditResponse = z.infer<typeof dealAuditResponseSchema>;
export type DealAuditRow = z.infer<typeof dealAuditRowSchema>;
export type DealAuditClaimSlice = z.infer<typeof dealAuditClaimSliceSchema>;
