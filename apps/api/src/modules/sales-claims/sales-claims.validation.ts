import { z } from "zod";

export const splitTypeEnum = z.enum(["percent", "fixed"]);
export const commissionTypeEnum = z.enum(["percent_of_purchase", "fixed"]);
export const salesPaymentTypeEnum = z.enum(["full", "partial"]);
// State machine for SalesClaim:
//   submitted ─────► approved
//             ┝────► rejected
//             ┝────► needs_amendment ─► (re-submit) ─► submitted
//             └────► cancelled       (agent withdraw / admin cancel)
//
// `pending_approval` is reserved but no service path writes it today —
// kept here so existing filter pills and any future "queue" workflow
// (e.g. an automated review hold) can flip claims into it without a
// migration. Treat it as a no-op alias of `submitted` in UI.
export const claimStatusEnum = z.enum([
  "submitted",
  "pending_approval",
  "approved",
  "rejected",
  "needs_amendment",
  // Terminal: agent withdrew before review, or admin cancelled.
  "cancelled",
]);

// ─── SalesClaim split validation ─────────────────────────────────────────────

export const claimSplitSchema = z
  .object({
    partyPartyId: z.string().uuid().nullable().optional(),
    partyDisplayName: z.string().min(1).max(120),
    roleLabel: z.string().min(1).max(100),
    splitType: splitTypeEnum,
    splitValue: z.number().nonnegative(),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

// ─── SalesClaim CRUD validation ──────────────────────────────────────────────

export const createClaimSchema = z
  .object({
    salesUnitId: z.string().uuid(),
    commissionType: commissionTypeEnum,
    commissionValue: z.number().nonnegative(),
    paymentType: salesPaymentTypeEnum.default("full"),
    notes: z.string().max(2000).nullable().optional(),
    splits: z.array(claimSplitSchema).min(1),
  })
  .strict();

export const updateClaimSchema = z
  .object({
    commissionType: commissionTypeEnum.optional(),
    commissionValue: z.number().nonnegative().optional(),
    paymentType: salesPaymentTypeEnum.optional(),
    notes: z.string().max(2000).nullable().optional(),
    splits: z.array(claimSplitSchema).min(1).optional(),
  })
  .strict();

export const listClaimsQuery = z
  .object({
    status: claimStatusEnum.optional(),
    salesUnitId: z.string().uuid().optional(),
    submittedById: z.string().uuid().optional(),
    submittedFrom: z.string().datetime().optional(),
    submittedTo: z.string().datetime().optional(),
  })
  .strict();

export const rejectSchema = z
  .object({
    note: z.string().min(1).max(2000),
  })
  .strict();

export const needsAmendmentSchema = rejectSchema;

// approve has no body fields — keep schema for symmetry & future-proofing.
export const approveSchema = z.object({}).strict();
