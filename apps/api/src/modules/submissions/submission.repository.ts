// apps/api/src/modules/submissions/submission.repository.ts
import { getDb, Prisma } from "@kason/db";

export const UNIT_SUBMISSION_SELECT = {
  id: true,
  organizationId: true,
  propertyId: true,
  propertySubmissionId: true,
  unitCode: true,
  listingType: true,
  listingMode: true,
  parentListingId: true,
  sourcingAgentId: true,
  submissionState: true,
  amendmentNote: true,
  submittedPayload: true,
  approvedAt: true,
  approvedById: true,
  approvedListingId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Source-queue list projection — same scalars plus the Property name/code
// (and the PropertySubmission fallback when the parent property hasn't been
// approved yet) so the admin card can label each row with its building.
export const UNIT_SUBMISSION_LIST_SELECT = {
  ...UNIT_SUBMISSION_SELECT,
  property: { select: { id: true, name: true, propertyCode: true } },
  propertySubmission: {
    select: { id: true, proposedName: true, propertyCode: true },
  },
} as const;

export type CreateUnitSubmissionInput = {
  organizationId: string;
  propertyId: string | null;
  propertySubmissionId?: string | null;
  unitCode: string;
  listingType: string;
  listingMode: "WHOLE" | "PARTITIONED";
  parentListingId: string | null;
  sourcingAgentId: string;
  submittedPayload: Prisma.InputJsonValue;
};

export async function createUnitSubmission(input: CreateUnitSubmissionInput) {
  return getDb().unitSubmission.create({
    data: { ...input, submissionState: "pending" },
    select: UNIT_SUBMISSION_SELECT,
  });
}

export async function findUnitSubmissionById(orgId: string, submissionId: string) {
  return getDb().unitSubmission.findFirst({
    where: { id: submissionId, organizationId: orgId },
    select: UNIT_SUBMISSION_SELECT,
  });
}

export async function listPendingUnitSubmissions(orgId: string) {
  return getDb().unitSubmission.findMany({
    where: { organizationId: orgId, submissionState: { in: ["pending", "needs_amendment"] } },
    orderBy: { createdAt: "desc" },
    select: UNIT_SUBMISSION_LIST_SELECT,
  });
}

export async function listSubmissionsByAgent(orgId: string, agentPartyId: string) {
  return getDb().unitSubmission.findMany({
    where: { organizationId: orgId, sourcingAgentId: agentPartyId },
    orderBy: { createdAt: "desc" },
    select: UNIT_SUBMISSION_LIST_SELECT,
  });
}

export type UpdateSubmissionPatch = {
  submissionState?: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote?: string | null;
  approvedAt?: Date | null;
  approvedById?: string | null;
  approvedListingId?: string | null;
  submittedPayload?: Prisma.InputJsonValue;
  // Column-level updates threaded through resubmit when the agent amends a
  // structural attribute (room type). listingMode is derived from the new
  // unitType via deriveListingMode and stored alongside so downstream
  // approval reads the post-amend value.
  listingType?: string;
  listingMode?: "WHOLE" | "PARTITIONED";
};

export async function updateSubmissionTx(
  tx: Prisma.TransactionClient,
  submissionId: string,
  patch: UpdateSubmissionPatch,
) {
  return tx.unitSubmission.update({
    where: { id: submissionId },
    data: patch,
    select: UNIT_SUBMISSION_SELECT,
  });
}
